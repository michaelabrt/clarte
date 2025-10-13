import type {
  ContextAnalysis,
  CodeSnapshot,
  DetectedContext,
  GeneratedFile,
  HubFile,
  ImportGraph,
  UserAnswers,
} from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

/** Tiered context output: a root file plus per-directory context files */
export interface ContextTier {
  /** The root-level context file (project overview, links to directory files) */
  root: GeneratedFile;
  /** Per-directory context files placed in .clarte/context/ */
  directories: GeneratedFile[];
  /** Token budget allocation */
  tokenBudget: { root: number; perDirectory: number };
}

// ── Thresholds ───────────────────────────────────────────────────────────────

/** Minimum source files before context splitting is considered */
const MIN_SOURCE_FILES = 150;

/** Minimum estimated tokens before context splitting is considered */
const MIN_TOTAL_TOKENS = 8000;

/** Minimum files in a directory to get its own context file */
const MIN_DIR_FILES = 5;

/** Target token budget for the root context file */
const ROOT_TOKEN_BUDGET = 2000;

/** Target token budget per directory context file */
const DIR_TOKEN_BUDGET = 2000;

/** Maximum hub files to show per directory */
const MAX_DIR_HUB_FILES = 5;

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Determine whether context should be split into tiered files.
 * Returns true when the project is large enough to benefit from splitting:
 * either sourceFileCount > 150 or the estimated total context tokens > 8000.
 * Monorepo projects are excluded (they already get per-package context).
 */
export function shouldSplitContext(
  ctx: DetectedContext,
  estimatedTokens: number,
): boolean {
  // Monorepos already have per-package context generation
  if (ctx.monorepo) return false;

  return ctx.sourceFileCount > MIN_SOURCE_FILES || estimatedTokens > MIN_TOTAL_TOKENS;
}

/**
 * Group source files by their top-level directory relative to the project root.
 * Only includes directories with MIN_DIR_FILES or more source files.
 *
 * Returns a map of directory path (e.g. "src/components") to file paths.
 */
export function computeDirectoryBudgets(
  ctx: DetectedContext,
  graph: ImportGraph,
  _analysis: ContextAnalysis,
): Map<string, string[]> {
  const dirFiles = new Map<string, string[]>();

  // Collect all internal files from the import graph
  const allFiles = new Set<string>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      allFiles.add(edge.from);
      allFiles.add(edge.to);
    }
  }

  // Group files by their first two path segments (e.g. "src/components")
  // or their first segment if only one level deep
  for (const filePath of allFiles) {
    const dir = getGroupingDirectory(filePath);
    if (!dir) continue;

    const files = dirFiles.get(dir) ?? [];
    files.push(filePath);
    dirFiles.set(dir, files);
  }

  // Filter to directories with enough files
  const result = new Map<string, string[]>();
  for (const [dir, files] of dirFiles) {
    if (files.length >= MIN_DIR_FILES) {
      result.set(dir, files);
    }
  }

  return result;
}

/**
 * Build markdown content for a single directory's context file.
 */
