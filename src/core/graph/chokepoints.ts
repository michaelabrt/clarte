import type { Chokepoint, ImportGraph } from "../types";

/**
 * Find chokepoints in the import graph using directed reachability metrics.
 *
 * A chokepoint is a file with:
 * - upstreamCount >= ceil(sqrt(N)) where N = internal file count (scales with project size)
 * - downstreamCount >= 1 (it bridges upstream files to at least 1 dependency)
 *
 * Two-phase approach for scalability:
 * - Phase 1: early-termination BFS identifies candidates (upstream >= threshold).
 *   Non-candidates terminate after visiting O(sqrt(N)) nodes instead of O(V+E).
 * - Phase 2: exact BFS counts only for candidates (typically <5% of files).
 *
 * Worst case remains O(V*(V+E)) but average case is O(V*sqrt(V) + C*(V+E))
 * where C = number of chokepoints.
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
    forward.get(edge.from)?.add(edge.to);
    reverse.get(edge.to)?.add(edge.from);
  }

  if (allFiles.size === 0) return [];

  const minUpstream = Math.max(2, Math.ceil(Math.sqrt(allFiles.size)));

  // Phase 1: identify candidates with early-termination BFS.
  // For non-chokepoints (majority of files), BFS terminates after visiting
  // at most minUpstream nodes instead of the full reachable set.
  const candidates: string[] = [];
  for (const file of allFiles) {
    if ((graph.inDegree.get(file) ?? 0) < 1) continue;
    if (bfsReachability(file, reverse, minUpstream) >= minUpstream) candidates.push(file);
  }

  // Phase 2: exact counts only for candidates
  const results: Chokepoint[] = [];
  for (const file of candidates) {
    const upstreamCount = bfsReachability(file, reverse);
    const downstreamCount = bfsReachability(file, forward);
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

  // Reachability product scoring: rank by upstream * downstream.
  // Favors files that bridge many dependents TO many dependencies (true bottlenecks)
  // over files that are lopsided (e.g. 100 upstream, 1 downstream).
  results.sort(
    (a, b) => b.upstreamCount * b.downstreamCount - a.upstreamCount * a.downstreamCount || a.file.localeCompare(b.file),
  );
  return results;
}

/** BFS reachability count. When earlyTerminate is set, stops as soon as the count is reached. */
function bfsReachability(start: string, adj: Map<string, Set<string>>, earlyTerminate?: number): number {
  const visited = new Set<string>([start]);
  const queue = [start];
  let qHead = 0;
  while (qHead < queue.length) {
    const current = queue[qHead++];
    if (!current) break;
    for (const neighbor of adj.get(current) ?? []) {
      if (!visited.has(neighbor)) {
        visited.add(neighbor);
        if (earlyTerminate !== undefined && visited.size - 1 >= earlyTerminate) return visited.size - 1;
        queue.push(neighbor);
      }
    }
  }
  return visited.size - 1;
}
