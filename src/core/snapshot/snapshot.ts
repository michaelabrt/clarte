import path from "node:path";
import { glob } from "tinyglobby";
import { IGNORE_GLOBS } from "../config/ignore-patterns";
import { estimateTokens, readJsonFile } from "../utils";
import { findUsedExports } from "../graph/hub-files";
import { initForLanguage } from "../parsers/init";
import type {
  CodeSnapshot,
  DetectedContext,
  GitAnalysis,
  ImportGraph,
  Language,
  ProgressCallback,
  SnapshotEntry,
} from "../types";
import { getDefaultScanPaths, getDefaultScanPathsForLanguage, getLanguageConfig, makeExtractor } from "./scan-paths";

function annotateSignature(entry: SnapshotEntry, commentPrefix = "//"): string {
  if (entry.importedByCount && entry.importedByCount > 2) {
    const total = entry.importedByCount;
    const direct = entry.directImportedByCount ?? total;
    const annotation =
      direct < total
        ? `${commentPrefix} imported by ${direct} files (${total} via barrels)`
        : `${commentPrefix} imported by ${total} files`;
    const firstLine = entry.signature.split("\n")[0];
    const rest = entry.signature.split("\n").slice(1);
    const annotated = `${firstLine}  ${annotation}`;
    return rest.length > 0 ? [annotated, ...rest].join("\n") : annotated;
  }
  return entry.signature;
}

const LANG_FENCE_MAP: Record<string, string> = {
  python: "python",
  go: "go",
  rust: "rust",
  java: "java",
};

const LANG_COMMENT_MAP: Record<string, string> = {
  python: "#",
};

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