export function buildDirectoryContext(
  dirPath: string,
  dirFiles: string[],
  ctx: DetectedContext,
  graph: ImportGraph,
  analysis: ContextAnalysis,
  _answers: UserAnswers,
): string {
  const lines: string[] = [];
  const dirName = dirPath.split("/").pop() ?? dirPath;

  lines.push(`# ${dirName}/`);
  lines.push("");
  lines.push(`> Local context for \`${dirPath}/\`. See the root context file for project-wide architecture.`);
  lines.push("");

  // Local hub files (highest authority within this directory)
  const localHubs = getLocalHubFiles(dirFiles, graph, MAX_DIR_HUB_FILES);
  if (localHubs.length > 0) {
    lines.push("## Key Files");
    lines.push("");
    lines.push("| File | Imported By | Role |");
    lines.push("|------|------------|------|");
    for (const hub of localHubs) {
      lines.push(`| \`${hub.path}\` | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${hub.role} |`);
    }
    lines.push("");
  }

  // Local dependency patterns: what this directory imports from and exports to
  const depPatterns = getDirectoryDependencyPatterns(dirPath, dirFiles, graph);
  if (depPatterns.imports.length > 0 || depPatterns.exports.length > 0) {
    lines.push("## Dependencies");
    lines.push("");
    if (depPatterns.imports.length > 0) {
      lines.push("**Imports from:** " + depPatterns.imports.map((d) => `\`${d}\``).join(", "));
    }
    if (depPatterns.exports.length > 0) {
      lines.push("");
      lines.push("**Depended on by:** " + depPatterns.exports.map((d) => `\`${d}\``).join(", "));
    }
    lines.push("");
  }

  // Test mapping for files in this directory
  if (analysis.testMapping) {
    const localTests = getLocalTestMapping(dirFiles, analysis);
    if (localTests.tested.length > 0 || localTests.untested.length > 0) {
      lines.push("## Test Coverage");
      lines.push("");
      if (localTests.tested.length > 0) {
        lines.push(`${localTests.tested.length} file${localTests.tested.length === 1 ? "" : "s"} with tests.`);
      }
      if (localTests.untested.length > 0) {
        lines.push("");
        lines.push("**Untested files:**");
        for (const f of localTests.untested.slice(0, 10)) {
          lines.push(`- \`${f}\``);
        }
        if (localTests.untested.length > 10) {
          lines.push(`- ... and ${localTests.untested.length - 10} more`);
        }
      }
      lines.push("");
    }
  }

  // Related directories directive
  const related = getRelatedDirectories(dirPath, dirFiles, graph);
  if (related.length > 0) {
    lines.push("## Related");
    lines.push("");
    lines.push(
      `When working in this directory, also check: ${related.map((d) => `\`${d}/\``).join(", ")}`,
    );
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}

/**
 * Orchestrate full tiered context generation.
 * Builds a slimmed-down root context file and per-directory context files.
 */
export function buildTieredContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis: ContextAnalysis,
  graph: ImportGraph,
  rootContent: string,
): ContextTier {
  const dirMap = computeDirectoryBudgets(ctx, graph, analysis);

  // Build directory context files
  const directoryFiles: GeneratedFile[] = [];
  for (const [dirPath, dirFiles] of dirMap) {
    const content = buildDirectoryContext(dirPath, dirFiles, ctx, graph, analysis, answers);
    const safeName = dirPath.replace(/\//g, "-");
    directoryFiles.push({
      path: `.clarte/context/${safeName}.md`,
      content,
      existed: false, // Will be updated by the caller
    });
  }

  // Append directory links to the root content
  let augmentedRoot = rootContent;
  if (directoryFiles.length > 0) {
    const linkLines: string[] = [];
    linkLines.push("");
    linkLines.push("## Directory Context");
    linkLines.push("");
    linkLines.push("For deeper context when working in a specific directory, see:");
    linkLines.push("");
    for (const [dirPath] of dirMap) {
      const safeName = dirPath.replace(/\//g, "-");
      linkLines.push(
        `- \`${dirPath}/\`: read \`.clarte/context/${safeName}.md\``,
      );
    }
    linkLines.push("");

    // Insert before the last section or append at end
    augmentedRoot = augmentedRoot.trimEnd() + "\n" + linkLines.join("\n");
  }

  return {
    root: {
      path: "", // Will be set by the caller based on IDE target
      content: augmentedRoot,
      existed: false,
    },
    directories: directoryFiles,
    tokenBudget: {
      root: ROOT_TOKEN_BUDGET,
      perDirectory: DIR_TOKEN_BUDGET,
    },
  };
}

// ── Internal helpers ─────────────────────────────────────────────────────────

/**
 * Get the grouping directory for a file path.
 * Uses the first two segments for deeply nested files (e.g. "src/components"),
 * or the first segment for shallow files.
 */
function getGroupingDirectory(filePath: string): string | null {
  const parts = filePath.split("/");
  if (parts.length <= 1) return null; // Root-level file, no directory grouping

  // Use up to first two directory segments
  if (parts.length >= 3) {
    return parts.slice(0, 2).join("/");
  }
  return parts[0];
}

