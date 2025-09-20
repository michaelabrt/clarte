import path from "node:path";
import fg from "fast-glob";
import { estimateTokens, readFileOr } from "./utils.js";
import { findUsedExports } from "./graph.js";
import type { CodeSnapshot, DetectedContext, GitAnalysis, ImportGraph, Language, ProgressCallback, SnapshotEntry } from "./types.js";

/**
 * Auto-detect which directories to scan for code snapshots.
 */
function getDefaultScanPaths(ctx: DetectedContext): string[] {
  if (ctx.language === "python") {
    return getDefaultPythonScanPaths(ctx);
  }
  return getDefaultJsTsScanPaths(ctx);
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
 * Regex patterns for extracting TypeScript/JavaScript declarations.
 */
const PATTERNS = {
  /** export interface Foo { ... } or export type Foo = ... */
  exportedType: /^export\s+(interface|type)\s+(\w+)/,
  /** interface FooProps { ... } (component props, even if not exported) */
  propsInterface: /^(?:export\s+)?interface\s+(\w+Props)\s*\{/,
  /** export function foo(...) or export const foo = */
  exportedFunction: /^export\s+(?:async\s+)?(?:function|const)\s+(\w+)/,
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

    // -- Exported functions --
    const funcMatch = trimmed.match(PATTERNS.exportedFunction);
    if (funcMatch) {
      const [, name] = funcMatch;

      // Skip React component default exports like `export function MyComponent(`
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

    for (const ch of line) {
      if (ch === "{") depth++;
      if (ch === "}") depth--;
    }

    if (depth <= 0 && i > startIdx) break;
  }

  return result.trim();
}

/**
 * Extract a function signature (everything up to the opening brace or arrow).
 */
function extractSignatureLine(lines: string[], startIdx: number): string {
  let sig = "";
  for (let i = startIdx; i < lines.length && i < startIdx + 5; i++) {
    sig += (sig ? " " : "") + lines[i].trim();
    // Stop at opening brace, arrow, or if it looks complete
    if (sig.includes("{") || sig.includes("=>")) {
      // Trim everything after the opening brace / arrow
      const braceIdx = sig.indexOf("{");
      const arrowIdx = sig.indexOf("=>");
      const cutIdx =
        braceIdx >= 0 && arrowIdx >= 0
          ? Math.min(braceIdx, arrowIdx)
          : braceIdx >= 0
            ? braceIdx
            : arrowIdx >= 0
              ? arrowIdx + 2
              : sig.length;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Skip deeply indented lines (nested classes/functions)
    if (indent > 0 && !pendingDecorators.length) {
      // Only process top-level (indent 0) or class-level methods (indent 4)
      // For snapshot purposes, we only want top-level definitions
      if (indent > 4) continue;
    }

    // Collect decorators
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

        // Extract the class block (indentation-based)
        const block = extractPythonBlock(lines, i, pendingDecorators);
        entries.push({ file: relPath, category, signature: block });
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
function renderSnapshot(entries: SnapshotEntry[], language: Language = "typescript"): string {
  if (entries.length === 0) return "";

  const lang = language === "python" ? "python" : "ts";
  const comment = language === "python" ? "#" : "//";

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
  const isPython = ctx.language === "python";
  const fileGlob = isPython ? "**/*.py" : "**/*.{ts,tsx,js,jsx}";
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
  if (isPython) {
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
  }

  const files = await fg(patterns, {
    cwd: ctx.rootDir,
    ignore: ignorePatterns,
    absolute: false,
  });

  const allEntries: SnapshotEntry[] = [];
  const extractor = isPython ? extractFromPythonFile : extractFromFile;

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if ((i + 1) % 20 === 0 || i === files.length - 1) {
      const dir = path.dirname(file).split("/").pop() ?? "";
      onProgress?.(`Extracting signatures... ${i + 1}/${files.length} files (${dir}/)`);
    }

    const absPath = path.join(ctx.rootDir, file);
    const entries = await extractor(absPath, file);
    allEntries.push(...entries);
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

  // Filter dead exports using import graph
  onProgress?.("Filtering dead exports...");
  const liveEntries = filterDeadExports(allEntries, graph);

  // Apply token budget if graph is available
  const budget =
    maxTokens ??
    Math.min(16000, 4000 + Math.floor(ctx.sourceFileCount / 25) * 500);
  onProgress?.(`Applying token budget (${budget.toLocaleString()} tokens)...`);
  const { selected, excluded } = applyTokenBudget(liveEntries, budget, graph, gitActivity);

  const markdown = renderSnapshot(selected, ctx.language);

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
  return pyMatch?.[1] ?? null;
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

    // Git boost: files changed recently get priority
    let gitBoost = 1.0;
    if (gitActivity) {
      const commits = gitActivity.commitCounts.get(entry.file) ?? 0;
      gitBoost = 1.0 + Math.min(0.5, commits / 20);
    }

    const value = (centrality * categoryBoost * gitBoost) / tokens;
    return { entry, tokens, value };
  });

  // Sort by value descending
  scored.sort((a, b) => b.value - a.value);

  // Greedily select
  let remaining = budget;
  const selected: SnapshotEntry[] = [];

  for (const { entry, tokens } of scored) {
    if (tokens <= remaining) {
      selected.push(entry);
      remaining -= tokens;
    }
  }

  return {
    selected,
    excluded: entries.length - selected.length,
  };
}
