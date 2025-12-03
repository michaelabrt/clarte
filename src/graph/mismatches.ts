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

  // Cache BFS results to avoid redundant traversals for the same source node
  const distCache = new Map<string, Map<string, number>>();

  const bfsDistance = (from: string, to: string): number => {
    if (from === to) return 0;
    if (!adj.has(from) || !adj.has(to)) return -1;

    // Check cache
    const cached = distCache.get(from)?.get(to) ?? distCache.get(to)?.get(from);
    if (cached !== undefined) return cached;

    const visited = new Set<string>();
    const distances = new Map<string, number>();
    const queue: string[] = [from];
    let qHead = 0;
    visited.add(from);
    distances.set(from, 0);

    while (qHead < queue.length) {
      const node = queue[qHead++];
      const dist = distances.get(node)!;
      for (const neighbor of adj.get(node) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          distances.set(neighbor, dist + 1);
          queue.push(neighbor);
        }
      }
    }

    // Cache all distances from this source
    distCache.set(from, distances);
    return distances.get(to) ?? -1;
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
