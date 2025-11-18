import path from "node:path";
import { glob } from "tinyglobby";
import { estimateTokens, readFileOr, readJsonFile } from "./utils.js";
import { findUsedExports, stripCommentsAndStrings } from "./graph.js";
import type { CodeSnapshot, DetectedContext, GitAnalysis, ImportGraph, Language, ProgressCallback, SnapshotEntry } from "./types.js";

/**
 * Auto-detect which directories to scan for code snapshots.
 */
function getDefaultScanPaths(ctx: DetectedContext): string[] {
  switch (ctx.language) {
    case "python":
      return getDefaultPythonScanPaths(ctx);
    case "go":
      return getDefaultGoScanPaths(ctx);
    case "rust":
      return getDefaultRustScanPaths(ctx);
    case "java":
      return getDefaultJavaScanPaths(ctx);
    default:
      return getDefaultJsTsScanPaths(ctx);
  }
}

function getDefaultJsTsScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  // Types directories
  for (const d of dirs) {
    if (d.endsWith("types") || d.endsWith("typings")) paths.push(d);
  }

  // Store directories
  for (const d of dirs) {
    if (d.endsWith("stores") || d.endsWith("store")) paths.push(d);
  }

  // Service/API directories
  for (const d of dirs) {
    if (d.endsWith("services") || d.endsWith("api")) paths.push(d);
  }

  // Hook directories
  for (const d of dirs) {
    if (d.endsWith("hooks")) paths.push(d);
  }

  // Component directories
  for (const d of dirs) {
    if (d.endsWith("components")) paths.push(d);
  }

  // Lib/utils
  for (const d of dirs) {
    if (d.endsWith("lib") || d.endsWith("utils")) paths.push(d);
  }

  // Fallback: scan common type file patterns at root
  if (paths.length === 0) {
    paths.push("src", "app", "lib");
  }

  return paths;
}

function getDefaultPythonScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["models", "schemas", "types", "services", "api", "core",
       "utils", "db", "routes", "routers", "views"].includes(last)
    ) {
      paths.push(d);
    }
  }

  // Fallback: common Python project roots
  if (paths.length === 0) {
    paths.push("src", "app", "lib", ".");
  }

  return paths;
}

/**
 * Get default scan paths for a specific language (used by multi-language support).
 */
function getDefaultScanPathsForLanguage(lang: Language, ctx: DetectedContext): string[] {
  switch (lang) {
    case "python": return getDefaultPythonScanPaths(ctx);
    case "go": return getDefaultGoScanPaths(ctx);
    case "rust": return getDefaultRustScanPaths(ctx);
    case "java": return getDefaultJavaScanPaths(ctx);
    default: return getDefaultJsTsScanPaths(ctx);
  }
}

/**
 * Get glob, extractor, and ignore patterns for a specific language.
 */
function getLanguageConfig(lang: Language): {
  glob: string;
  extractor: (filePath: string, relPath: string) => Promise<SnapshotEntry[]>;
  ignore: string[];
} {
  switch (lang) {
    case "python":
      return {
        glob: "**/*.py",
        extractor: extractFromPythonFile,
        ignore: ["**/__pycache__/**", "**/venv/**", "**/.venv/**", "**/env/**",
                 "**/migrations/**", "**/test_*.py", "**/tests/**", "**/conftest.py", "**/setup.py"],
      };
    case "go":
      return {
        glob: "**/*.go",
        extractor: extractFromGoFile,
        ignore: ["**/*_test.go", "**/vendor/**", "**/testdata/**"],
      };
    case "rust":
      return {
        glob: "**/*.rs",
        extractor: extractFromRustFile,
        ignore: ["**/target/**", "**/tests/**", "**/*.pb.rs"],
      };
    case "java":
      return {
        glob: "**/*.java",
        extractor: extractFromJavaFile,
        ignore: ["**/target/**", "**/build/**", "**/src/test/**", "**/*Test.java", "**/*Spec.java"],
      };
    default:
      return {
        glob: "**/*.{ts,tsx,js,jsx}",
        extractor: extractFromFile,
        ignore: [],
      };
  }
}

function getDefaultGoScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["models", "handlers", "services", "api", "internal", "pkg",
       "cmd", "server", "domain", "repository"].includes(last)
    ) {
      paths.push(d);
    }
  }

  if (paths.length === 0) {
    paths.push(".", "internal", "pkg", "cmd");
  }

  return paths;
}

function getDefaultRustScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["src", "lib", "api", "models", "handlers", "services", "domain"].includes(last)
    ) {
      paths.push(d);
    }
  }

  if (paths.length === 0) {
    paths.push("src");
  }

  return paths;
}

function getDefaultJavaScanPaths(ctx: DetectedContext): string[] {
  const paths: string[] = [];
  const dirs = ctx.directories;

  for (const d of dirs) {
    const last = d.split("/").pop() ?? d;
    if (
      ["controllers", "services", "repositories", "models",
       "entities", "dto", "domain"].includes(last)
    ) {
      paths.push(d);
    }
  }

  // Also check for standard Maven/Gradle layout
  if (dirs.some((d) => d === "src" || d.startsWith("src/"))) {
    paths.push("src/main/java");
  }

  if (paths.length === 0) {
    paths.push("src/main/java", "src");
  }

  return paths;
}

/**
 * Regex patterns for extracting TypeScript/JavaScript declarations.
 */
