import path from "node:path";
import type { ProgressCallback } from "./types.js";

/** An exported function with a return type inferred by the TypeScript type checker */
export interface InferredReturnType {
  /** Source file (relative path) */
  file: string;
  /** Function name */
  functionName: string;
  /** Inferred return type as a readable string */
  returnType: string;
}

/** A function-level dependency edge (more granular than file-level import graph) */
export interface FunctionCallEdge {
  /** Fully qualified caller: "file:functionName" */
  caller: string;
  /** Fully qualified callee: "file:functionName" */
  callee: string;
  /** Source file where the call occurs */
  file: string;
}

/** Results from deep TypeScript analysis */
export interface DeepAnalysisResult {
  /** Functions with inferred return types (key: "file:functionName") */
  inferredTypes: Map<string, string>;
  /** Function-level call graph edges */
  callGraph: FunctionCallEdge[];
}

/** Minimum supported TypeScript version for deep analysis */
const MIN_TS_VERSION = "4.0.0";

/**
 * Compare two semver version strings (major.minor.patch).
 * Returns true if `version` >= `minVersion`.
 */
function isVersionAtLeast(version: string, minVersion: string): boolean {
  const parse = (v: string) => v.split(".").map((n) => parseInt(n, 10) || 0);
  const [aMajor, aMinor = 0, aPatch = 0] = parse(version);
  const [bMajor, bMinor = 0, bPatch = 0] = parse(minVersion);
  if (aMajor !== bMajor) return aMajor > bMajor;
  if (aMinor !== bMinor) return aMinor > bMinor;
  return aPatch >= bPatch;
}

/**
 * Try to dynamically load TypeScript from the project's node_modules.
 * Returns null if TypeScript is not available or the version is too old.
 */
async function loadProjectTypeScript(
  rootDir: string,
): Promise<typeof import("typescript") | null> {
  try {
    const tsPath = path.join(rootDir, "node_modules", "typescript");
    const ts = await import(tsPath);
    // Handle both default and named exports
    const tsModule = ts.default ?? ts;

    if (!tsModule.version) {
      return null;
    }

    if (!isVersionAtLeast(tsModule.version, MIN_TS_VERSION)) {
      return null;
    }

    return tsModule;
  } catch {
    return null;
  }
}

/**
 * Run deep TypeScript analysis using the project's TypeScript compiler.
 *
 * Loads `typescript` from the project's `node_modules`, creates a program
 * from the project's tsconfig.json, and uses the type checker to:
 * 1. Infer return types for exported functions without explicit annotations
 * 2. Build a function-level call graph for exported functions
 *
 * Returns null if TypeScript is not available or cannot be loaded.
 * Never throws; all errors are caught and logged via onProgress.
 */
