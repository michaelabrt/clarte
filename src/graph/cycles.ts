import type { CircularDependency, ImportEdge, ImportGraph } from "../types.js";
import { getOrSet } from "../utils.js";
import { findSCCsFromAdj } from "./scc.js";

/**
 * Find all strongly connected components using Tarjan's algorithm.
 * Returns SCCs with size > 1 (i.e. actual cycles).
 */
export function findSCCs(graph: ImportGraph): string[][] {
  const adj = new Map<string, string[]>();
  const allFiles = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  return findSCCsFromAdj(allFiles, adj).filter((scc) => scc.length > 1);
}

/**
 * Detect circular dependencies using Tarjan's SCC algorithm,
 * then extract actual valid cycles via BFS within each SCC.
 * Returns up to maxCycles results, shortest first.
 */
export function findCircularDeps(graph: ImportGraph, maxCycles = 10): CircularDependency[] {
  const sccs = findSCCs(graph);

  // Sort SCCs by size (smallest first, more actionable)
  sccs.sort((a, b) => a.length - b.length);

  const adj = new Map<string, Set<string>>();
  const edgeLookup = new Map<string, ImportEdge>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    getOrSet(adj, edge.from, () => new Set()).add(edge.to);
    // Keep the edge with most imported names (most specific)
    const key = `${edge.from}->${edge.to}`;
    const existing = edgeLookup.get(key);
    if (!existing || edge.importedNames.length > existing.importedNames.length) {
      edgeLookup.set(key, edge);
    }
  }

  const allCycles: CircularDependency[] = [];

  for (const scc of sccs) {
    if (allCycles.length >= maxCycles) break;
    const found = findActualCycles(scc, adj, maxCycles - allCycles.length);
    allCycles.push(...found);
  }

  // Compute severity and break hints for each cycle
  // Severity is a weighted average: type-only edges = 0, dynamic edges = 0.5, static runtime = 1.0
  const shortName = (f: string) =>
    f
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") ?? f;
  for (const cycle of allCycles) {
    const edges: Array<{ from: string; to: string; isTypeOnly: boolean; isDynamic: boolean }> = [];
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}->${cycle.chain[i + 1]}`;
      const e = edgeLookup.get(key);
      edges.push({
        from: cycle.chain[i],
        to: cycle.chain[i + 1],
        isTypeOnly: !!e?.isTypeOnly,
        isDynamic: !!e?.isDynamic,
      });
    }
    const runtimeEdges = edges.filter((e) => !e.isTypeOnly);
    if (edges.length > 0) {
      let weightSum = 0;
      for (const e of edges) {
        if (e.isTypeOnly) weightSum += 0;
        else if (e.isDynamic) weightSum += 0.5;
        else weightSum += 1.0;
      }
      cycle.severity = weightSum / edges.length;
    } else {
      cycle.severity = 0;
    }

    // Break hint: suggest converting the smallest runtime edge to type-only
    if (runtimeEdges.length === 1) {
      const e = runtimeEdges[0];
      cycle.breakHint = `Convert ${shortName(e.from)} -> ${shortName(e.to)} to type-only import`;
    } else if (runtimeEdges.length > 0 && edges.some((e) => e.isTypeOnly)) {
      // Mixed: some already type-only, suggest converting remaining
      cycle.breakHint = `${runtimeEdges.length} of ${edges.length} edges are runtime; convert more to type-only`;
    } else if (runtimeEdges.length > 0) {
      // All runtime: suggest extracting shared types
      const shortest = runtimeEdges.reduce((a, b) => (a.from < b.from ? a : b));
      cycle.breakHint = `Extract shared types from ${shortName(shortest.from)} and ${shortName(shortest.to)}`;
    }
  }

  // Sort: type-only-only cycles last, then by severity desc, then shortest first
  allCycles.sort((a, b) => {
    const sa = a.severity ?? 1;
    const sb = b.severity ?? 1;
    if (sa === 0 && sb > 0) return 1;
    if (sb === 0 && sa > 0) return -1;
    if (sa !== sb) return sb - sa;
    return a.chain.length - b.chain.length;
  });

  return allCycles;
}

/**
 * Find the most impactful edges to break in order to resolve circular dependencies.
 * Uses the Eades-Lin-Smyth (1993) greedy heuristic to compute a linear ordering
 * that minimizes backward edges, then ranks by how many detected cycles each
 * backward edge resolves.
 *
 * The greedy heuristic produces smaller feedback arc sets than DFS back-edge
 * detection because it accounts for the full degree structure of the cycle
 * subgraph rather than depending on arbitrary DFS traversal order.
 *
 * Adaptively returns enough edges to resolve >= 80% of cycles, up to topN.
 *
 * @returns Array of { from, to, cyclesResolved } sorted by impact descending.
 */
export function findFeedbackEdges(
  cycles: CircularDependency[],
  topN = 10,
): Array<{ from: string; to: string; cyclesResolved: number }> {
  if (cycles.length === 0) return [];

  // Build directed adjacency from cycle edges only
  const adj = new Map<string, Set<string>>();
  const revAdj = new Map<string, Set<string>>();
  const allNodes = new Set<string>();

  for (const cycle of cycles) {
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const from = cycle.chain[i];
      const to = cycle.chain[i + 1];
      allNodes.add(from);
      allNodes.add(to);
      getOrSet(adj, from, () => new Set()).add(to);
      getOrSet(revAdj, to, () => new Set()).add(from);
    }
  }

  for (const node of allNodes) {
    if (!adj.has(node)) adj.set(node, new Set());
    if (!revAdj.has(node)) revAdj.set(node, new Set());
  }

  // Eades-Lin-Smyth greedy heuristic: build a linear ordering that maximizes
  // forward edges by repeatedly removing sources (to the left) and sinks
  // (to the right), then greedily picking the node with max (outDeg - inDeg).
  const remaining = new Set(allNodes);
  const outDeg = new Map<string, number>();
  const inDeg = new Map<string, number>();

  for (const node of allNodes) {
    let out = 0;
    for (const nb of adj.get(node)!) {
      if (allNodes.has(nb)) out++;
    }
    outDeg.set(node, out);
    let inp = 0;
    for (const nb of revAdj.get(node)!) {
      if (allNodes.has(nb)) inp++;
    }
    inDeg.set(node, inp);
  }

  const leftSeq: string[] = [];
  const rightSeq: string[] = [];

  const removeNode = (node: string) => {
    remaining.delete(node);
    for (const succ of adj.get(node)!) {
      if (remaining.has(succ)) inDeg.set(succ, inDeg.get(succ)! - 1);
    }
    for (const pred of revAdj.get(node)!) {
      if (remaining.has(pred)) outDeg.set(pred, outDeg.get(pred)! - 1);
    }
  };

  while (remaining.size > 0) {
    // Remove sinks (outDeg == 0) - they go to the right end of the ordering
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of remaining) {
        if (outDeg.get(node)! === 0) {
          rightSeq.push(node);
          removeNode(node);
          changed = true;
        }
      }
    }
    // Remove sources (inDeg == 0) - they go to the left end of the ordering
    changed = true;
    while (changed) {
      changed = false;
      for (const node of remaining) {
        if (inDeg.get(node)! === 0) {
          leftSeq.push(node);
          removeNode(node);
          changed = true;
        }
      }
    }
    // Pick node with max (outDeg - inDeg), deterministic tiebreak
    if (remaining.size > 0) {
      let bestNode = "";
      let bestDelta = -Infinity;
      for (const node of [...remaining].sort()) {
        const delta = outDeg.get(node)! - inDeg.get(node)!;
        if (delta > bestDelta) {
          bestDelta = delta;
          bestNode = node;
        }
      }
      leftSeq.push(bestNode);
      removeNode(bestNode);
    }
  }

  // Build position map: left sequence followed by reversed right sequence
  const ordering = [...leftSeq, ...rightSeq.reverse()];
  const position = new Map<string, number>();
  for (let i = 0; i < ordering.length; i++) {
    position.set(ordering[i], i);
  }

  // Backward edges in the ordering form the feedback arc set
  const backEdges = new Set<string>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const from = cycle.chain[i];
      const to = cycle.chain[i + 1];
      if (position.get(from)! >= position.get(to)!) {
        backEdges.add(`${from}||${to}`);
      }
    }
  }

  // Count how many cycles each backward edge resolves
  const edgeCounts = new Map<string, number>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}||${cycle.chain[i + 1]}`;
      if (backEdges.has(key)) {
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  // Fallback: if no backward edges match detected cycles, count all cycle edges
  if (edgeCounts.size === 0) {
    for (const cycle of cycles) {
      for (let i = 0; i < cycle.chain.length - 1; i++) {
        const key = `${cycle.chain[i]}||${cycle.chain[i + 1]}`;
        edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
      }
    }
  }

  const sorted = [...edgeCounts.entries()].sort((a, b) => b[1] - a[1]);

  // Adaptive: take edges until 80% of cycles are resolved or topN is reached.
  // Build a lookup: for each edge key, which cycle indices does it participate in?
  const edgeToCycles = new Map<string, Set<number>>();
  for (let ci = 0; ci < cycles.length; ci++) {
    for (let i = 0; i < cycles[ci].chain.length - 1; i++) {
      const key = `${cycles[ci].chain[i]}||${cycles[ci].chain[i + 1]}`;
      if (!edgeToCycles.has(key)) edgeToCycles.set(key, new Set());
      edgeToCycles.get(key)!.add(ci);
    }
  }

  const targetResolved = Math.ceil(cycles.length * 0.8);
  const resolvedCycles = new Set<number>();
  const result: Array<{ from: string; to: string; cyclesResolved: number }> = [];

  for (const [key, count] of sorted) {
    if (result.length >= topN) break;
    const [from, to] = key.split("||");
    result.push({ from, to, cyclesResolved: count });
    for (const ci of edgeToCycles.get(key) ?? []) resolvedCycles.add(ci);
    if (resolvedCycles.size >= targetResolved) break;
  }

  return result;
}

