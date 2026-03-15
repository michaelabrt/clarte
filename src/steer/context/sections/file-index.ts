import type { ContextSection, ImportGraph } from "../../../core/types.js";
import { estimateTokens, isTestFile } from "../../../core/utils.js";

/** Maximum named exports to show per file before truncating with "..." */
const MAX_EXPORTS_PER_FILE = 5;

interface FileExportEntry {
  path: string;
  /** Export names sorted by import frequency (descending) */
  names: string[];
}

/**
 * Collect imported names per file from graph edges.
 * For each file, counts how many times each name is imported by other files,
 * then returns the top names sorted by frequency.
 */
function collectImportedNames(graph: ImportGraph): FileExportEntry[] {
  // Map: file -> (name -> count of files importing that name)
  const fileNameCounts = new Map<string, Map<string, number>>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (edge.importedNames.length === 0) continue;

    let nameCounts = fileNameCounts.get(edge.to);
    if (!nameCounts) {
      nameCounts = new Map();
      fileNameCounts.set(edge.to, nameCounts);
    }

    for (const name of edge.importedNames) {
      nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
    }
  }

  const entries: FileExportEntry[] = [];
  for (const [filePath, nameCounts] of fileNameCounts) {
    const sorted = [...nameCounts.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name);
    entries.push({ path: filePath, names: sorted });
  }

  return entries;
}

/**
 * Render a compact file index section showing each file's top exports.
 * Pure navigation aid: "what does each file export that other files use?"
 */
export function renderFileIndexSection(graph: ImportGraph): ContextSection | null {
  const entries = collectImportedNames(graph);

  // Filter out test files, barrel files, and fixture files
  const barrels = graph.barrelFiles ?? new Set<string>();
  const filtered = entries.filter((e) => {
    if (isTestFile(e.path)) return false;
    if (barrels.has(e.path)) return false;
    if (/\bfixtures?\b/.test(e.path)) return false;
    return true;
  });

  if (filtered.length === 0) return null;

  // Sort by directory path for scanability
  filtered.sort((a, b) => a.path.localeCompare(b.path));

  const lines: string[] = [];
  lines.push("## File Index");
  lines.push("");
  lines.push("| File | Exports |");
  lines.push("|------|---------|");

  for (const entry of filtered) {
    const shown = entry.names.slice(0, MAX_EXPORTS_PER_FILE);
    const suffix = entry.names.length > MAX_EXPORTS_PER_FILE ? ", ..." : "";
    lines.push(`| \`${entry.path}\` | ${shown.join(", ")}${suffix} |`);
  }

  const content = lines.join("\n");
  return { id: "file-index", priority: 2, content, tokens: estimateTokens(content) };
}