const PATTERNS = {
  /** export interface Foo { ... } or export type Foo = ... */
  exportedType: /^export\s+(interface|type|enum)\s+(\w+)/,
  /** interface FooProps { ... } (component props, even if not exported) */
  propsInterface: /^(?:export\s+)?interface\s+(\w+Props)\s*\{/,
  /** export function foo(...) or export const foo = <fn expr> */
  exportedFunction: /^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/,
  /** export default function Foo(...) */
  exportedDefaultFunction: /^export\s+default\s+(?:async\s+)?function\s+(\w+)/,
  /** export default class Foo */
  exportedDefaultClass: /^export\s+default\s+class\s+(\w+)/,
  /** StateCreator<...> pattern (Zustand slices) */
  zustandSlice: /StateCreator<\s*(\w+)/,
  /** export interface FooSlice { ... } */
  sliceInterface: /^export\s+interface\s+(\w+Slice)\s*\{/,
};

/**
 * Extract snapshot entries from a single file.
 */
async function extractFromFile(
  filePath: string,
  relPath: string,
): Promise<SnapshotEntry[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const entries: SnapshotEntry[] = [];
  const lines = content.split("\n");

  // Determine category hints from path
  const isStore = /stores?[/\\]/.test(relPath);
  const isHook = /hooks?[/\\]/.test(relPath) || relPath.includes("use");
  const isComponent = /components?[/\\]/.test(relPath);
  const isService = /services?[/\\]|api[/\\]/.test(relPath);
  const isType = /types?[/\\]/.test(relPath) || relPath.endsWith(".types.ts");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // -- Exported interfaces / types --
    const typeMatch = trimmed.match(PATTERNS.exportedType);
    if (typeMatch) {
      const [, kind, name] = typeMatch;
      const category =
        name.endsWith("Slice")
          ? "store"
          : name.endsWith("Props")
            ? "component"
            : kind === "interface"
              ? "interface"
              : kind === "enum"
                ? "type"
                : "type";

      // Grab the full declaration (until closing brace or semicolon for type aliases)
      const block = extractBlock(lines, i);
      entries.push({ file: relPath, category, signature: block });
      continue;
    }

    // -- Non-exported Props interfaces (common in components) --
    if (isComponent) {
      const propsMatch = trimmed.match(PATTERNS.propsInterface);
      if (propsMatch && !trimmed.startsWith("export")) {
        const block = extractBlock(lines, i);
        entries.push({ file: relPath, category: "component", signature: block });
        continue;
      }
    }

    // -- Default export functions and classes --
    const defaultFuncMatch = trimmed.match(PATTERNS.exportedDefaultFunction);
    if (defaultFuncMatch) {
      const [, name] = defaultFuncMatch;
      let category: SnapshotEntry["category"] = "function";
      if (isHook || name.startsWith("use")) category = "hook";
      else if (isComponent && name[0] === name[0].toUpperCase()) category = "component";
      else if (isStore) category = "store";

      const sig = extractSignatureLine(lines, i);
      entries.push({ file: relPath, category, signature: sig });
      continue;
    }

    const defaultClassMatch = trimmed.match(PATTERNS.exportedDefaultClass);
    if (defaultClassMatch) {
      const block = extractBlock(lines, i);
      entries.push({ file: relPath, category: isComponent ? "component" : "type", signature: block });
      continue;
    }

    // -- Exported functions --
    const funcMatch = trimmed.match(PATTERNS.exportedFunction);
    if (funcMatch) {
      const [, name] = funcMatch;

      // For `export const` lines, only include if the RHS is a function expression.
      // Plain value assignments (= "...", = 42, = { ... }, = [...]) should be excluded.
      if (trimmed.includes(" const ")) {
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx >= 0) {
          const rhs = trimmed.slice(eqIdx + 1).trim();
          const isFnExpr = /^(?:async\s*)?(?:\(|<)/.test(rhs) ||
            /^(?:async\s+)?\w+\s*=>/.test(rhs) ||
            rhs.startsWith("function");
          if (!isFnExpr) continue;
        }
      }

      // Skip React component exports like `export function MyComponent(`
      // unless it's clearly a hook or service
      if (isComponent && name[0] === name[0].toUpperCase() && !name.startsWith("use")) {
        // This is likely a component; we only care about its Props, not its body
        continue;
      }

      let category: SnapshotEntry["category"] = "function";
      if (isHook || name.startsWith("use")) category = "hook";
      else if (isStore) category = "store";

      // Extract just the signature line (not the full body)
      const sig = extractSignatureLine(lines, i);
      entries.push({ file: relPath, category, signature: sig });
    }
  }

  return entries;
}

/**
 * Extract a block from the current line until the closing brace at the same depth.
 * For type aliases (no brace), captures until the next semicolon or blank line.
 */
function extractBlock(lines: string[], startIdx: number): string {
  const firstLine = lines[startIdx];

  // Type alias (no opening brace on first line, usually single-line or multi-line with |)
  if (!firstLine.includes("{")) {
    // Collect until semicolon
    let result = "";
    for (let i = startIdx; i < lines.length && i < startIdx + 10; i++) {
      result += (result ? "\n" : "") + lines[i];
      if (lines[i].includes(";")) break;
    }
    return result.trim();
  }

  // Block with braces: capture until matching depth
  let depth = 0;
  let result = "";
  const maxLines = 30; // Cap to avoid capturing massive blocks

  for (let i = startIdx; i < lines.length && i < startIdx + maxLines; i++) {
    const line = lines[i];
    result += (result ? "\n" : "") + line;

    // Strip comments/strings for accurate brace counting
    const cleaned = stripCommentsAndStrings(line);
    for (const ch of cleaned) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    if (depth <= 0 && i > startIdx) break;
  }

  return result.trim();
}

/**
 * Find the index of the first `{` or `=>` that is NOT inside angle brackets.
 * Returns { type, index } or null if none found at depth 0.
 */
function findSignatureTerminator(sig: string): { type: "brace" | "arrow"; index: number } | null {
  let angleDepth = 0;
  for (let i = 0; i < sig.length; i++) {
    const ch = sig[i];
    if (ch === "<") angleDepth++;
    else if (ch === ">") angleDepth--;
    else if (angleDepth === 0) {
      if (ch === "{") return { type: "brace", index: i };
      if (ch === "=" && i + 1 < sig.length && sig[i + 1] === ">") return { type: "arrow", index: i };
    }
  }
  return null;
}

/**
 * Extract a function signature (everything up to the opening brace or arrow).
 * Tracks angle bracket balance so that `{` or `=>` inside generic parameters
 * (e.g. `T extends { key: V }`) do not prematurely terminate the signature.
 */
function extractSignatureLine(lines: string[], startIdx: number): string {
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trim();

    // Count unbalanced angle brackets to detect open generic parameters
    let angleDepth = 0;
    for (const ch of sig) {
      if (ch === "<") angleDepth++;
      else if (ch === ">") angleDepth--;
    }

    // While inside generic parameters, do not terminate on { or =>
    if (angleDepth > 0) continue;

    // Find the first terminator ({ or =>) that is outside angle brackets
    const terminator = findSignatureTerminator(sig);
    if (terminator) {
      let cutIdx: number;
      if (terminator.type === "arrow") {
        // Arrow function: cut at the opening brace after "=>" to preserve the arrow
        const afterArrow = findSignatureTerminator(sig.slice(terminator.index + 2));
        cutIdx = afterArrow?.type === "brace" ? terminator.index + 2 + afterArrow.index : sig.length;
      } else {
        cutIdx = terminator.index;
      }
      sig = sig.slice(0, cutIdx).trim();
      break;
    }
  }
  return sig;
}

// ── Python extraction ────────────────────────────────────────────────────────

const PY_PATTERNS = {
  /** class Foo: or class Foo(Base): or class Foo(Base, Mixin): */
  classDef: /^class\s+(\w+)(?:\(([^)]*)\))?:/,
  /** Decorators (@dataclass, @app.route, etc.) */
  decorator: /^@(\S+)/,
  /** def foo(...) -> RetType: or async def foo(...): */
  funcDef: /^(async\s+)?def\s+(\w+)\s*\(/,
  /** TypeAlias: Foo = NewType/Union/Optional/Callable/Literal/TypeVar */
  typeAlias: /^(\w+)\s*(?::\s*TypeAlias\s*)?=\s*(?:NewType|Union|Optional|Callable|Literal|TypeVar|Annotated)\b/,
};