function renderMultiLangSnapshot(entries: SnapshotEntry[], primaryLang: Language): string {
  if (entries.length === 0) return "";

  const byLang = new Map<Language, SnapshotEntry[]>();
  for (const entry of entries) {
    const lang = inferLanguageFromPath(entry.file);
    const effective = lang === "other" ? primaryLang : lang;
    const existing = byLang.get(effective) ?? [];
    existing.push(entry);
    byLang.set(effective, existing);
  }

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

export async function generateSnapshot(
  ctx: DetectedContext,
  customPaths: string[],
  graph?: ImportGraph,
  maxTokens?: number,
  onProgress?: ProgressCallback,
  gitActivity?: GitAnalysis | null,
): Promise<CodeSnapshot> {
  const scanPaths = customPaths.length > 0 ? customPaths : getDefaultScanPaths(ctx);

  if (scanPaths.length === 0) {
    return { entries: [], markdown: "" };
  }

  const dirNames = scanPaths.map((p) => p.split("/").pop() ?? p);
  onProgress?.(`Scanning ${scanPaths.length} directories: ${dirNames.join(", ")}...`);

  const langsToLoad: Language[] = [ctx.language];
  if (ctx.secondaryLanguages) langsToLoad.push(...ctx.secondaryLanguages);
  await Promise.all(langsToLoad.map(initForLanguage));

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

  const ignorePatterns = [...IGNORE_GLOBS, "**/*.test.*", "**/*.spec.*", "**/__tests__/**"];

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
      ignorePatterns.push("**/*_test.go", "**/vendor/**", "**/testdata/**");
      break;
    case "rust":
      ignorePatterns.push("**/target/**", "**/tests/**", "**/*.pb.rs");
      break;
    case "java":
      ignorePatterns.push("**/target/**", "**/build/**", "**/src/test/**", "**/*Test.java", "**/*Spec.java");
      break;
  }

  let files: string[];
  try {
    files = await glob(patterns, {
      cwd: ctx.rootDir,
      ignore: ignorePatterns,
      absolute: false,
    });
  } catch {
    onProgress?.("Warning: could not scan source files (permission denied or invalid path)");
    return { entries: [], markdown: "" };
  }

  const allEntries: SnapshotEntry[] = [];

  const chunkSize = 50;
  for (let i = 0; i < files.length; i += chunkSize) {
    const chunk = files.slice(i, i + chunkSize);
    onProgress?.(`Extracting signatures... ${Math.min(i + chunkSize, files.length)}/${files.length} files`);
    const results = await Promise.all(
      chunk.map((file) => extractor(path.join(ctx.rootDir, file), file).catch(() => [] as SnapshotEntry[])),
    );
    for (const entries of results) allEntries.push(...entries);
  }

  if (ctx.secondaryLanguages && customPaths.length === 0) {
    // Collect all secondary language configs, then run a single combined glob
    // to avoid multiple directory traversals
    const secConfigs = ctx.secondaryLanguages.map((secLang) => ({
      lang: secLang,
      scanPaths: getDefaultScanPathsForLanguage(secLang, ctx),
      ...getLanguageConfig(secLang),
    }));

    // Build combined patterns and merged ignore list
    const combinedPatterns: string[] = [];
    const combinedIgnore = [...ignorePatterns];
    for (const cfg of secConfigs) {
      for (const p of cfg.scanPaths) combinedPatterns.push(`${p}/${cfg.glob}`);
      combinedIgnore.push(...cfg.ignore);
    }

    if (combinedPatterns.length > 0) {
      let allSecFiles: string[];
      try {
        allSecFiles = await glob(combinedPatterns, {
          cwd: ctx.rootDir,
          ignore: [...new Set(combinedIgnore)],
          absolute: false,
        });
      } catch {
        allSecFiles = [];
      }

      // Partition results by extension back to their language extractor
      const extToConfig = new Map<string, (typeof secConfigs)[number]>();
      for (const cfg of secConfigs) {
        // Extract extensions from glob pattern (e.g., "**/*.py" -> ".py")
        const extMatch = cfg.glob.match(/\*\.(\w+)$/);
        if (extMatch) extToConfig.set(`.${extMatch[1]}`, cfg);
      }

      const filesByLang = new Map<Language, string[]>();
      for (const file of allSecFiles) {
        const ext = path.extname(file).toLowerCase();
        const cfg = extToConfig.get(ext);
        if (cfg) {
          const existing = filesByLang.get(cfg.lang) ?? [];
          existing.push(file);
          filesByLang.set(cfg.lang, existing);
        }
      }

      for (const cfg of secConfigs) {
        const secFiles = filesByLang.get(cfg.lang) ?? [];
        if (secFiles.length === 0) continue;
        onProgress?.(`Scanning ${secFiles.length} ${cfg.lang} files...`);
        for (let si = 0; si < secFiles.length; si += chunkSize) {
          const secChunk = secFiles.slice(si, si + chunkSize);
          const secResults = await Promise.all(
            secChunk.map((file) =>
              cfg.extractor(path.join(ctx.rootDir, file), file).catch(() => [] as SnapshotEntry[]),
            ),
          );
          for (const entries of secResults) allEntries.push(...entries);
        }
      }
    }
  }

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

  onProgress?.("Filtering dead exports...");
  const liveEntries = isLibrary ? allEntries : filterDeadExports(allEntries, graph);

  const MAX_SNAPSHOT_TOKENS = 20000;
  const BASE_TOKENS = 4000;
  const TOKENS_PER_SQRT_FILE = 400;
  const budget =
    maxTokens ??
    Math.min(MAX_SNAPSHOT_TOKENS, BASE_TOKENS + Math.floor(Math.sqrt(ctx.sourceFileCount) * TOKENS_PER_SQRT_FILE));
  onProgress?.(`Applying token budget (${budget.toLocaleString()} tokens)...`);
  const { selected, excluded } = applyTokenBudget(liveEntries, budget, graph, gitActivity);

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

function extractNameFromSignature(sig: string): string | null {
  const jsMatch = sig.match(
    /export\s+(?:default\s+)?(?:async\s+)?(?:interface|type|function|const|let|var|class|enum)\s+(\w+)/,
  );
  if (jsMatch) return jsMatch[1];

  const pyMatch = sig.match(/(?:class|(?:async\s+)?def)\s+(\w+)/);
  if (pyMatch) return pyMatch[1];

  const goTypeMatch = sig.match(/^type\s+(\w+)/);
  if (goTypeMatch) return goTypeMatch[1];
  const goFuncMatch = sig.match(/^func\s+(?:\([^)]+\)\s+)?(\w+)/);
  if (goFuncMatch) return goFuncMatch[1];

  const rustMatch = sig.match(/^pub(?:\(crate\))?\s+(?:async\s+)?(?:struct|enum|trait|fn|type)\s+(\w+)/);
  if (rustMatch) return rustMatch[1];

  const javaMatch = sig.match(
    /public\s+(?:static\s+|abstract\s+|final\s+)?(?:class|interface|enum|record|\S+)\s+(\w+)/,
  );
  if (javaMatch) return javaMatch[1];

  return null;
}

function isEntryPoint(filePath: string): boolean {
  return ENTRY_POINT_PATTERNS.some((p) => p.test(filePath));
}

