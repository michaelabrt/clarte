import type { ImportGraph, StructuralTemporalMismatch } from "../types.js";

/**
 * Find file pairs that co-change frequently (high temporal coupling)
 * but are structurally distant in the import graph (no direct or short path).
 *
 * These mismatches suggest hidden dependencies: the files are coupled in
 * practice but the import graph doesn't reflect it. Common causes:
 * - Shared database schema or API contract
 * - Copy-paste duplication
 * - Missing shared module that should be extracted
 */
export function findStructuralTemporalMismatches(
  graph: ImportGraph,
  changeCoupling: Array<{ fileA: string; fileB: string; confidence: number; coChangeCount: number }>,
  minConfidence = 0.4,
  minDistance = 3,
  topN = 10,
): StructuralTemporalMismatch[] {
  if (changeCoupling.length === 0) return [];

  // Build undirected adjacency for BFS distance
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const bfsDistance = (from: string, to: string): number => {
    if (from === to) return 0;
    if (!adj.has(from) || !adj.has(to)) return -1;
    const visited = new Set<string>();
    const queue: Array<{ node: string; dist: number }> = [{ node: from, dist: 0 }];
    let qHead = 0;
    visited.add(from);
    while (qHead < queue.length) {
      const { node, dist } = queue[qHead++];
      for (const neighbor of adj.get(node) ?? []) {
        if (neighbor === to) return dist + 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, dist: dist + 1 });
        }
      }
    }
    return -1; // unreachable
  };

  const results: StructuralTemporalMismatch[] = [];

  for (const pair of changeCoupling) {
    if (pair.confidence < minConfidence) continue;

    const dist = bfsDistance(pair.fileA, pair.fileB);
    if (dist >= minDistance || dist === -1) {
      results.push({
        fileA: pair.fileA,
        fileB: pair.fileB,
        graphDistance: dist,
        coChangeConfidence: pair.confidence,
        coChangeCount: pair.coChangeCount,
      });
    }
  }

  // Sort by confidence descending (strongest hidden coupling first), alphabetical tiebreaker
  results.sort((a, b) => b.coChangeConfidence - a.coChangeConfidence || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB));
  return results.slice(0, topN);
}
