import type { ImportGraph, TightCoupling } from "../types.js";

/**
 * Find file pairs where one file imports many named exports from another,
 * indicating tight coupling. High import specificity means the importing
 * file depends on many implementation details of the imported file.
 *
 * Threshold: 5+ named imports from a single file suggests the importing
 * file may be too tightly coupled and could benefit from an intermediate
 * interface or facade.
 */
export function findTightCouplings(
  graph: ImportGraph,
  minNames = 5,
  topN = 10,
): TightCoupling[] {
  // Aggregate named imports per (from, to) pair
  const pairNames = new Map<string, { from: string; to: string; names: Set<string> }>();

  const barrels = graph.barrelFiles ?? new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal || edge.importedNames.length === 0) continue;
    // Skip barrel files' own re-export edges (not genuine coupling)
    if (barrels.has(edge.from)) continue;
    const key = `${edge.from}->${edge.to}`;
    let entry = pairNames.get(key);
    if (!entry) {
      entry = { from: edge.from, to: edge.to, names: new Set() };
      pairNames.set(key, entry);
    }
    for (const name of edge.importedNames) {
      entry.names.add(name);
    }
  }

  const results: TightCoupling[] = [];

  for (const entry of pairNames.values()) {
    if (entry.names.size >= minNames) {
      results.push({
        from: entry.from,
        to: entry.to,
        importedNames: entry.names.size,
        names: [...entry.names].sort(),
      });
    }
  }

  // Sort by number of imported names descending, alphabetical tiebreaker
  results.sort((a, b) => b.importedNames - a.importedNames || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return results.slice(0, topN);
}