function filterDeadExports(entries: SnapshotEntry[], graph?: ImportGraph): SnapshotEntry[] {
  if (!graph || graph.edges.length === 0) return entries;

  const usedExports = findUsedExports(graph.edges);

  return entries.filter((entry) => {
    if (isEntryPoint(entry.file)) return true;

    const name = extractNameFromSignature(entry.signature);
    if (!name) return true; // Can't determine name, keep it

    if (usedExports.has(`${entry.file}::${name}`)) return true;
    // Fallback: barrel re-exports with aliases (e.g., `export { default as Foo }`)
    // register "default" in usedExports, so check that too
    if (usedExports.has(`${entry.file}::default`)) return true;
    return false;
  });
}

/**
 * Greedy knapsack: prioritize entries by centrality-weighted value per token.
 * Uses pre-sorted entries with a deferred list for diversity-discounted items
 * to avoid O(n^2) rescanning.
 */
function applyTokenBudget(
  entries: SnapshotEntry[],
  budget: number,
  graph?: ImportGraph,
  gitActivity?: GitAnalysis | null,
): { selected: SnapshotEntry[]; excluded: number } {
  if (entries.length === 0) return { selected: [], excluded: 0 };

  // Per-entry markdown overhead: annotation line (~10 tokens), inter-entry
  // newlines (~2 tokens), proportional share of section header + fence (~5 tokens)
  const MARKDOWN_OVERHEAD_PER_ENTRY = 17;

  const scored = entries.map((entry) => {
    const tokens = Math.max(1, estimateTokens(entry.signature) + MARKDOWN_OVERHEAD_PER_ENTRY);
    const centrality = graph?.centrality.get(entry.file) ?? 0.5;

    // Category boost: types/interfaces are more valuable for context
    let categoryBoost = 1.0;
    if (entry.category === "type" || entry.category === "interface") categoryBoost = 1.3;

    // Git boost: logarithmic scale so 100 commits scores higher than 20
    let gitBoost = 1.0;
    if (gitActivity) {
      const commits = gitActivity.commitCounts.get(entry.file) ?? 0;
      if (commits > 0) {
        const GIT_BOOST_FACTOR = 0.15;
        gitBoost = 1.0 + Math.log2(commits + 1) * GIT_BOOST_FACTOR;
      }
    }

    const value = (centrality * categoryBoost * gitBoost) / tokens;
    return { entry, tokens, value };
  });

  // Pre-sort by base value descending (alphabetical tiebreaker for determinism)
  scored.sort((a, b) => b.value - a.value || a.entry.file.localeCompare(b.entry.file));

  // Submodular greedy selection with diversity discount:
  // Walk the sorted list once. When an entry's file is already selected,
  // apply 0.5 discount and defer it. Process deferred entries when they
  // would beat the next unvisited entry.
  let remaining = budget;
  const selected: SnapshotEntry[] = [];
  const selectedFiles = new Set<string>();
  const deferred: Array<{ entry: SnapshotEntry; tokens: number; value: number }> = [];
  let mainIdx = 0;

  while (remaining > 0) {
    // Advance past entries that are too large
    while (mainIdx < scored.length && scored[mainIdx].tokens > remaining) mainIdx++;

    const mainCandidate = mainIdx < scored.length ? scored[mainIdx] : null;
    const mainValue = mainCandidate
      ? selectedFiles.has(mainCandidate.entry.file)
        ? mainCandidate.value * 0.5
        : mainCandidate.value
      : -1;

    // Check deferred list for a better candidate
    let bestDeferredIdx = -1;
    let bestDeferredValue = -1;
    for (let d = 0; d < deferred.length; d++) {
      if (deferred[d].tokens > remaining) continue;
      if (deferred[d].value > bestDeferredValue) {
        bestDeferredValue = deferred[d].value;
        bestDeferredIdx = d;
      }
    }

    if (mainValue < 0 && bestDeferredIdx < 0) break;

    if (bestDeferredValue > mainValue && bestDeferredIdx >= 0) {
      // Take from deferred
      const item = deferred[bestDeferredIdx];
      selected.push(item.entry);
      remaining -= item.tokens;
      selectedFiles.add(item.entry.file);
      deferred.splice(bestDeferredIdx, 1);
    } else if (mainCandidate) {
      // Take from main list
      if (selectedFiles.has(mainCandidate.entry.file)) {
        // Needs discount: defer it with discounted value
        deferred.push({
          entry: mainCandidate.entry,
          tokens: mainCandidate.tokens,
          value: mainCandidate.value * 0.5,
        });
      } else {
        selected.push(mainCandidate.entry);
        remaining -= mainCandidate.tokens;
        selectedFiles.add(mainCandidate.entry.file);
      }
      mainIdx++;
    } else {
      break;
    }
  }

  return {
    selected,
    excluded: entries.length - selected.length,
  };
}