/** Bases that indicate a "type" category */
const PY_TYPE_BASES = new Set([
  "BaseModel", "TypedDict", "NamedTuple", "Protocol",
]);

/** Decorator names that indicate a dataclass-like */
const PY_DATACLASS_DECORATORS = new Set([
  "dataclass", "dataclasses.dataclass", "attrs", "attr.s", "define",
]);

/**
 * Extract snapshot entries from a single Python file.
 * Handles top-level definitions and class methods (for non-data classes).
 */
async function extractFromPythonFile(
  filePath: string,
  relPath: string,
): Promise<SnapshotEntry[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const entries: SnapshotEntry[] = [];
  const lines = content.split("\n");

  // Track decorators for the next class/function
  let pendingDecorators: string[] = [];
  // Track whether we're inside a non-data class (for method extraction)
  let insideClass = false;
  let classBodyIndent = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Track when we exit a class body
    if (insideClass && indent === 0 && trimmed && !trimmed.startsWith("#")) {
      insideClass = false;
      classBodyIndent = -1;
    }

    // Skip deeply nested code (beyond class methods)
    if (indent > 0 && !pendingDecorators.length) {
      if (insideClass) {
        // Inside a class: process class-level methods (at classBodyIndent)
        if (indent > classBodyIndent && classBodyIndent > 0) continue;
      } else {
        if (indent > 4) continue;
      }
    }

    // Collect decorators (at any indent level where we process definitions)
    const decoMatch = trimmed.match(PY_PATTERNS.decorator);
    if (decoMatch) {
      pendingDecorators.push(decoMatch[1]);
      continue;
    }

    // -- Class definitions (top-level only) --
    if (indent === 0) {
      const classMatch = trimmed.match(PY_PATTERNS.classDef);
      if (classMatch) {
        const [, name, bases] = classMatch;
        const baseList = bases
          ? bases.split(",").map((b) => b.trim().split("[")[0].split("(")[0])
          : [];

        // Determine category
        let category: SnapshotEntry["category"] = "type";
        const isEnum = baseList.some((b) => b === "Enum" || b === "IntEnum" || b === "StrEnum");
        const isProtocol = baseList.some((b) => b === "Protocol");
        const isDatalike =
          baseList.some((b) => PY_TYPE_BASES.has(b)) ||
          pendingDecorators.some((d) => PY_DATACLASS_DECORATORS.has(d));

        if (isProtocol) {
          category = "interface";
        } else if (isEnum || isDatalike) {
          category = "type";
        }

        if (isDatalike || isEnum || isProtocol) {
          // Data-like classes: extract the full block (fields are the API)
          const block = extractPythonBlock(lines, i, pendingDecorators);
          entries.push({ file: relPath, category, signature: block });
          insideClass = false;
        } else {
          // Non-data classes (views, endpoints, services): extract class header
          // then extract public method signatures individually
          let classHeader = pendingDecorators.map((d) => `@${d}`).join("\n") +
            (pendingDecorators.length ? "\n" : "") + trimmed;
          const classDocComment = extractPythonDocstring(lines, i + 1);
          if (classDocComment) {
            classHeader += classDocComment;
          }
          entries.push({ file: relPath, category: "type", signature: classHeader });
          insideClass = true;
          // Determine body indentation from next non-blank line
          classBodyIndent = -1;
          for (let j = i + 1; j < lines.length && j < i + 10; j++) {
            const bodyLine = lines[j];
            const bodyTrimmed = bodyLine.trimStart();
            if (bodyTrimmed && !bodyTrimmed.startsWith("#")) {
              classBodyIndent = bodyLine.length - bodyTrimmed.length;
              break;
            }
          }
        }
        pendingDecorators = [];
        continue;
      }
    }

    // -- Class methods (inside non-data classes) --
    if (insideClass && classBodyIndent > 0 && indent === classBodyIndent) {
      const funcMatch = trimmed.match(PY_PATTERNS.funcDef);
      if (funcMatch) {
        const [, , name] = funcMatch;

        // Skip private/dunder methods (except __init__)
        if (name.startsWith("_") && name !== "__init__") {
          pendingDecorators = [];
          continue;
        }

        const sig = extractPythonFuncSignature(lines, i, pendingDecorators);
        entries.push({ file: relPath, category: "function", signature: sig });
        pendingDecorators = [];
        continue;
      }
    }

    // -- Function definitions (top-level only) --
    if (indent === 0) {
      const funcMatch = trimmed.match(PY_PATTERNS.funcDef);
      if (funcMatch) {
        const [, , name] = funcMatch;

        // Skip private and test functions
        if (name.startsWith("_") || name.startsWith("test_")) {
          pendingDecorators = [];
          continue;
        }

        const sig = extractPythonFuncSignature(lines, i, pendingDecorators);
        entries.push({ file: relPath, category: "function", signature: sig });
        pendingDecorators = [];
        continue;
      }
    }

    // -- Type aliases (top-level only) --
    if (indent === 0) {
      const aliasMatch = trimmed.match(PY_PATTERNS.typeAlias);
      if (aliasMatch) {
        entries.push({ file: relPath, category: "type", signature: trimmed });
        pendingDecorators = [];
        continue;
      }
    }

    // Reset decorators if we hit a non-decorator, non-blank, non-comment line
    if (trimmed && !trimmed.startsWith("#")) {
      pendingDecorators = [];
    }
  }

  return entries;
}

/**
 * Extract a Python class body using indentation. Includes decorators.
 * Caps at 30 lines (same as TS blocks).
 */
function extractPythonBlock(
  lines: string[],
  startIdx: number,
  decorators: string[],
): string {
  const maxLines = 30;
  const parts: string[] = [];

  // Add decorators
  for (const dec of decorators) {
    parts.push(`@${dec}`);
  }

  // First line (the class def)
  parts.push(lines[startIdx].trimStart());

  // Determine body indentation from next non-blank line
  let bodyIndent = -1;
  for (let i = startIdx + 1; i < lines.length && i < startIdx + maxLines; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith("#")) continue;
    bodyIndent = line.length - trimmed.length;
    break;
  }

  if (bodyIndent <= 0) return parts.join("\n");

  // Collect body lines
  for (let i = startIdx + 1; i < lines.length && parts.length < maxLines; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Blank lines within the block are kept
    if (!trimmed) {
      parts.push("");
      continue;
    }

    // If indentation returns to or below the class level, block is done
    const currentIndent = line.length - trimmed.length;
    if (currentIndent < bodyIndent) break;

    parts.push(line.trimStart());
  }

  // Trim trailing blank lines
  while (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }

  return parts.join("\n");
}

/**
 * Extract a Python docstring comment from lines starting at searchStart.
 * Returns ` # "docstring text"` or null if no docstring found.
 */
