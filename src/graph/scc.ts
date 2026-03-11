/**
 * Iterative Tarjan's algorithm for finding strongly connected components.
 * Shared by cycle detection (cycles.ts) and critical chain computation (topology.ts).
 *
 * Returns ALL SCCs including singletons. Callers needing only cycle-SCCs should
 * filter with `scc.length > 1`.
 */
export function findSCCsFromAdj(allNodes: Iterable<string>, adj: Map<string, string[]>): string[][] {
  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];
  const callStack: Array<{ v: string; neighborIdx: number }> = [];
  const allSet = allNodes instanceof Set ? allNodes : new Set(allNodes);

  for (const file of [...allSet].sort()) {
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
        if (!allSet.has(w)) continue;
        if (!indices.has(w)) {
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
        if (lowlinks.get(frame.v) === indices.get(frame.v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.v);
          sccs.push(scc);
        }
        callStack.pop();
        if (callStack.length > 0) {
          const parent = callStack[callStack.length - 1]!;
          lowlinks.set(parent.v, Math.min(lowlinks.get(parent.v)!, lowlinks.get(frame.v)!));
        }
      }
    }
  }

  return sccs;
}