/**
 * Get hub files local to a specific directory, sorted by authority.
 */
function getLocalHubFiles(
  dirFiles: string[],
  graph: ImportGraph,
  limit: number,
): HubFile[] {
  const dirSet = new Set(dirFiles);
  const hubs: HubFile[] = [];

  for (const filePath of dirFiles) {
    const authority = graph.authority?.get(filePath) ?? graph.centrality.get(filePath) ?? 0;
    const hubScore = graph.hubScores?.get(filePath) ?? 0;
    const importedBy = graph.inDegree.get(filePath) ?? 0;

    // Count outgoing internal imports
    let imports = 0;
    for (const edge of graph.edges) {
      if (edge.from === filePath && !edge.isExternal) {
        imports++;
      }
    }

    if (importedBy > 0 || imports > 0) {
      const role = authority > hubScore ? "Foundation" : hubScore > authority ? "Orchestrator" : "Utility";
      hubs.push({
        path: filePath,
        centrality: authority,
        authority,
        hubScore,
        role,
        importedBy,
        imports,
      });
    }
  }

  hubs.sort((a, b) => Math.max(b.authority, b.hubScore) - Math.max(a.authority, a.hubScore));
  return hubs.slice(0, limit);
}

/**
 * Analyze what directories this directory imports from and is imported by.
 */
function getDirectoryDependencyPatterns(
  dirPath: string,
  dirFiles: string[],
  graph: ImportGraph,
): { imports: string[]; exports: string[] } {
  const dirSet = new Set(dirFiles);
  const importDirs = new Set<string>();
  const exportDirs = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;

    if (dirSet.has(edge.from) && !dirSet.has(edge.to)) {
      // This directory imports from another
      const targetDir = getGroupingDirectory(edge.to);
      if (targetDir && targetDir !== dirPath) {
        importDirs.add(targetDir);
      }
    }

    if (dirSet.has(edge.to) && !dirSet.has(edge.from)) {
      // Another directory imports from this one
      const sourceDir = getGroupingDirectory(edge.from);
      if (sourceDir && sourceDir !== dirPath) {
        exportDirs.add(sourceDir);
      }
    }
  }

  return {
    imports: Array.from(importDirs).sort(),
    exports: Array.from(exportDirs).sort(),
  };
}

/**
 * Get test mapping info for files in a specific directory.
 */
function getLocalTestMapping(
  dirFiles: string[],
  analysis: ContextAnalysis,
): { tested: string[]; untested: string[] } {
  if (!analysis.testMapping) return { tested: [], untested: [] };

  const dirSet = new Set(dirFiles);
  const tested: string[] = [];
  const untested: string[] = [];

  for (const file of dirFiles) {
    const tests = analysis.testMapping.sourceToTests.get(file);
    if (tests && tests.length > 0) {
      tested.push(file);
    }
  }

  for (const file of analysis.testMapping.untestedFiles) {
    if (dirSet.has(file)) {
      untested.push(file);
    }
  }

  return { tested, untested };
}

/**
 * Find directories that are closely related to the given directory
 * (high cross-directory import traffic).
 */
function getRelatedDirectories(
  dirPath: string,
  dirFiles: string[],
  graph: ImportGraph,
): string[] {
  const dirSet = new Set(dirFiles);
  const dirCounts = new Map<string, number>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;

    // Count both directions: imports from and exports to
    if (dirSet.has(edge.from) && !dirSet.has(edge.to)) {
      const targetDir = getGroupingDirectory(edge.to);
      if (targetDir && targetDir !== dirPath) {
        dirCounts.set(targetDir, (dirCounts.get(targetDir) ?? 0) + 1);
      }
    }

    if (dirSet.has(edge.to) && !dirSet.has(edge.from)) {
      const sourceDir = getGroupingDirectory(edge.from);
      if (sourceDir && sourceDir !== dirPath) {
        dirCounts.set(sourceDir, (dirCounts.get(sourceDir) ?? 0) + 1);
      }
    }
  }

  // Sort by interaction count and return top 3
  return Array.from(dirCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([dir]) => dir);
}
