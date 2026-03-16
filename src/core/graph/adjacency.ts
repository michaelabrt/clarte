import type { ImportEdge } from "../types.js";

export interface AdjacencyOptions {
  /** Build directed adjacency (default: true). When false, adds both directions. */
  directed?: boolean;
  /** Include external edges (default: false). */
  includeExternal?: boolean;
  /** Custom weight function per edge (default: 1). */
  weightFn?: (edge: ImportEdge) => number;
}

/**
 * Build a weighted adjacency map from import edges.
 * Returns Map<source, Map<target, weight>> where weight is summed across
 * duplicate edges (multiple imports from A to B).
 */
export function buildAdjacencyMap(edges: ImportEdge[], opts?: AdjacencyOptions): Map<string, Map<string, number>> {
  const directed = opts?.directed ?? true;
  const includeExternal = opts?.includeExternal ?? false;
  const weightFn = opts?.weightFn ?? (() => 1);

  const adj = new Map<string, Map<string, number>>();

  const addEdge = (from: string, to: string, weight: number): void => {
    let neighbors = adj.get(from);
    if (!neighbors) {
      neighbors = new Map();
      adj.set(from, neighbors);
    }
    neighbors.set(to, (neighbors.get(to) ?? 0) + weight);
  };

  for (const edge of edges) {
    if (!includeExternal && edge.isExternal) continue;
    const w = weightFn(edge);
    addEdge(edge.from, edge.to, w);
    if (!directed) {
      addEdge(edge.to, edge.from, w);
    }
    // Ensure both nodes exist in the map even if they have no outgoing edges
    if (!adj.has(edge.to)) adj.set(edge.to, new Map());
    if (!directed && !adj.has(edge.from)) adj.set(edge.from, new Map());
  }

  return adj;
}
