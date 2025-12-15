import { deriveRole } from "./centrality.js";
import type { HubFile, ImportEdge, ImportGraph } from "../types.js";

/**
 * Build a set of "filepath::ExportName" pairs that are actually imported
 * somewhere in the project. Used for dead export filtering.
 */
export function findUsedExports(edges: ImportEdge[]): Set<string> {
  const used = new Set<string>();
  for (const edge of edges) {
    if (edge.isExternal) continue;
    for (const name of edge.importedNames) {
      used.add(`${edge.to}::${name}`);
    }
  }
  return used;
}

/**
 * Get the most interconnected files sorted by max(authority, hubScore).
 * Captures both foundations (high authority) and orchestrators (high hub).
 */
export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[] {
  // Count outgoing internal imports per file
  const outCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    }
  }

  // Build list of all files with their scores
  const files: HubFile[] = [];
  for (const [filePath] of graph.centrality) {
    const importedBy = graph.directInDegree?.get(filePath) ?? graph.inDegree.get(filePath) ?? 0;
    const imports = outCount.get(filePath) ?? 0;
    // Only include files that have some connectivity
    if (importedBy > 0 || imports > 0) {
      const authority = graph.authority?.get(filePath) ?? graph.centrality.get(filePath) ?? 0;
      const hubScore = graph.hubScores?.get(filePath) ?? 0;
      const isBarrel = graph.barrelFiles?.has(filePath) ?? false;
      const role = deriveRole(authority, hubScore, isBarrel);
      files.push({
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

  // Sort by max(authority, hubScore) descending -- captures both foundations and orchestrators
  // Alphabetical tiebreaker for deterministic output
  files.sort(
    (a, b) => Math.max(b.authority, b.hubScore) - Math.max(a.authority, a.hubScore) || a.path.localeCompare(b.path),
  );

  return files.slice(0, limit);
}
