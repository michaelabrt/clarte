import path from "node:path";
import { glob } from "tinyglobby";
import { estimateTokens, readFileOr, readJsonFile } from "./utils.js";
import { findUsedExports } from "./graph-analysis.js";
import { initTreeSitter, extractSnapshotAst } from "./ast-parse.js";
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
        extractor: makeExtractor("python"),
        ignore: ["**/__pycache__/**", "**/venv/**", "**/.venv/**", "**/env/**",
                 "**/migrations/**", "**/test_*.py", "**/tests/**", "**/conftest.py", "**/setup.py"],
      };
    case "go":
      return {
        glob: "**/*.go",
        extractor: makeExtractor("go"),
        ignore: ["**/*_test.go", "**/vendor/**", "**/testdata/**"],
      };
    case "rust":
      return {
        glob: "**/*.rs",
        extractor: makeExtractor("rust"),
        ignore: ["**/target/**", "**/tests/**", "**/*.pb.rs"],
      };
    case "java":
      return {
        glob: "**/*.java",
        extractor: makeExtractor("java"),
        ignore: ["**/target/**", "**/build/**", "**/src/test/**", "**/*Test.java", "**/*Spec.java"],
      };
    default:
      return {
        glob: "**/*.{ts,tsx,js,jsx}",
        extractor: makeExtractor(lang),
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
 * Extract snapshot entries from a file using tree-sitter AST parsing.
 */
function makeExtractor(lang: Language) {
  return async (filePath: string, relPath: string): Promise<SnapshotEntry[]> => {
    const content = await readFileOr(filePath);
    if (!content) return [];
    return extractSnapshotAst(content, relPath, lang);
  };
}

// Regex-based extractors deleted (replaced by AST in ast-parse.ts)

/**
 * Append an "imported by N files" comment to signatures of highly-imported entries.
 */
function annotateSignature(entry: SnapshotEntry, commentPrefix = "//"): string {
  if (entry.importedByCount && entry.importedByCount > 2) {
    const total = entry.importedByCount;
    const direct = entry.directImportedByCount ?? total;
    const annotation = direct < total
      ? `${commentPrefix} imported by ${direct} files (${total} via barrels)`
      : `${commentPrefix} imported by ${total} files`;
    // Add comment to first line of the signature
    const firstLine = entry.signature.split("\n")[0];
    const rest = entry.signature.split("\n").slice(1);
    const annotated = `${firstLine}  ${annotation}`;
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

export function renderSnapshot(entries: SnapshotEntry[], language: Language = "typescript"): string {
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

  // Render primary language first, then secondary (sorted for determinism)
  const parts: string[] = [];
  const primaryEntries = byLang.get(primaryLang);
  if (primaryEntries && primaryEntries.length > 0) {
    parts.push(renderSnapshot(primaryEntries, primaryLang));
    byLang.delete(primaryLang);
  }

  const sortedLangs = [...byLang.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  for (const [lang, langEntries] of sortedLangs) {
    if (langEntries.length > 0) {
      parts.push(renderSnapshot(langEntries, lang));
    }
  }

  return parts.join("\n\n");
}

/**
 * Re-render a snapshot with fewer entries to fit within a character budget.
 * Entries are already sorted by value (submodular greedy selection), so
 * trimming from the end removes the least valuable entries first.
 *
 * Returns the trimmed markdown and the number of entries removed.
 */
export function trimSnapshotToChars(
  snapshot: CodeSnapshot,
  maxChars: number,
  language: Language = "typescript",
): { markdown: string; trimmedCount: number } {
  const entries = snapshot.entries;
  if (entries.length === 0) return { markdown: "", trimmedCount: 0 };

  // Binary search: find the largest subset of entries (from the front)
  // whose rendered markdown fits within maxChars
  let lo = 0;
  let hi = entries.length;

  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const rendered = renderSnapshot(entries.slice(0, mid), language);
    if (rendered.length <= maxChars) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  const kept = Math.max(1, lo); // Always keep at least 1 entry
  const markdown = renderSnapshot(entries.slice(0, kept), language);
  return { markdown, trimmedCount: entries.length - kept };
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

  await initTreeSitter();

  // File patterns and extractor based on language
  let fileGlob: string;
  let extractor: (filePath: string, relPath: string) => Promise<SnapshotEntry[]>;
  switch (ctx.language) {
    case "python":
      fileGlob = "**/*.py";
      extractor = makeExtractor("python");
      break;
    case "go":
      fileGlob = "**/*.go";
      extractor = makeExtractor("go");
      break;
    case "rust":
      fileGlob = "**/*.rs";
      extractor = makeExtractor("rust");
      break;
    case "java":
      fileGlob = "**/*.java";
      extractor = makeExtractor("java");
      break;
    default:
      fileGlob = "**/*.{ts,tsx,js,jsx}";
      extractor = makeExtractor(ctx.language);
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
        const directCount = graph.directInDegree?.get(entry.file) ?? count;
        if (directCount < count) {
          entry.directImportedByCount = directCount;
        }
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
