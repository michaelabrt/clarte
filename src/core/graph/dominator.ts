/**
 * Dominator tree computation (Cooper-Harvey-Kennedy iterative algorithm).
 *
 * Given a directed graph rooted at an entry node, computes the immediate
 * dominator of every reachable node. A node D dominates N if every path
 * from entry to N passes through D. The immediate dominator is the closest
 * strict dominator.
 *
 * Reference: Cooper, Harvey, Kennedy,
 * "A Simple, Fast Dominance Algorithm" (2001).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface DominatorResult {
  /** node -> immediate dominator. Entry maps to itself. */
  idom: Map<number, number>;
  /** node -> children in dominator tree */
  children: Map<number, number[]>;
  /** Reverse postorder (exposed for testing) */
  rpo: number[];
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Compute reverse postorder via iterative DFS.
 * Avoids recursion to prevent stack overflow on deep graphs.
 */
function computeRPO(entry: number, forward: Map<number, number[]>): number[] {
  const visited = new Set<number>();
  const postorder: number[] = [];

  // Stack entries: [node, childIndex]. When childIndex === children.length,
  // the node is finished and appended to postorder.
  const stack: Array<[number, number]> = [[entry, 0]];
  visited.add(entry);

  while (stack.length > 0) {
    const top = stack[stack.length - 1];
    const node = top[0];
    const children = forward.get(node) ?? [];

    if (top[1] < children.length) {
      const child = children[top[1]];
      top[1]++;
      if (!visited.has(child)) {
        visited.add(child);
        stack.push([child, 0]);
      }
    } else {
      stack.pop();
      postorder.push(node);
    }
  }

  postorder.reverse();
  return postorder;
}

/**
 * Intersect two nodes by walking fingers up the dominator tree
 * using RPO index ordering.
 */
function intersect(a: number, b: number, idom: Map<number, number>, rpoIndex: Map<number, number>): number {
  let fa = a;
  let fb = b;
  while (fa !== fb) {
    while ((rpoIndex.get(fa) ?? 0) > (rpoIndex.get(fb) ?? 0)) {
      fa = idom.get(fa) ?? fa;
    }
    while ((rpoIndex.get(fb) ?? 0) > (rpoIndex.get(fa) ?? 0)) {
      fb = idom.get(fb) ?? fb;
    }
  }
  return fa;
}

/**
 * Compute the dominator tree for a directed graph rooted at `entry`.
 *
 * Nodes unreachable from entry are excluded from the result.
 */
export function computeDominatorTree(
  entry: number,
  forward: Map<number, number[]>,
  reverse: Map<number, number[]>,
): DominatorResult {
  const rpo = computeRPO(entry, forward);

  // Build RPO index for O(1) comparisons
  const rpoIndex = new Map<number, number>();
  for (let i = 0; i < rpo.length; i++) {
    rpoIndex.set(rpo[i], i);
  }

  // Initialize: only entry has a known dominator (itself)
  const idom = new Map<number, number>();
  idom.set(entry, entry);

  // Iterate until stable
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of rpo) {
      if (node === entry) continue;

      const preds = (reverse.get(node) ?? []).filter((p) => idom.has(p));
      if (preds.length === 0) continue;

      let newIdom = preds[0];
      for (let i = 1; i < preds.length; i++) {
        newIdom = intersect(newIdom, preds[i], idom, rpoIndex);
      }

      if (idom.get(node) !== newIdom) {
        idom.set(node, newIdom);
        changed = true;
      }
    }
  }

  // Build children map
  const children = new Map<number, number[]>();
  for (const [node, dom] of idom) {
    if (node === dom) continue; // skip entry self-loop
    const siblings = children.get(dom);
    if (siblings) {
      siblings.push(node);
    } else {
      children.set(dom, [node]);
    }
  }

  return { idom, children, rpo };
}

/**
 * Check whether `dominator` dominates `target` in the dominator tree.
 * A node dominates itself.
 */
export function dominates(dominator: number, target: number, idom: Map<number, number>): boolean {
  let current = target;
  while (current !== dominator) {
    const parent = idom.get(current);
    if (parent === undefined || parent === current) return false;
    current = parent;
  }
  return true;
}