/**
 * Canonicalize a cycle by rotating so the lexicographically smallest node is first.
 */
function canonicalizeCycle(cycle: string[]): string {
  // cycle is [a, b, c, a] -- last element duplicates first
  const nodes = cycle.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }
  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  return rotated.join("||");
}

/**
 * Find actual valid cycles within an SCC using BFS.
 * Returns deduplicated cycles sorted by length (shortest first).
 */
function findActualCycles(scc: string[], adj: Map<string, Set<string>>, maxCycles: number): CircularDependency[] {
  const sccSet = new Set(scc);

  const sccAdj = new Map<string, Set<string>>();
  for (const node of scc) {
    const neighbors = adj.get(node);
    if (neighbors) {
      const filtered = new Set<string>();
      for (const n of neighbors) {
        if (sccSet.has(n)) filtered.add(n);
      }
      sccAdj.set(node, filtered);
    } else {
      sccAdj.set(node, new Set());
    }
  }

  const seenCanonical = new Set<string>();
  const cycles: CircularDependency[] = [];

  // 1. Find all mutual imports (2-cycles) first -- most actionable
  const sortedScc = [...scc].sort();
  for (const a of sortedScc) {
    for (const b of sccAdj.get(a) ?? []) {
      if (a < b && (sccAdj.get(b)?.has(a) ?? false)) {
        const chain = [a, b, a];
        const key = canonicalizeCycle(chain);
        if (!seenCanonical.has(key)) {
          seenCanonical.add(key);
          cycles.push({ chain });
          if (cycles.length >= maxCycles) return cycles;
        }
      }
    }
  }

  // 2. BFS shortest cycle through each node
  // Sort by degree descending: high-degree nodes find diverse cycles faster
  const byDegree = [...scc].sort((a, b) => {
    const degA = sccAdj.get(a)?.size ?? 0;
    const degB = sccAdj.get(b)?.size ?? 0;
    return degB - degA;
  });

  for (const start of byDegree) {
    if (cycles.length >= maxCycles) break;

    // BFS from start, looking for path back to start
    // Use parent-pointer map instead of copying path arrays (avoids O(V*E) allocations)
    const parent = new Map<string, string>();
    const depth = new Map<string, number>();
    const queue: string[] = [];

    for (const neighbor of sccAdj.get(start) ?? []) {
      if (!parent.has(neighbor) && neighbor !== start) {
        parent.set(neighbor, start);
        depth.set(neighbor, 1);
        queue.push(neighbor);
      } else if (neighbor === start) {
        // Self-loop; skip (would be a 1-cycle, not meaningful)
      }
    }

    let qi = 0;
    while (qi < queue.length) {
      if (cycles.length >= maxCycles) break;

      const node = queue[qi++];
      const nodeDepth = depth.get(node)!;

      // Cap depth at SCC size to avoid explosion
      if (nodeDepth >= scc.length) continue;

      for (const next of sccAdj.get(node) ?? []) {
        if (next === start) {
          // Found a cycle back to start -- reconstruct via parent pointers
          const reversePath: string[] = [node];
          let rCur = node;
          while (rCur !== start) {
            const p = parent.get(rCur);
            if (p === undefined) break;
            rCur = p;
            if (rCur !== start) reversePath.push(rCur);
          }
          reversePath.reverse();
          const fullChain = [start, ...reversePath, start];

          // Skip 2-cycles (already found above)
          if (fullChain.length > 3) {
            const key = canonicalizeCycle(fullChain);
            if (!seenCanonical.has(key)) {
              seenCanonical.add(key);
              cycles.push({ chain: fullChain });
              if (cycles.length >= maxCycles) return cycles;
            }
          }
          continue;
        }

        if (!parent.has(next)) {
          parent.set(next, node);
          depth.set(next, nodeDepth + 1);
          queue.push(next);
        }
      }
    }
  }

  // Sort by length (shortest = most actionable)
  cycles.sort((a, b) => a.chain.length - b.chain.length);
  return cycles;
}
