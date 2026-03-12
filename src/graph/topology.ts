import type { GraphTopology, ImportGraph } from "../types.js";
import { findSCCsFromAdj } from "./scc.js";
import { FRAGMENT_MIN_SIZE } from "../config/thresholds.js";

/**
 * Compute graph topology metrics: connected components, approximate diameter,
 * reachability, critical chain length and modularity Q.
 */
export function computeGraphTopology(graph: ImportGraph): GraphTopology {
  const adj = new Map<string, Set<string>>();
  const dirAdj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    // Undirected adjacency (for components, diameter, modularity)
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);

    // Directed adjacency (for critical chain)
    if (!dirAdj.has(edge.from)) dirAdj.set(edge.from, new Set());
    dirAdj.get(edge.from)?.add(edge.to);
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
  const isFragmented = components.length > 1 && components[1].length >= FRAGMENT_MIN_SIZE;

  // 3. Critical chain length: longest directed path after SCC condensation
  const criticalChainLength = computeCriticalChain(allFiles, dirAdj);

  // 4. Newman's modularity Q using directory-based partitioning
  const modularityQ = computeModularityQ(allFiles, adj);

  return {
    componentCount: components.length,
    componentSizes,
    approximateDiameter,
    reachability,
    isFragmented,
    criticalChainLength,
    modularityQ,
  };
}

/**
 * Compute the longest directed path after collapsing SCCs to single nodes.
 * Uses iterative Tarjan for SCC detection, then topological sort + DP on the
 * condensation DAG. O(V + E).
 */
function computeCriticalChain(allFiles: Set<string>, dirAdj: Map<string, Set<string>>): number {
  if (allFiles.size === 0) return 0;

  // Pre-compute neighbor arrays for the shared SCC algorithm
  const neighborArrays = new Map<string, string[]>();
  for (const file of allFiles) {
    neighborArrays.set(file, [...(dirAdj.get(file) ?? [])]);
  }

  const sccs = findSCCsFromAdj(allFiles, neighborArrays);

  // Build condensation DAG
  const fileToSCC = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const file of sccs[i]) fileToSCC.set(file, i);
  }

  const sccAdj = new Map<number, Set<number>>();
  const sccInDeg = new Map<number, number>();
  for (let i = 0; i < sccs.length; i++) {
    sccAdj.set(i, new Set());
    sccInDeg.set(i, 0);
  }

  for (const [from, neighbors] of dirAdj) {
    const fromSCC = fileToSCC.get(from);
    if (fromSCC === undefined) continue;
    for (const to of neighbors) {
      const toSCC = fileToSCC.get(to);
      if (toSCC === undefined || toSCC === fromSCC) continue;
      if (!sccAdj.get(fromSCC)?.has(toSCC)) {
        sccAdj.get(fromSCC)?.add(toSCC);
        sccInDeg.set(toSCC, sccInDeg.get(toSCC)! + 1);
      }
    }
  }

  // Topological sort + DP longest path
  const dist = new Map<number, number>();
  const queue: number[] = [];
  for (let i = 0; i < sccs.length; i++) {
    dist.set(i, 0);
    if (sccInDeg.get(i)! === 0) queue.push(i);
  }

  let qHead = 0;
  let maxDist = 0;
  while (qHead < queue.length) {
    const u = queue[qHead++];
    const du = dist.get(u)!;
    for (const v of sccAdj.get(u)!) {
      const newDist = du + 1;
      if (newDist > dist.get(v)!) dist.set(v, newDist);
      sccInDeg.set(v, sccInDeg.get(v)! - 1);
      if (sccInDeg.get(v)! === 0) queue.push(v);
    }
    if (du > maxDist) maxDist = du;
  }

  return maxDist;
}

/**
 * Compute Newman's modularity Q using directory-based partitioning.
 * Q = sum_c [ e_c/m - (a_c/(2m))^2 ]
 * where e_c = internal edges in community c, a_c = sum of degrees, m = total edges.
 * Returns 0 for graphs with no edges. Typical well-structured projects score 0.3-0.7.
 */
function computeModularityQ(allFiles: Set<string>, adj: Map<string, Set<string>>): number {
  if (allFiles.size === 0) return 0;

  // Directory-based community assignment
  const community = new Map<string, string>();
  for (const file of allFiles) {
    const parts = file.split("/");
    community.set(file, parts.length > 1 ? parts.slice(0, -1).join("/") : ".");
  }

  // Total edges (undirected: sum of degrees / 2)
  let totalDegree = 0;
  for (const file of allFiles) {
    totalDegree += adj.get(file)?.size ?? 0;
  }
  const m = totalDegree / 2;
  if (m === 0) return 0;

  // Group files by community
  const groups = new Map<string, string[]>();
  for (const file of allFiles) {
    const c = community.get(file)!;
    const group = groups.get(c) ?? [];
    group.push(file);
    groups.set(c, group);
  }

  // Q = sum_c [ e_c/m - (a_c/(2m))^2 ]
  let q = 0;
  for (const members of groups.values()) {
    const memberSet = new Set(members);
    let internalEdges = 0;
    let ac = 0;

    for (const file of members) {
      const neighbors = adj.get(file);
      if (!neighbors) continue;
      ac += neighbors.size;
      for (const nb of neighbors) {
        if (memberSet.has(nb)) internalEdges++;
      }
    }
    // Each internal edge counted from both endpoints
    internalEdges /= 2;

    q += internalEdges / m - (ac / (2 * m)) ** 2;
  }

  return q;
}
