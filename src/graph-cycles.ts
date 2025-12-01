import type { CircularDependency, ImportGraph } from "./types.js";

/**
 * Find all strongly connected components using Tarjan's algorithm.
 * Returns SCCs with size > 1 (i.e. actual cycles).
 */
export function findSCCs(graph: ImportGraph): string[][] {
  // Build adjacency list from internal edges only
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

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Iterative Tarjan's using an explicit call stack.
  // Each frame stores the current node and the index into its neighbor list.
  const callStack: Array<{ v: string; neighborIdx: number }> = [];

  for (const file of allFiles) {
    if (indices.has(file)) continue;

    callStack.push({ v: file, neighborIdx: 0 });
    indices.set(file, index);
    lowlinks.set(file, index);
    index++;
    stack.push(file);
    onStack.add(file);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = adj.get(frame.v) ?? [];

      if (frame.neighborIdx < neighbors.length) {
        const w = neighbors[frame.neighborIdx]!;
        frame.neighborIdx++;

        if (!indices.has(w)) {
          // "Recurse" into w: push a new frame
          callStack.push({ v: w, neighborIdx: 0 });
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
        } else if (onStack.has(w)) {
          lowlinks.set(frame.v, Math.min(lowlinks.get(frame.v)!, indices.get(w)!));
        }
      } else {
        // All neighbors processed: check for SCC root
        if (lowlinks.get(frame.v) === indices.get(frame.v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.v);
          if (scc.length > 1) {
            sccs.push(scc);
          }
        }

        // Pop this frame and update parent's lowlink
        callStack.pop();
        if (callStack.length > 0) {
          const parentFrame = callStack[callStack.length - 1]!;
          lowlinks.set(
            parentFrame.v,
            Math.min(lowlinks.get(parentFrame.v)!, lowlinks.get(frame.v)!),
          );
        }
      }
    }
  }

  return sccs;
}

/**
 * Detect circular dependencies using Tarjan's SCC algorithm,
 * then extract actual valid cycles via BFS within each SCC.
 * Returns up to maxCycles results, shortest first.
 */
export function findCircularDeps(
  graph: ImportGraph,
  maxCycles = 10,
): CircularDependency[] {
  const sccs = findSCCs(graph);

  // Sort SCCs by size (smallest first, more actionable)
  sccs.sort((a, b) => a.length - b.length);

  // Build adjacency restricted to internal edges
  const adj = new Map<string, Set<string>>();
  // Build edge lookup for type-only info: "from->to" -> ImportEdge
  const edgeLookup = new Map<string, import("./types.js").ImportEdge>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    adj.get(edge.from)!.add(edge.to);
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
  const shortName = (f: string) => f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? f;
  for (const cycle of allCycles) {
    const edges: Array<{ from: string; to: string; isTypeOnly: boolean; isDynamic: boolean }> = [];
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}->${cycle.chain[i + 1]}`;
      const e = edgeLookup.get(key);
      edges.push({ from: cycle.chain[i], to: cycle.chain[i + 1], isTypeOnly: !!e?.isTypeOnly, isDynamic: !!e?.isDynamic });
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
      const shortest = runtimeEdges.reduce((a, b) => a.from < b.from ? a : b);
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
 * Uses a greedy approach: count how many cycles each edge participates in,
 * then report the top edges whose removal would resolve the most cycles.
 *
 * @returns Array of { from, to, cyclesResolved } sorted by impact descending, max 3 items.
 */
export function findFeedbackEdges(
  cycles: CircularDependency[],
  topN = 3,
): Array<{ from: string; to: string; cyclesResolved: number }> {
  if (cycles.length === 0) return [];

  // Count how many cycles each directed edge participates in
  const edgeCounts = new Map<string, number>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}||${cycle.chain[i + 1]}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Sort by count descending and return top N
  const sorted = [...edgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  return sorted.map(([key, count]) => {
    const [from, to] = key.split("||");
    return { from, to, cyclesResolved: count };
  });
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
function findActualCycles(
  scc: string[],
  adj: Map<string, Set<string>>,
  maxCycles: number,
): CircularDependency[] {
  const sccSet = new Set(scc);

  // Build SCC-restricted adjacency
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
    const degA = (sccAdj.get(a)?.size ?? 0) + (sccAdj.get(b)?.size ?? 0);
    const degB = (sccAdj.get(b)?.size ?? 0) + (sccAdj.get(a)?.size ?? 0);
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