function extractPythonDocstring(lines: string[], searchStart: number): string | null {
  for (let i = searchStart; i < lines.length && i < searchStart + 3; i++) {
    const trimmed = lines[i].trimStart();
    if (!trimmed) continue;

    const quoteStyle = trimmed.startsWith('"""') ? '"""' : trimmed.startsWith("'''") ? "'''" : null;
    if (!quoteStyle) return null;

    let docText: string;
    const afterOpen = trimmed.slice(3);
    const closeIdx = afterOpen.indexOf(quoteStyle);
    if (closeIdx >= 0) {
      // Single-line: """text"""
      docText = afterOpen.slice(0, closeIdx).trim();
    } else {
      // Multi-line: take text on opening line, or next non-blank line
      const openingText = afterOpen.trim();
      if (openingText) {
        docText = openingText;
      } else {
        docText = "";
        for (let j = i + 1; j < lines.length && j < i + 5; j++) {
          const dt = lines[j].trimStart();
          if (!dt) continue;
          if (dt.startsWith(quoteStyle)) break;
          docText = dt.replace(new RegExp(`${quoteStyle.replace(/'/g, "\\'")}.*$`), "").trim();
          break;
        }
      }
    }

    if (docText) {
      if (docText.length > 80) {
        docText = docText.slice(0, 77) + "...";
      }
      // Normalize single quotes to double quotes
      docText = docText.replace(/'/g, '"');
      return ` # "${docText}"`;
    }
    return null;
  }
  return null;
}

/**
 * Extract a Python function signature (the `def` line, possibly multi-line).
 * Includes decorators.
 */
function extractPythonFuncSignature(
  lines: string[],
  startIdx: number,
  decorators: string[],
): string {
  const parts: string[] = [];

  // Add decorators
  for (const dec of decorators) {
    parts.push(`@${dec}`);
  }

  // Collect the signature (may span multiple lines if args are wrapped)
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 10; i++) {
    const trimmed = lines[i].trimStart();
    sig += (sig ? " " : "") + trimmed;
    // The signature ends at the colon after closing paren
    if (sig.includes("):") || sig.includes(") ->")) {
      // Find the colon that ends the signature
      const colonIdx = sig.lastIndexOf(":");
      if (colonIdx >= 0) {
        sig = sig.slice(0, colonIdx + 1);
      }
      break;
    }
  }

  parts.push(sig);

  // Look ahead for a docstring after the signature
  let sigEndLine = startIdx;
  for (let i = startIdx; i < lines.length && i < startIdx + 10; i++) {
    const accumulated = lines.slice(startIdx, i + 1).map(l => l.trimStart()).join(" ");
    if (accumulated.includes("):") || accumulated.includes(") ->")) {
      sigEndLine = i + 1;
      break;
    }
  }

  const docComment = extractPythonDocstring(lines, sigEndLine);
  if (docComment) {
    // Append to the last line of the signature
    parts[parts.length - 1] += docComment;
  }

  return parts.join("\n");
}

// ── Go extraction ─────────────────────────────────────────────────────────────

