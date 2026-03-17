import { describe, it, expect } from "vitest";
import { computeDominatorTree, dominates } from "../core/graph/dominator";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildGraphs(edges: Array<[number, number]>): {
  forward: Map<number, number[]>;
  reverse: Map<number, number[]>;
} {
  const forward = new Map<number, number[]>();
  const reverse = new Map<number, number[]>();

  for (const [from, to] of edges) {
    let fwd = forward.get(from);
    if (!fwd) {
      fwd = [];
      forward.set(from, fwd);
    }
    fwd.push(to);
    let rev = reverse.get(to);
    if (!rev) {
      rev = [];
      reverse.set(to, rev);
    }
    rev.push(from);
  }

  return { forward, reverse };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("computeDominatorTree", () => {
  it("1.2.1 diamond graph: idom[D] = A", () => {
    //  A -> B -> D
    //  A -> C -> D
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.get(1)).toBe(1); // entry dominates itself
    expect(result.idom.get(2)).toBe(1);
    expect(result.idom.get(3)).toBe(1);
    expect(result.idom.get(4)).toBe(1); // A is idom of D, not B or C
  });

  it("1.2.2 linear chain: idom follows chain", () => {
    // A -> B -> C -> D
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.get(2)).toBe(1);
    expect(result.idom.get(3)).toBe(2);
    expect(result.idom.get(4)).toBe(3);
  });

  it("1.2.3 cycle: handles cyclic graph", () => {
    // A -> B -> C -> B (cycle between B and C)
    // A -> B -> D (exit)
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [2, 3],
      [3, 2],
      [2, 4],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.get(2)).toBe(1);
    expect(result.idom.get(3)).toBe(2);
    expect(result.idom.get(4)).toBe(2);
  });

  it("1.2.4 unreachable node excluded", () => {
    // A -> B, C is isolated
    const { forward, reverse } = buildGraphs([[1, 2]]);
    // Add isolated node to forward map
    forward.set(3, []);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.has(1)).toBe(true);
    expect(result.idom.has(2)).toBe(true);
    expect(result.idom.has(3)).toBe(false); // unreachable
  });

  it("1.2.5 single node: entry dominates itself", () => {
    const forward = new Map<number, number[]>();
    const reverse = new Map<number, number[]>();
    forward.set(1, []);

    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.size).toBe(1);
    expect(result.idom.get(1)).toBe(1);
    expect(result.children.size).toBe(0);
  });

  it("1.2.6 fan-out: all children dominated by entry", () => {
    // A -> B, A -> C, A -> D
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [1, 3],
      [1, 4],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.get(2)).toBe(1);
    expect(result.idom.get(3)).toBe(1);
    expect(result.idom.get(4)).toBe(1);
    expect(result.children.get(1)?.sort()).toEqual([2, 3, 4]);
  });

  it("1.2.7 children map built correctly", () => {
    // A -> B -> C
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [2, 3],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.children.get(1)).toEqual([2]);
    expect(result.children.get(2)).toEqual([3]);
    expect(result.children.has(3)).toBe(false); // leaf
  });

  it("1.2.8 complex graph: if-then-else merge", () => {
    //      1
    //     / \
    //    2   3
    //    |   |
    //    4   5
    //     \ /
    //      6
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 5],
      [4, 6],
      [5, 6],
    ]);
    const result = computeDominatorTree(1, forward, reverse);

    expect(result.idom.get(2)).toBe(1);
    expect(result.idom.get(3)).toBe(1);
    expect(result.idom.get(4)).toBe(2);
    expect(result.idom.get(5)).toBe(3);
    expect(result.idom.get(6)).toBe(1); // merge point dominated by entry
  });
});

describe("dominates", () => {
  it("node dominates itself", () => {
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [2, 3],
    ]);
    const { idom } = computeDominatorTree(1, forward, reverse);

    expect(dominates(2, 2, idom)).toBe(true);
  });

  it("entry dominates all reachable nodes", () => {
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ]);
    const { idom } = computeDominatorTree(1, forward, reverse);

    expect(dominates(1, 4, idom)).toBe(true);
    expect(dominates(1, 2, idom)).toBe(true);
    expect(dominates(1, 3, idom)).toBe(true);
  });

  it("non-dominator returns false in diamond", () => {
    const { forward, reverse } = buildGraphs([
      [1, 2],
      [1, 3],
      [2, 4],
      [3, 4],
    ]);
    const { idom } = computeDominatorTree(1, forward, reverse);

    // B does not dominate D (path A->C->D bypasses B)
    expect(dominates(2, 4, idom)).toBe(false);
    expect(dominates(3, 4, idom)).toBe(false);
  });

  it("returns false for unreachable node", () => {
    const idom = new Map<number, number>([[1, 1]]);
    expect(dominates(1, 99, idom)).toBe(false);
  });
});