export async function runDeepAnalysis(
  rootDir: string,
  sourceFiles: string[],
  onProgress?: ProgressCallback,
): Promise<DeepAnalysisResult | null> {
  onProgress?.("Loading TypeScript from project...");

  const ts = await loadProjectTypeScript(rootDir);
  if (!ts) {
    onProgress?.("TypeScript not found in project node_modules, skipping deep analysis");
    return null;
  }

  onProgress?.(`Using TypeScript ${ts.version}`);

  // Find and parse tsconfig.json
  let program: ReturnType<typeof ts.createProgram>;
  try {
    program = createProgramFromProject(ts, rootDir, sourceFiles);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Failed to create TypeScript program: ${msg}`);
    return null;
  }

  const checker = program.getTypeChecker();
  const inferredTypes = new Map<string, string>();
  const callGraph: FunctionCallEdge[] = [];

  // Build a map of exported function declarations across all files
  // so we can resolve cross-file calls in the call graph
  const exportedFunctions = new Map<string, Set<string>>();

  const programFiles = program.getSourceFiles();
  const projectFiles = programFiles.filter(
    (sf) => !sf.isDeclarationFile && !sf.fileName.includes("node_modules"),
  );

  onProgress?.(`Analyzing ${projectFiles.length} source files with type checker...`);

  // First pass: collect all exported function names per file
  for (const sourceFile of projectFiles) {
    const relPath = path.relative(rootDir, sourceFile.fileName);
    const fns = new Set<string>();

    try {
      collectExportedFunctions(ts, checker, sourceFile, fns);
    } catch {
      // Skip files that fail
    }

    if (fns.size > 0) {
      exportedFunctions.set(relPath, fns);
    }
  }

  // Build a reverse lookup: functionName -> set of files that export it
  const fnNameToFiles = new Map<string, string[]>();
  for (const [filePath, fns] of exportedFunctions) {
    for (const fn of fns) {
      const files = fnNameToFiles.get(fn) ?? [];
      files.push(filePath);
      fnNameToFiles.set(fn, files);
    }
  }

  // Second pass: infer return types and build call graph
  for (const sourceFile of projectFiles) {
    const relPath = path.relative(rootDir, sourceFile.fileName);

    try {
      analyzeSourceFile(
        ts,
        checker,
        sourceFile,
        relPath,
        rootDir,
        exportedFunctions,
        fnNameToFiles,
        inferredTypes,
        callGraph,
      );
    } catch {
      // Skip files that cause errors; continue with the rest
      onProgress?.(`Skipped ${relPath} (type checker error)`);
    }
  }

  onProgress?.(
    `Deep analysis complete: ${inferredTypes.size} inferred types, ${callGraph.length} call edges`,
  );

  return { inferredTypes, callGraph };
}

/**
 * Create a TypeScript program from the project's tsconfig.json.
 * Falls back to a minimal config if tsconfig.json is not found.
 */
function createProgramFromProject(
  ts: typeof import("typescript"),
  rootDir: string,
  sourceFiles: string[],
): ReturnType<typeof ts.createProgram> {
  const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, "tsconfig.json");

  if (configPath) {
    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    if (configFile.error) {
      throw new Error(`Failed to read tsconfig.json: ${ts.flattenDiagnosticMessageText(configFile.error.messageText, "\n")}`);
    }

    const parsedConfig = ts.parseJsonConfigFileContent(
      configFile.config,
      ts.sys,
      rootDir,
    );

    return ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
  }

  // Fallback: minimal config with provided source files
  const absFiles = sourceFiles.map((f) => path.resolve(rootDir, f));
  return ts.createProgram(absFiles, {
    target: ts.ScriptTarget.ES2022,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    skipLibCheck: true,
    noEmit: true,
  });
}

/**
 * Collect names of exported functions (and arrow function exports) from a source file.
 */
function collectExportedFunctions(
  ts: typeof import("typescript"),
  checker: ReturnType<typeof import("typescript").createProgram>["getTypeChecker"] extends () => infer R ? R : never,
  sourceFile: ReturnType<typeof import("typescript").createSourceFile>,
  result: Set<string>,
): void {
  function visit(node: { kind: number; [key: string]: unknown }): void {
    const tsNode = node as unknown as import("typescript").Node;

    // export function foo() { ... }
    if (ts.isFunctionDeclaration(tsNode)) {
      const funcDecl = tsNode as import("typescript").FunctionDeclaration;
      if (hasExportModifier(ts, funcDecl) && funcDecl.name) {
        result.add(funcDecl.name.text);
      }
    }

    // export const foo = () => { ... }  or  export const foo = function() { ... }
    if (ts.isVariableStatement(tsNode) && hasExportModifier(ts, tsNode)) {
      const varStmt = tsNode as import("typescript").VariableStatement;
      for (const decl of varStmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          if (
            ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer)
          ) {
            result.add(decl.name.text);
          }
        }
      }
    }

    ts.forEachChild(tsNode, visit as unknown as (node: import("typescript").Node) => void);
  }

  ts.forEachChild(
    sourceFile as unknown as import("typescript").Node,
    visit as unknown as (node: import("typescript").Node) => void,
  );
}

/**
 * Analyze a single source file: infer return types and build call graph edges.
 */
function analyzeSourceFile(
  ts: typeof import("typescript"),
  checker: ReturnType<typeof import("typescript").createProgram>["getTypeChecker"] extends () => infer R ? R : never,
  sourceFile: ReturnType<typeof import("typescript").createSourceFile>,
  relPath: string,
  rootDir: string,
  exportedFunctions: Map<string, Set<string>>,
  fnNameToFiles: Map<string, string[]>,
  inferredTypes: Map<string, string>,
  callGraph: FunctionCallEdge[],
): void {
  function visit(node: import("typescript").Node): void {
    // Exported function declarations
    if (ts.isFunctionDeclaration(node)) {
      const funcDecl = node as import("typescript").FunctionDeclaration;
      if (hasExportModifier(ts, funcDecl) && funcDecl.name) {
        const fnName = funcDecl.name.text;
        const key = `${relPath}:${fnName}`;

        // Infer return type if not explicitly annotated
        if (!funcDecl.type) {
          try {
            const signature = checker.getSignatureFromDeclaration(funcDecl);
            if (signature) {
              const returnType = checker.getReturnTypeOfSignature(signature);
              const typeStr = checker.typeToString(
                returnType,
                undefined,
                ts.TypeFormatFlags.NoTruncation,
              );
              // Only store non-trivial inferred types
              if (typeStr && typeStr !== "void" && typeStr !== "any") {
                inferredTypes.set(key, typeStr);
              }
            }
          } catch {
            // Silently skip if type inference fails for this function
          }
        }

        // Build call graph: find calls to other exported functions within this function body
        if (funcDecl.body) {
          collectCallEdges(
            ts,
            funcDecl.body,
            key,
            relPath,
            rootDir,
            exportedFunctions,
            fnNameToFiles,
            callGraph,
          );
        }
      }
    }

    // Exported arrow/function-expression variables
    if (ts.isVariableStatement(node) && hasExportModifier(ts, node)) {
      const varStmt = node as import("typescript").VariableStatement;
      for (const decl of varStmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer) {
          const isFunc =
            ts.isArrowFunction(decl.initializer) ||
            ts.isFunctionExpression(decl.initializer);
          if (!isFunc) continue;

          const fnName = decl.name.text;
          const key = `${relPath}:${fnName}`;
          const funcNode = decl.initializer as
            | import("typescript").ArrowFunction
            | import("typescript").FunctionExpression;

          // Infer return type if not explicitly annotated
          if (!funcNode.type) {
            try {
              const signature = checker.getSignatureFromDeclaration(funcNode);
              if (signature) {
                const returnType = checker.getReturnTypeOfSignature(signature);
                const typeStr = checker.typeToString(
                  returnType,
                  undefined,
                  ts.TypeFormatFlags.NoTruncation,
                );
                if (typeStr && typeStr !== "void" && typeStr !== "any") {
                  inferredTypes.set(key, typeStr);
                }
              }
            } catch {
              // Skip
            }
          }

          // Build call graph from function body
          const body = funcNode.body;
          if (body) {
            collectCallEdges(
              ts,
              body,
              key,
              relPath,
              rootDir,
              exportedFunctions,
              fnNameToFiles,
              callGraph,
            );
          }
        }
      }
    }

    ts.forEachChild(node, visit);
  }

  ts.forEachChild(sourceFile as unknown as import("typescript").Node, visit);
}

/**
 * Walk a function body to find calls to other exported functions.
 */
function collectCallEdges(
  ts: typeof import("typescript"),
  body: import("typescript").Node,
  callerKey: string,
  callerFile: string,
  rootDir: string,
  exportedFunctions: Map<string, Set<string>>,
  fnNameToFiles: Map<string, string[]>,
  callGraph: FunctionCallEdge[],
): void {
  const seenCallees = new Set<string>();

  function walkBody(node: import("typescript").Node): void {
    if (ts.isCallExpression(node)) {
      const expr = node.expression;

      // Direct call: foo()
      if (ts.isIdentifier(expr)) {
        const calleeName = expr.text;
        resolveAndAddCallEdge(
          calleeName,
          callerKey,
          callerFile,
          exportedFunctions,
          fnNameToFiles,
          callGraph,
          seenCallees,
        );
      }

      // Property access call: module.foo() -- only if "module" looks like an import
      if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.name)) {
        const calleeName = expr.name.text;
        resolveAndAddCallEdge(
          calleeName,
          callerKey,
          callerFile,
          exportedFunctions,
          fnNameToFiles,
          callGraph,
          seenCallees,
        );
      }
    }

    ts.forEachChild(node, walkBody);
  }

  walkBody(body);
}

/**
 * Resolve a callee name to its source file and add a call graph edge.
 */
function resolveAndAddCallEdge(
  calleeName: string,
  callerKey: string,
  callerFile: string,
  exportedFunctions: Map<string, Set<string>>,
  fnNameToFiles: Map<string, string[]>,
  callGraph: FunctionCallEdge[],
  seenCallees: Set<string>,
): void {
  const callerFnName = callerKey.split(":")[1];
  // Don't add self-recursive edges
  if (calleeName === callerFnName) return;

  const candidateFiles = fnNameToFiles.get(calleeName);
  if (!candidateFiles) return;

  // Prefer same-file match, otherwise use first candidate
  let targetFile = candidateFiles.includes(callerFile)
    ? callerFile
    : candidateFiles[0];

  // Verify the function is actually exported in the target file
  const targetFns = exportedFunctions.get(targetFile);
  if (!targetFns?.has(calleeName)) return;

  const calleeKey = `${targetFile}:${calleeName}`;
  if (seenCallees.has(calleeKey)) return;
  seenCallees.add(calleeKey);

  callGraph.push({
    caller: callerKey,
    callee: calleeKey,
    file: callerFile,
  });
}

/**
 * Check whether a node has the `export` keyword modifier.
 */
function hasExportModifier(
  ts: typeof import("typescript"),
  node: import("typescript").Node,
): boolean {
  // TypeScript 4.x and 5.x both support getModifiers() or modifiers property
  const modifiers = ts.canHaveModifiers?.(node)
    ? ts.getModifiers?.(node)
    : (node as { modifiers?: readonly import("typescript").Modifier[] }).modifiers;
  if (!modifiers) return false;
  return modifiers.some(
    (m: import("typescript").Modifier) => m.kind === ts.SyntaxKind.ExportKeyword,
  );
}

/**
 * Render the function call graph as a markdown section.
 */
export function renderCallGraphSection(callGraph: FunctionCallEdge[]): string {
  if (callGraph.length === 0) return "";

  // Group by caller
  const grouped = new Map<string, Set<string>>();
  for (const edge of callGraph) {
    const callees = grouped.get(edge.caller) ?? new Set();
    // Extract just the function name from "file:functionName"
    const calleeFn = edge.callee.split(":").pop() ?? edge.callee;
    callees.add(calleeFn);
    grouped.set(edge.caller, callees);
  }

  const lines: string[] = [];
  lines.push("## Function Call Graph");
  lines.push("");
  lines.push("> Exported function dependencies (from `--deep` analysis).");
  lines.push("");

  // Sort by number of callees descending (most connected first)
  const entries = [...grouped.entries()].sort((a, b) => b[1].size - a[1].size);

  for (const [callerKey, callees] of entries.slice(0, 30)) {
    const [file, fnName] = splitKey(callerKey);
    const calleeList = [...callees].sort().map((c) => `\`${c}()\``).join(", ");
    lines.push(`- \`${fnName}()\` in \`${file}\` calls: ${calleeList}`);
  }

  if (entries.length > 30) {
    lines.push(`- ... and ${entries.length - 30} more callers`);
  }

  return lines.join("\n");
}

/**
 * Split a "file:functionName" key into its components.
 */
function splitKey(key: string): [string, string] {
  const colonIdx = key.lastIndexOf(":");
  if (colonIdx === -1) return [key, key];
  return [key.slice(0, colonIdx), key.slice(colonIdx + 1)];
}

// Re-export for testing
export { isVersionAtLeast, loadProjectTypeScript };
