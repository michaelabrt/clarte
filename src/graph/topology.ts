import type { GraphTopology, ImportGraph } from "../types.js";

/**
 * Compute graph topology metrics: connected components, approximate diameter,
 * and reachability. Helps LLMs understand whether a project has independent
 * subsystems or is a tightly connected monolith.
 */
export function computeGraphTopology(graph: ImportGraph): GraphTopology {
  // Build undirected adjacency from internal edges
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

  const totalFiles = allFiles.size;
  if (totalFiles === 0) {
    return { componentCount: 0, componentSizes: [], approximateDiameter: 0, reachability: 0, isFragmented: false };
  }

  // 1. Find connected components via BFS
  const visited = new Set<string>();
  const components: string[][] = [];

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
    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const componentSizes = components.map((c) => c.length);

  // 2. Approximate diameter of the largest component using multi-source BFS
  const largest = components[0];
  let approximateDiameter = 0;

  if (largest.length > 1) {
    // Sample up to 3 nodes deterministically (first, middle, last)
    const samples = [largest[0], largest[Math.floor(largest.length / 2)], largest[largest.length - 1]];

    for (const start of samples) {
      // BFS to find max distance from start
      const dist = new Map<string, number>();
      dist.set(start, 0);
      const bfsQueue = [start];
      let bfsHead = 0;
      let maxDist = 0;

      while (bfsHead < bfsQueue.length) {
        const current = bfsQueue[bfsHead++]!;
        const d = dist.get(current)!;
        for (const neighbor of adj.get(current) ?? []) {
          if (!dist.has(neighbor)) {
            const nd = d + 1;
            dist.set(neighbor, nd);
            if (nd > maxDist) maxDist = nd;
            bfsQueue.push(neighbor);
          }
        }
      }

      if (maxDist > approximateDiameter) approximateDiameter = maxDist;
    }
  }

  // 3. Reachability: fraction of files in the largest component
  const reachability = totalFiles > 0 ? largest.length / totalFiles : 0;

  // 4. Fragmentation: more than one component with 5+ files
  const isFragmented = components.length > 1 && components[1].length >= 5;

  return { componentCount: components.length, componentSizes, approximateDiameter, reachability, isFragmented };
}
