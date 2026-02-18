import type { GraphTopology, ImportGraph } from "../types.js";

/**
 * Compute graph topology metrics: connected components, approximate diameter,
 * and reachability. Helps LLMs understand whether a project has independent
 * subsystems or is a tightly connected monolith.
 */
export function computeGraphTopology(graph: ImportGraph): GraphTopology {
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

  // 2. Double-sweep diameter approximation (2-approximation guarantee)
  const largest = components[0];
  let approximateDiameter = 0;

  if (largest.length > 1) {
    // Pass 1: BFS from arbitrary node to find a peripheral node
    let peripheral = largest[0];
    {
      const dist = new Map<string, number>();
      dist.set(largest[0], 0);
      const q = [largest[0]];
      let h = 0;
      let maxDist = 0;
      while (h < q.length) {
        const cur = q[h++]!;
        const d = dist.get(cur)!;
        for (const nb of adj.get(cur) ?? []) {
          if (!dist.has(nb)) {
            const nd = d + 1;
            dist.set(nb, nd);
            if (nd > maxDist) {
              maxDist = nd;
              peripheral = nb;
            }
            q.push(nb);
          }
        }
      }
    }
    // Pass 2: BFS from peripheral; max distance approximates diameter
    {
      const dist = new Map<string, number>();
      dist.set(peripheral, 0);
      const q = [peripheral];
      let h = 0;
      while (h < q.length) {
        const cur = q[h++]!;
        const d = dist.get(cur)!;
        for (const nb of adj.get(cur) ?? []) {
          if (!dist.has(nb)) {
            const nd = d + 1;
            dist.set(nb, nd);
            if (nd > approximateDiameter) approximateDiameter = nd;
            q.push(nb);
          }
        }
      }
    }
  }

  const reachability = totalFiles > 0 ? largest.length / totalFiles : 0;

  // 4. Fragmentation: more than one component with 5+ files
  const isFragmented = components.length > 1 && components[1].length >= 5;

  return { componentCount: components.length, componentSizes, approximateDiameter, reachability, isFragmented };
}