const GO_PATTERNS = {
  /** type Foo struct { ... } or type Foo interface { ... } */
  typeBlock: /^type\s+([A-Z]\w*)\s+(struct|interface)\s*\{/,
  /** type Foo = ... or type Foo int64 etc. */
  typeAlias: /^type\s+([A-Z]\w*)\s+/,
  /** func FooBar(...) */
  funcDef: /^func\s+([A-Z]\w*)\s*\(/,
  /** func (r *Receiver) FooBar(...) */
  methodDef: /^func\s+\([^)]+\)\s+([A-Z]\w*)\s*\(/,
  /** const ( ... ) block */
  constBlock: /^const\s*\(/,
  /** Code generated header */
  generatedHeader: /^\/\/\s*Code generated/,
};

/**
 * Extract snapshot entries from a single Go file.
 * Only captures exported symbols (uppercase first letter).
 */
async function extractFromGoFile(
  filePath: string,
  relPath: string,
): Promise<SnapshotEntry[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const lines = content.split("\n");

  // Skip generated files
  if (lines.length > 0 && GO_PATTERNS.generatedHeader.test(lines[0].trim())) {
    return [];
  }

  const entries: SnapshotEntry[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // -- type Foo struct/interface { ... } --
    const typeBlockMatch = trimmed.match(GO_PATTERNS.typeBlock);
    if (typeBlockMatch) {
      const [, name, kind] = typeBlockMatch;
      const category: SnapshotEntry["category"] = kind === "interface" ? "interface" : "type";
      const block = extractGoBlock(lines, i);
      entries.push({ file: relPath, category, signature: block });
      // Skip past the block
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- type Foo = ... or type Foo SomeType --
    const typeAliasMatch = trimmed.match(GO_PATTERNS.typeAlias);
    if (typeAliasMatch && !trimmed.includes("{")) {
      entries.push({ file: relPath, category: "type", signature: trimmed });
      continue;
    }

    // -- func (r *Receiver) FooBar(...) --
    const methodMatch = trimmed.match(GO_PATTERNS.methodDef);
    if (methodMatch) {
      const sig = extractGoFuncSignature(lines, i);
      entries.push({ file: relPath, category: "function", signature: sig });
      continue;
    }

    // -- func FooBar(...) --
    const funcMatch = trimmed.match(GO_PATTERNS.funcDef);
    if (funcMatch) {
      const sig = extractGoFuncSignature(lines, i);
      entries.push({ file: relPath, category: "function", signature: sig });
      continue;
    }

    // -- const ( ... ) with exported names (enum-like iota blocks) --
    if (GO_PATTERNS.constBlock.test(trimmed)) {
      const block = extractGoConstBlock(lines, i);
      if (block) {
        entries.push({ file: relPath, category: "type", signature: block });
        i = skipGoBlock(lines, i);
      }
      continue;
    }
  }

  return entries;
}

/**
 * Extract a Go block (struct, interface) from opening brace to closing brace.
 */
function extractGoBlock(lines: string[], startIdx: number): string {
  let depth = 0;
  let result = "";
  const maxLines = 30;

  for (let i = startIdx; i < lines.length && i < startIdx + maxLines; i++) {
    const line = lines[i];
    result += (result ? "\n" : "") + line.trimStart();

    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    if (depth <= 0 && i > startIdx) break;
  }

  return result.trim();
}

/**
 * Skip past a Go block and return the last line index.
 */
function skipGoBlock(lines: string[], startIdx: number): number {
  let depth = 0;
  for (let i = startIdx; i < lines.length; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }
    if (depth <= 0 && i > startIdx) return i;
  }
  return lines.length - 1;
}

/**
 * Extract a Go function signature (up to the opening brace or end of line).
 */
function extractGoFuncSignature(lines: string[], startIdx: number): string {
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trimStart();
    if (sig.includes("{")) {
      sig = sig.slice(0, sig.indexOf("{")).trim();
      break;
    }
  }

  // Rewrite method receivers: func (r *Type) Method(... -> (Type).Method(...
  const receiverMatch = sig.match(/^func\s*\(\w+\s+\*?(\w+)\)\s*(\w+)\((.*)$/);
  if (receiverMatch) {
    const [, receiverType, methodName, rest] = receiverMatch;
    return `(${receiverType}).${methodName}(${rest}`;
  }

  return sig;
}

/**
 * Extract a const block if it contains exported names (enum-like iota patterns).
 */
function extractGoConstBlock(lines: string[], startIdx: number): string | null {
  let depth = 0;
  let result = "";
  let hasExported = false;
  const maxLines = 30;

  for (let i = startIdx; i < lines.length && i < startIdx + maxLines; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    result += (result ? "\n" : "") + trimmed;

    // Check if any const name is exported (uppercase)
    if (i > startIdx && trimmed && !trimmed.startsWith("//")) {
      const nameMatch = trimmed.match(/^([A-Z]\w*)\s/);
      if (nameMatch) hasExported = true;
    }

    for (const ch of line) {
      if (ch === "(") depth++;
      if (ch === ")") depth--;
    }

    if (depth <= 0 && i > startIdx) break;
  }

  return hasExported ? result.trim() : null;
}

// ── Rust extraction ───────────────────────────────────────────────────────────

const RUST_PATTERNS = {
  /** pub struct Foo { ... } or pub struct Foo; or pub struct Foo(...) */
  pubStruct: /^pub(?:\(crate\))?\s+struct\s+(\w+)/,
  /** pub enum Foo { ... } */
  pubEnum: /^pub(?:\(crate\))?\s+enum\s+(\w+)/,
  /** pub trait Foo { ... } */
  pubTrait: /^pub(?:\(crate\))?\s+trait\s+(\w+)/,
  /** pub fn foo(...) or pub async fn foo(...) */
  pubFn: /^pub(?:\(crate\))?\s+(?:async\s+)?fn\s+(\w+)/,
  /** pub type Foo = ... */
  pubTypeAlias: /^pub(?:\(crate\))?\s+type\s+(\w+)/,
  /** impl Foo { ... } */
  implBlock: /^impl(?:<[^>]*>)?\s+(\w+)/,
  /** #[cfg(test)] */
  cfgTest: /^#\[cfg\(test\)\]/,
};

/**
 * Extract snapshot entries from a single Rust file.
 * Only captures `pub` items.
 */
async function extractFromRustFile(
  filePath: string,
  relPath: string,
): Promise<SnapshotEntry[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const entries: SnapshotEntry[] = [];
  const lines = content.split("\n");
  let inCfgTest = false;
  let cfgTestDepth = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Track #[cfg(test)] module blocks
    if (RUST_PATTERNS.cfgTest.test(trimmed)) {
      inCfgTest = true;
      cfgTestDepth = 0;
      continue;
    }

    if (inCfgTest) {
      for (const ch of trimmed) {
        if (ch === "{") cfgTestDepth++;
        if (ch === "}") cfgTestDepth--;
      }
      if (cfgTestDepth <= 0 && trimmed.includes("}")) {
        inCfgTest = false;
      }
      continue;
    }

    // -- pub struct --
    if (RUST_PATTERNS.pubStruct.test(trimmed)) {
      if (trimmed.includes("{")) {
        const block = extractGoBlock(lines, i); // reuse Go block extractor (same brace logic)
        entries.push({ file: relPath, category: "type", signature: block });
        i = skipGoBlock(lines, i);
      } else {
        // Tuple struct or unit struct
        entries.push({ file: relPath, category: "type", signature: trimmed.replace(/;$/, "").trim() });
      }
      continue;
    }

    // -- pub enum --
    if (RUST_PATTERNS.pubEnum.test(trimmed)) {
      const block = extractGoBlock(lines, i);
      entries.push({ file: relPath, category: "type", signature: block });
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- pub trait --
    if (RUST_PATTERNS.pubTrait.test(trimmed)) {
      const block = extractGoBlock(lines, i);
      entries.push({ file: relPath, category: "interface", signature: block });
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- pub type alias --
    if (RUST_PATTERNS.pubTypeAlias.test(trimmed) && !trimmed.includes("{")) {
      entries.push({ file: relPath, category: "type", signature: trimmed.replace(/;$/, "").trim() });
      continue;
    }

    // -- pub fn (top-level or inside impl) --
    if (RUST_PATTERNS.pubFn.test(trimmed)) {
      const sig = extractRustFuncSignature(lines, i);
      entries.push({ file: relPath, category: "function", signature: sig });
      continue;
    }
  }

  return entries;
}

/**
 * Extract a Rust function signature up to the opening brace.
 */
function extractRustFuncSignature(lines: string[], startIdx: number): string {
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trimStart();
    if (sig.includes("{")) {
      sig = sig.slice(0, sig.indexOf("{")).trim();
      break;
    }
  }
  return sig;
}

// ── Java extraction ───────────────────────────────────────────────────────────

const JAVA_PATTERNS = {
  /** public class Foo, public abstract class Foo, etc. */
  publicClass: /^(?:@\w+\s+)*public\s+(?:abstract\s+|final\s+)?class\s+(\w+)/,
  /** public interface Foo */
  publicInterface: /^(?:@\w+\s+)*public\s+interface\s+(\w+)/,
  /** public enum Foo */
  publicEnum: /^(?:@\w+\s+)*public\s+enum\s+(\w+)/,
  /** public record Foo(...) */
  publicRecord: /^(?:@\w+\s+)*public\s+record\s+(\w+)/,
  /** public ... methodName(...) */
  publicMethod: /^(?:@\w+\s+)*public\s+(?:static\s+|abstract\s+|final\s+|synchronized\s+)*.+\s+(\w+)\s*\(/,
  /** @Generated annotation */
  generatedAnnotation: /^@Generated/,
  /** Common annotations to capture as part of signatures */
  annotation: /^@(\w+)/,
};

/**
 * Extract snapshot entries from a single Java file.
 * Only captures `public` declarations.
 */
async function extractFromJavaFile(
  filePath: string,
  relPath: string,
): Promise<SnapshotEntry[]> {
  const content = await readFileOr(filePath);
  if (!content) return [];

  const entries: SnapshotEntry[] = [];
  const lines = content.split("\n");
  let pendingAnnotations: string[] = [];
  let inPublicClass = false;
  let classDepth = 0;
  let skipGenerated = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();

    // Skip @Generated items and their subsequent declaration
    if (JAVA_PATTERNS.generatedAnnotation.test(trimmed)) {
      pendingAnnotations = [];
      skipGenerated = true;
      continue;
    }

    if (skipGenerated) {
      // Skip annotation lines that follow @Generated
      if (trimmed.startsWith("@") || !trimmed) continue;
      // Skip the declaration itself (and its entire block if it has braces)
      if (trimmed.includes("{")) {
        i = skipGoBlock(lines, i);
      }
      skipGenerated = false;
      continue;
    }

    // Collect annotations
    const annoMatch = trimmed.match(JAVA_PATTERNS.annotation);
    if (annoMatch && !trimmed.includes("class ") && !trimmed.includes("interface ") &&
        !trimmed.includes("enum ") && !trimmed.includes("record ")) {
      pendingAnnotations.push(trimmed);
      continue;
    }

    // -- public interface --
    if (JAVA_PATTERNS.publicInterface.test(trimmed)) {
      const block = extractJavaTypeBlock(lines, i, pendingAnnotations);
      entries.push({ file: relPath, category: "interface", signature: block });
      pendingAnnotations = [];
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- public enum --
    if (JAVA_PATTERNS.publicEnum.test(trimmed)) {
      const block = extractJavaTypeBlock(lines, i, pendingAnnotations);
      entries.push({ file: relPath, category: "type", signature: block });
      pendingAnnotations = [];
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- public record --
    if (JAVA_PATTERNS.publicRecord.test(trimmed)) {
      const sig = extractJavaRecordSignature(lines, i, pendingAnnotations);
      entries.push({ file: relPath, category: "type", signature: sig });
      pendingAnnotations = [];
      i = skipGoBlock(lines, i);
      continue;
    }

    // -- public class --
    if (JAVA_PATTERNS.publicClass.test(trimmed)) {
      const header = [...pendingAnnotations, trimmed.replace(/\s*\{.*$/, "").trim()].join("\n");
      entries.push({ file: relPath, category: "type", signature: header });
      inPublicClass = true;
      classDepth = 0;
      for (const ch of line) {
        if (ch === "{") classDepth++;
        if (ch === "}") classDepth--;
      }
      pendingAnnotations = [];
      continue;
    }

    // Track brace depth inside class
    if (inPublicClass) {
      for (const ch of line) {
        if (ch === "{") classDepth++;
        if (ch === "}") classDepth--;
      }
      if (classDepth <= 0) {
        inPublicClass = false;
        pendingAnnotations = [];
        continue;
      }
    }

    // -- public methods inside a class --
    if (inPublicClass && JAVA_PATTERNS.publicMethod.test(trimmed)) {
      const sig = extractJavaMethodSignature(lines, i, pendingAnnotations);
      entries.push({ file: relPath, category: "function", signature: sig });
      pendingAnnotations = [];
      continue;
    }

    // -- annotated public fields inside a class --
    if (inPublicClass && pendingAnnotations.length > 0 && /^public\s+\S+\s+\w+\s*;/.test(trimmed)) {
      const fieldSig = [...pendingAnnotations, trimmed].join("\n");
      entries.push({ file: relPath, category: "interface", signature: fieldSig });
      pendingAnnotations = [];
      continue;
    }

    // Reset annotations on non-annotation, non-blank lines
    if (trimmed && !trimmed.startsWith("//") && !trimmed.startsWith("/*") && !trimmed.startsWith("*")) {
      pendingAnnotations = [];
    }
  }

  return entries;
}

/**
 * Extract a Java type block (interface, enum) with annotations, capped at 30 lines.
 */
function extractJavaTypeBlock(
  lines: string[],
  startIdx: number,
  annotations: string[],
): string {
  const parts = [...annotations];
  let depth = 0;
  const maxLines = 30;

  for (let i = startIdx; i < lines.length && parts.length < maxLines + annotations.length; i++) {
    const line = lines[i].trimStart();
    parts.push(line);

    for (const ch of lines[i]) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    if (depth <= 0 && i > startIdx) break;
  }

  return parts.join("\n").trim();
}

/**
 * Extract a Java record signature (up to the closing paren or brace).
 */
function extractJavaRecordSignature(
  lines: string[],
  startIdx: number,
  annotations: string[],
): string {
  const parts = [...annotations];
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trimStart();
    if (sig.includes("{")) {
      sig = sig.slice(0, sig.indexOf("{")).trim();
      break;
    }
  }
  parts.push(sig);
  return parts.join("\n");
}

/**
 * Extract a Java method signature with preceding annotations.
 */
function extractJavaMethodSignature(
  lines: string[],
  startIdx: number,
  annotations: string[],
): string {
  const parts = [...annotations];
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trimStart();
    if (sig.includes("{")) {
      sig = sig.slice(0, sig.indexOf("{")).trim();
      break;
    }
    if (sig.includes(";")) {
      sig = sig.replace(/;$/, "").trim();
      break;
    }
  }
  parts.push(sig);
  return parts.join("\n");
}

/**
 * Append an "imported by N files" comment to signatures of highly-imported entries.
 */
function annotateSignature(entry: SnapshotEntry, commentPrefix = "//"): string {
  if (entry.importedByCount && entry.importedByCount > 2) {
    // Add comment to first line of the signature
    const firstLine = entry.signature.split("\n")[0];
    const rest = entry.signature.split("\n").slice(1);
    const annotated = `${firstLine}  ${commentPrefix} imported by ${entry.importedByCount} files`;
    return rest.length > 0 ? [annotated, ...rest].join("\n") : annotated;
  }
  return entry.signature;
}

/**
 * Condense snapshot entries into a readable markdown block.
 */
/** Map language to code fence identifier */
const LANG_FENCE_MAP: Record<string, string> = {
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
};

/** Map language to comment prefix */
const LANG_COMMENT_MAP: Record<string, string> = {
  python: "#",
};

/** Infer language from file extension */
function inferLanguageFromPath(filePath: string): Language {
  if (filePath.endsWith(".py")) return "python";
  if (filePath.endsWith(".go")) return "go";
  if (filePath.endsWith(".rs")) return "rust";
  if (filePath.endsWith(".java")) return "java";
  if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) return "typescript";
  if (filePath.endsWith(".js") || filePath.endsWith(".jsx") || filePath.endsWith(".mjs")) return "javascript";
  return "other";
}

function renderSnapshot(entries: SnapshotEntry[], language: Language = "typescript"): string {
  if (entries.length === 0) return "";

  const lang = LANG_FENCE_MAP[language] ?? "ts";
  const comment = LANG_COMMENT_MAP[language] ?? "//";

  let md = "";

  // Group by category for cleaner output
  const types = entries.filter((e) => e.category === "type" || e.category === "interface");
  const stores = entries.filter((e) => e.category === "store");
  const hooks = entries.filter((e) => e.category === "hook");
  const components = entries.filter((e) => e.category === "component");
  const functions = entries.filter((e) => e.category === "function");

  if (types.length > 0) {
    md += `### Core Types\n\n\`\`\`${lang}\n`;
    md += types.map((e) => annotateSignature(e, comment)).join("\n\n");
    md += "\n```\n\n";
  }

  if (stores.length > 0) {
    md += `### Store Shape\n\n\`\`\`${lang}\n`;
    md += stores.map((e) => annotateSignature(e, comment)).join("\n\n");
    md += "\n```\n\n";
  }

  if (components.length > 0) {
    md += `### Component Props\n\n\`\`\`${lang}\n`;
    md += components.map((e) => annotateSignature(e, comment)).join("\n\n");
    md += "\n```\n\n";
  }

  if (hooks.length > 0) {
    md += `### Hooks\n\n\`\`\`${lang}\n`;
    md += hooks.map((e) => annotateSignature(e, comment)).join("\n\n");
    md += "\n```\n\n";
  }

  if (functions.length > 0) {
    md += `### Key Functions\n\n\`\`\`${lang}\n`;
    md += functions.map((e) => annotateSignature(e, comment)).join("\n\n");
    md += "\n```\n\n";
  }

  return md.trimEnd();
}

/**
 * Render snapshot entries from a multi-language project.
 * Groups entries by language and renders each group in the appropriate code fence.
 */
function renderMultiLangSnapshot(entries: SnapshotEntry[], primaryLang: Language): string {
  if (entries.length === 0) return "";

  // Group entries by their file's language
  const byLang = new Map<Language, SnapshotEntry[]>();
  for (const entry of entries) {
    const lang = inferLanguageFromPath(entry.file);
    const effective = lang === "other" ? primaryLang : lang;
    const existing = byLang.get(effective) ?? [];
    existing.push(entry);
    byLang.set(effective, existing);
  }

  // Render primary language first, then secondary
  const parts: string[] = [];
  const primaryEntries = byLang.get(primaryLang);
  if (primaryEntries && primaryEntries.length > 0) {
    parts.push(renderSnapshot(primaryEntries, primaryLang));
    byLang.delete(primaryLang);
  }

  for (const [lang, langEntries] of byLang) {
    if (langEntries.length > 0) {
      parts.push(renderSnapshot(langEntries, lang));
    }
  }

  return parts.join("\n\n");
}

/**
 * Generate a code snapshot for the project.
 */
export async function generateSnapshot(
  ctx: DetectedContext,
  customPaths: string[],
  graph?: ImportGraph,
  maxTokens?: number,
  onProgress?: ProgressCallback,
  gitActivity?: GitAnalysis | null,
): Promise<CodeSnapshot> {
  const scanPaths =
    customPaths.length > 0 ? customPaths : getDefaultScanPaths(ctx);

  if (scanPaths.length === 0) {
    return { entries: [], markdown: "" };
  }

  // Report which directories we're scanning
  const dirNames = scanPaths.map((p) => p.split("/").pop() ?? p);
  onProgress?.(`Scanning ${scanPaths.length} directories: ${dirNames.join(", ")}...`);

  // File patterns and extractor based on language
  let fileGlob: string;
  let extractor: (filePath: string, relPath: string) => Promise<SnapshotEntry[]>;
  switch (ctx.language) {
    case "python":
      fileGlob = "**/*.py";
      extractor = extractFromPythonFile;
      break;
    case "go":
      fileGlob = "**/*.go";
      extractor = extractFromGoFile;
      break;
    case "rust":
      fileGlob = "**/*.rs";
      extractor = extractFromRustFile;
      break;
    case "java":
      fileGlob = "**/*.java";
      extractor = extractFromJavaFile;
      break;
    default:
      fileGlob = "**/*.{ts,tsx,js,jsx}";
      extractor = extractFromFile;
      break;
  }
  const patterns = scanPaths.map((p) => `${p}/${fileGlob}`);

  const ignorePatterns = [
    "**/node_modules/**",
    "**/dist/**",
    "**/build/**",
    "**/*.test.*",
    "**/*.spec.*",
    "**/__tests__/**",
    "**/.Trash/**",
    "**/Library/**",
    "**/.git/**",
  ];

  // Language-specific ignore patterns
  switch (ctx.language) {
    case "python":
      ignorePatterns.push(
        "**/__pycache__/**",
        "**/venv/**",
        "**/.venv/**",
        "**/env/**",
        "**/migrations/**",
        "**/test_*.py",
        "**/tests/**",
        "**/conftest.py",
        "**/setup.py",
      );
      break;
    case "go":
      ignorePatterns.push(
        "**/*_test.go",
        "**/vendor/**",
        "**/testdata/**",
      );
      break;
    case "rust":
      ignorePatterns.push(
        "**/target/**",
        "**/tests/**",
        "**/*.pb.rs",
      );
      break;
    case "java":
      ignorePatterns.push(
        "**/target/**",
        "**/build/**",
        "**/src/test/**",
        "**/*Test.java",
        "**/*Spec.java",
      );
      break;
  }

  const files = await glob(patterns, {
    cwd: ctx.rootDir,
    ignore: ignorePatterns,
    absolute: false,
  });

  const allEntries: SnapshotEntry[] = [];

  const chunkSize = 50;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    onProgress?.(`Extracting signatures... ${Math.min(i + chunkSize, files.length)}/${files.length} files`);
    const results = await Promise.all(
      chunk.map((file) =>
        extractor(path.join(ctx.rootDir, file), file).catch(() => [] as SnapshotEntry[]),
      ),
    );
    for (const entries of results) allEntries.push(...entries);
  }

  // Multi-language support: also scan secondary languages
  if (ctx.secondaryLanguages && customPaths.length === 0) {
    for (const secLang of ctx.secondaryLanguages) {
      const secScanPaths = getDefaultScanPathsForLanguage(secLang, ctx);
      const { glob: secGlob, extractor: secExtractor, ignore: secIgnore } = getLanguageConfig(secLang);
      const secPatterns = secScanPaths.map((p) => `${p}/${secGlob}`);
      const secFiles = await glob(secPatterns, {
        cwd: ctx.rootDir,
        ignore: [...ignorePatterns, ...secIgnore],
        absolute: false,
      });

      onProgress?.(`Scanning ${secFiles.length} ${secLang} files...`);
      for (let si = 0; si < secFiles.length; si += chunkSize) {
        const secChunk = secFiles.slice(si, si + chunkSize);
        const secResults = await Promise.all(
          secChunk.map((file) =>
            secExtractor(path.join(ctx.rootDir, file), file).catch(() => [] as SnapshotEntry[]),
          ),
        );
        for (const entries of secResults) allEntries.push(...entries);
      }
    }
  }

  // Populate importedByCount from graph
  if (graph) {
    for (const entry of allEntries) {
      const count = graph.inDegree.get(entry.file) ?? 0;
      if (count > 0) {
        entry.importedByCount = count;
      }
    }
  }

  // Detect library projects: skip dead export filtering for published packages
  // since their consumers are external and invisible to the import graph
  let isLibrary = false;
  if (ctx.language === "typescript" || ctx.language === "javascript") {
    const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
    if (pkg && (pkg.main || pkg.exports || pkg.bin || pkg.module || pkg.types)) {
      isLibrary = true;
    }
  }

  // Filter dead exports using import graph (skip for library projects)
  onProgress?.("Filtering dead exports...");
  const liveEntries = isLibrary ? allEntries : filterDeadExports(allEntries, graph);

  // Apply token budget if graph is available
  const budget =
    maxTokens ??
    Math.min(20000, 4000 + Math.floor(Math.sqrt(ctx.sourceFileCount) * 400));
  onProgress?.(`Applying token budget (${budget.toLocaleString()} tokens)...`);
  const { selected, excluded } = applyTokenBudget(liveEntries, budget, graph, gitActivity);

  // For multi-language projects, render each language group separately
  const hasMultiLang = ctx.secondaryLanguages && ctx.secondaryLanguages.length > 0;
  let markdown: string;
  if (hasMultiLang) {
    markdown = renderMultiLangSnapshot(selected, ctx.language);
  } else {
    markdown = renderSnapshot(selected, ctx.language);
  }

  return {
    entries: selected,
    markdown,
    budgetExcluded: excluded,
    estimatedTokens: estimateTokens(markdown),
  };
}

/** Entry-point patterns: files that are never filtered as dead exports */
const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)index\.[jt]sx?$/,
  /(?:^|\/)App\.[jt]sx?$/,
  /(?:^|\/)main\.[jt]sx?$/,
  /(?:^|\/)pages\//,
  /(?:^|\/)app\//,
  /(?:^|\/)routes?\//,
  /(?:^|\/)middleware\//,
  // Python entry points
  /(?:^|\/)__init__\.py$/,
  /(?:^|\/)main\.py$/,
  /(?:^|\/)app\.py$/,
  /(?:^|\/)wsgi\.py$/,
  /(?:^|\/)asgi\.py$/,
  // Go entry points
  /(?:^|\/)main\.go$/,
  /(?:^|\/)cmd\//,
  // Rust entry points
  /(?:^|\/)main\.rs$/,
  /(?:^|\/)lib\.rs$/,
  // Java entry points
  /(?:^|\/)Main\.java$/,
  /(?:^|\/)Application\.java$/,
];

