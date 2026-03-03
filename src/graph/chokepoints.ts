import type { Chokepoint, ImportGraph } from "../types.js";

/**
 * Find chokepoints in the import graph using directed reachability metrics.
 *
 * A chokepoint is a file with:
 * - upstreamCount >= ceil(sqrt(N)) where N = internal file count (scales with project size)
 * - downstreamCount >= 1 (it bridges upstream files to at least 1 dependency)
 *
 * Runs in O(C * (V+E)) where C = files with inDegree >= 1.
 */
export function findChokepoints(graph: ImportGraph): Chokepoint[] {
  const forward = new Map<string, Set<string>>();
  const reverse = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);
    if (!forward.has(edge.from)) forward.set(edge.from, new Set());
    if (!reverse.has(edge.to)) reverse.set(edge.to, new Set());
    forward.get(edge.from)!.add(edge.to);
    reverse.get(edge.to)!.add(edge.from);
  }

  if (allFiles.size === 0) return [];

  const minUpstream = Math.max(2, Math.ceil(Math.sqrt(allFiles.size)));

  const results: Chokepoint[] = [];
  for (const file of allFiles) {
    if ((graph.inDegree.get(file) ?? 0) < 1) continue;
    const upstreamCount = bfsCount(file, reverse);
    if (upstreamCount < minUpstream) continue;
    const downstreamCount = bfsCount(file, forward);
    if (downstreamCount < 1) continue;

    const directDeps = [...(reverse.get(file) ?? [])].sort();
    results.push({
      file,
      importedBy: graph.inDegree.get(file) ?? 0,
      upstreamCount,
      downstreamCount,
      dependents: directDeps.slice(0, 10),
    });
  }

  // Henry-Kafura scoring: rank by upstream * downstream product.
  // This favors files that bridge many dependents TO many dependencies (true bottlenecks)
  // over files that are lopsided (e.g. 100 upstream, 1 downstream).
  results.sort(
    (a, b) => b.upstreamCount * b.downstreamCount - a.upstreamCount * a.downstreamCount || a.file.localeCompare(b.file),
  );
  return results;
}

function bfsCount(start: string, adj: Map<string, Set<string>>): number {
  const visited = new Set<string>([start]);
  const queue = [start];
  let qHead = 0;
  while (qHead < queue.length) {
    for (const neighbor of adj.get(queue[qHead++]!) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        queue.push(neighbor);
      }
    }
  }
  return visited.size - 1;
}
