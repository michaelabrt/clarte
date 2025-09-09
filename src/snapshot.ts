import path from "node:path";
import fg from "fast-glob";
import { estimateTokens, readFileOr } from "./utils.js";
import { findUsedExports } from "./graph.js";
import type { CodeSnapshot, DetectedContext, ImportGraph, SnapshotEntry } from "./types.js";

/**
 * Auto-detect which directories to scan for code snapshots.
 */
function getDefaultScanPaths(ctx: DetectedContext): string[] {
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
        // This is likely a component — we only care about its Props, not its body
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

  // Block with braces — capture until matching depth
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

/**
 * Condense snapshot entries into a readable markdown block.
 */
function renderSnapshot(entries: SnapshotEntry[]): string {
  if (entries.length === 0) return "";

  // Group by file
  const byFile = new Map<string, SnapshotEntry[]>();
  for (const e of entries) {
    const list = byFile.get(e.file) ?? [];
    list.push(e);
    byFile.set(e.file, list);
  }

  let md = "";

  // Group by category for cleaner output
  const types = entries.filter((e) => e.category === "type" || e.category === "interface");
  const stores = entries.filter((e) => e.category === "store");
  const hooks = entries.filter((e) => e.category === "hook");
  const components = entries.filter((e) => e.category === "component");
  const functions = entries.filter((e) => e.category === "function");

  if (types.length > 0) {
    md += "### Core Types\n\n```ts\n";
    md += types.map((e) => e.signature).join("\n\n");
    md += "\n```\n\n";
  }

  if (stores.length > 0) {
    md += "### Store Shape\n\n```ts\n";
    md += stores.map((e) => e.signature).join("\n\n");
    md += "\n```\n\n";
  }

  if (components.length > 0) {
    md += "### Component Props\n\n```ts\n";
    md += components.map((e) => e.signature).join("\n\n");
    md += "\n```\n\n";
  }

  if (hooks.length > 0) {
    md += "### Hooks\n\n```ts\n";
    md += hooks.map((e) => e.signature).join("\n\n");
    md += "\n```\n\n";
  }

  if (functions.length > 0) {
    md += "### Key Functions\n\n```ts\n";
    md += functions.map((e) => e.signature).join("\n\n");
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
): Promise<CodeSnapshot> {
  const scanPaths =
    customPaths.length > 0 ? customPaths : getDefaultScanPaths(ctx);

  if (scanPaths.length === 0) {
    return { entries: [], markdown: "" };
  }

  // Find all TS/JS files in the scan paths
  const patterns = scanPaths.map((p) => `${p}/**/*.{ts,tsx,js,jsx}`);

  const files = await fg(patterns, {
    cwd: ctx.rootDir,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/*.test.*",
      "**/*.spec.*",
      "**/__tests__/**",
    ],
    absolute: false,
  });

  const allEntries: SnapshotEntry[] = [];

  for (const file of files) {
    const absPath = path.join(ctx.rootDir, file);
    const entries = await extractFromFile(absPath, file);
    allEntries.push(...entries);
  }

  // Filter dead exports using import graph
  const liveEntries = filterDeadExports(allEntries, graph);

  // Apply token budget if graph is available
  const budget =
    maxTokens ??
    Math.min(16000, 4000 + Math.floor(ctx.sourceFileCount / 25) * 500);
  const { selected, excluded } = applyTokenBudget(liveEntries, budget, graph);

  const markdown = renderSnapshot(selected);

  return {
    entries: selected,
    markdown,
    budgetExcluded: excluded,
    estimatedTokens: estimateTokens(markdown),
  };
}

/** Entry-point patterns — files that are never filtered as dead exports */
const ENTRY_POINT_PATTERNS = [
  /(?:^|\/)index\.[jt]sx?$/,
  /(?:^|\/)App\.[jt]sx?$/,
  /(?:^|\/)main\.[jt]sx?$/,
  /(?:^|\/)pages\//,
  /(?:^|\/)app\//,
  /(?:^|\/)routes?\//,
  /(?:^|\/)middleware\//,
];

/**
 * Extract the identifier name from a signature string.
 * e.g. "export interface Foo {" -> "Foo"
 *      "export const bar =" -> "bar"
 *      "export type Baz =" -> "Baz"
 */
function extractNameFromSignature(sig: string): string | null {
  const m = sig.match(
    /export\s+(?:default\s+)?(?:async\s+)?(?:interface|type|function|const|let|var|class|enum)\s+(\w+)/,
  );
  return m?.[1] ?? null;
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
): { selected: SnapshotEntry[]; excluded: number } {
  if (entries.length === 0) return { selected: [], excluded: 0 };

  // Score each entry
  const scored = entries.map((entry) => {
    const tokens = Math.max(1, estimateTokens(entry.signature));
    const centrality = graph?.centrality.get(entry.file) ?? 0.5;

    // Category boost: types/interfaces are more valuable for context
    let boost = 1.0;
    if (entry.category === "type" || entry.category === "interface") boost = 1.3;

    const value = (centrality * boost) / tokens;
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