/**
 * Extract the identifier name from a signature string.
 * Handles both JS/TS and Python signatures.
 */
function extractNameFromSignature(sig: string): string | null {
  // JS/TS: "export interface Foo {" -> "Foo"
  const jsMatch = sig.match(
    /export\s+(?:default\s+)?(?:async\s+)?(?:interface|type|function|const|let|var|class|enum)\s+(\w+)/,
  );
  if (jsMatch) return jsMatch[1];

  // Python: "class Foo:" or "class Foo(Base):" or "def foo(" or "async def foo("
  const pyMatch = sig.match(
    /(?:class|(?:async\s+)?def)\s+(\w+)/,
  );
  if (pyMatch) return pyMatch[1];

  // Go: "type Foo struct" or "func FooBar(" or "func (r *R) FooBar("
  const goTypeMatch = sig.match(/^type\s+(\w+)/);
  if (goTypeMatch) return goTypeMatch[1];
  const goFuncMatch = sig.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/);
  if (goFuncMatch) return goFuncMatch[1];

  // Rust: "pub struct Foo" or "pub fn foo" or "pub trait Foo"
  const rustMatch = sig.match(/^pub(?:\(crate\))?\s+(?:async\s+)?(?:struct|enum|trait|fn|type)\s+(\w+)/);
  if (rustMatch) return rustMatch[1];

  // Java: "public class Foo" or "public void foo("
  const javaMatch = sig.match(/public\s+(?:static\s+|abstract\s+|final\s+)?(?:class|interface|enum|record|\S+)\s+(\w+)/);
  if (javaMatch) return javaMatch[1];

  return null;
}

