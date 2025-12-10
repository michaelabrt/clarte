import type { Chokepoint, ImportGraph } from "../types.js";

/**
 * Find articulation points (chokepoints) in the import graph using
 * Tarjan's algorithm. These are files whose removal would disconnect
 * parts of the codebase.
 *
 * Runs in O(V + E), same complexity as SCC detection.
 */
export function findChokepoints(graph: ImportGraph): Chokepoint[] {
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  if (allFiles.size === 0) return [];

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const articulationPoints = new Set<string>();
  let timer = 0;

  // Iterative articulation point detection using an explicit call stack.
  // Each frame stores the current node, its neighbor list as an array,
  // the iteration index into that list, and the tree-child count.
  const callStack: Array<{
    u: string;
    neighbors: string[];
    neighborIdx: number;
    childCount: number;
  }> = [];

  // Run DFS from each unvisited node (handles disconnected components)
  const sortedFiles = [...allFiles].sort();
  for (const file of sortedFiles) {
    if (disc.has(file)) continue;

    parent.set(file, null);
    disc.set(file, timer);
    low.set(file, timer);
    timer++;
    callStack.push({
      u: file,
      neighbors: [...(adj.get(file) ?? [])],
      neighborIdx: 0,
      childCount: 0,
    });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;

      if (frame.neighborIdx < frame.neighbors.length) {
        const v = frame.neighbors[frame.neighborIdx]!;
        frame.neighborIdx++;

        if (!disc.has(v)) {
          frame.childCount++;
          parent.set(v, frame.u);
          disc.set(v, timer);
          low.set(v, timer);
          timer++;
          // "Recurse" into v: push a new frame
          callStack.push({
            u: v,
            neighbors: [...(adj.get(v) ?? [])],
            neighborIdx: 0,
            childCount: 0,
          });
        } else if (v !== parent.get(frame.u)) {
          low.set(frame.u, Math.min(low.get(frame.u)!, disc.get(v)!));
        }
      } else {
        // All neighbors processed: pop frame and update parent
        callStack.pop();

        if (callStack.length > 0) {
          const parentFrame = callStack[callStack.length - 1]!;
          low.set(parentFrame.u, Math.min(low.get(parentFrame.u)!, low.get(frame.u)!));

          // Root with 2+ children
          if (parent.get(parentFrame.u) == null && parentFrame.childCount > 1) {
            articulationPoints.add(parentFrame.u);
          }
          // Non-root where no back edge from subtree reaches above u
          if (parent.get(parentFrame.u) != null && low.get(frame.u)! >= disc.get(parentFrame.u)!) {
            articulationPoints.add(parentFrame.u);
          }
        }
      }
    }
  }

  const results: Chokepoint[] = [];
  for (const cp of articulationPoints) {
    const { componentCount, disconnected } = analyzeComponentsWithout(adj, allFiles, cp);
    results.push({
      file: cp,
      separates: componentCount,
      importedBy: graph.inDegree.get(cp) ?? 0,
      dependents: disconnected.slice(0, 10), // Cap at 10 for context size
    });
  }

  results.sort((a, b) => b.separates - a.separates || b.importedBy - a.importedBy || a.file.localeCompare(b.file));
  return results;
}

/**
 * Analyze the graph after removing a node: count components and find
 * files disconnected from the largest remaining component.
 */
function analyzeComponentsWithout(
  adj: Map<string, Set<string>>,
  allFiles: Set<string>,
  removed: string,
): { componentCount: number; disconnected: string[] } {
  const visited = new Set<string>();
  visited.add(removed);
  const componentMembers: string[][] = [];

  for (const file of allFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    let qHead = 0;
    visited.add(file);
    while (qHead < queue.length) {
      const current = queue[qHead++];
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    componentMembers.push(component);
  }

  componentMembers.sort((a, b) => b.length - a.length);
  const disconnected: string[] = [];
  for (let i = 1; i < componentMembers.length; i++) {
    disconnected.push(...componentMembers[i]);
  }
  disconnected.sort();

  return { componentCount: componentMembers.length, disconnected };
}