/**
 * Check if a file is an entry point (never filtered).
 */
function isEntryPoint(filePath: string): boolean {
  return ENTRY_POINT_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Filter out exports that are never imported anywhere in the project.
 * Entry-point files and barrel re-exports are always kept.
 */
function filterDeadExports(
  entries: SnapshotEntry[],
  graph?: ImportGraph,
): SnapshotEntry[] {
  if (!graph || graph.edges.length === 0) return entries;

  const usedExports = findUsedExports(graph.edges);

  return entries.filter((entry) => {
    // Always keep entry-point files
    if (isEntryPoint(entry.file)) return true;

    // Extract the export name from the signature
    const name = extractNameFromSignature(entry.signature);
    if (!name) return true; // Can't determine name, keep it

    // Check if this export is used somewhere
    return usedExports.has(`${entry.file}::${name}`);
  });
}

/**
 * Greedy knapsack: prioritize entries by centrality-weighted value per token.
 */
function applyTokenBudget(
  entries: SnapshotEntry[],
  budget: number,
  graph?: ImportGraph,
  gitActivity?: GitAnalysis | null,
): { selected: SnapshotEntry[]; excluded: number } {
  if (entries.length === 0) return { selected: [], excluded: 0 };

  // Score each entry
  const scored = entries.map((entry) => {
    const tokens = Math.max(1, estimateTokens(entry.signature));
    const centrality = graph?.centrality.get(entry.file) ?? 0.5;

    // Category boost: types/interfaces are more valuable for context
    let categoryBoost = 1.0;
    if (entry.category === "type" || entry.category === "interface") categoryBoost = 1.3;

    // Git boost: logarithmic scale so 100 commits scores higher than 20
    let gitBoost = 1.0;
    if (gitActivity) {
      const commits = gitActivity.commitCounts.get(entry.file) ?? 0;
      if (commits > 0) {
        gitBoost = 1.0 + Math.log2(commits + 1) * 0.15;
      }
    }

    const value = (centrality * categoryBoost * gitBoost) / tokens;
    return { entry, tokens, value };
  });

  // Submodular greedy selection with diversity discount:
  // After selecting an entry, discount remaining entries from the same file
  // to ensure diverse file coverage in the snapshot.
  let remaining = budget;
  const selected: SnapshotEntry[] = [];
  const selectedFiles = new Set<string>();
  const consumed = new Set<number>();

  while (remaining > 0) {
    // Re-score with diversity discount and find best remaining entry
    let bestIdx = -1;
    let bestValue = -1;

    for (let j = 0; j < scored.length; j++) {
      if (consumed.has(j)) continue;
      const { entry, tokens, value } = scored[j];
      if (tokens > remaining) continue;

      const adjustedValue = selectedFiles.has(entry.file) ? value * 0.5 : value;
      if (adjustedValue > bestValue) {
        bestValue = adjustedValue;
        bestIdx = j;
      }
    }

    if (bestIdx === -1) break;

    const { entry, tokens } = scored[bestIdx];
    selected.push(entry);
    remaining -= tokens;
    selectedFiles.add(entry.file);
    consumed.add(bestIdx);
  }

  return {
    selected,
    excluded: entries.length - selected.length,
  };
}
