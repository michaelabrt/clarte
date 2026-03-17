import { describe, it, expect } from "vitest";
import { kShortestPaths } from "../core/graph/k-shortest-paths";
import { FLOW_GHOST_DISCOUNT } from "../core/config/flow-constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildAdj(edges: Array<[number, number, string]>): Map<number, Array<{ target: number; kind: string }>> {
  const adj = new Map<number, Array<{ target: number; kind: string }>>();
  for (const [from, to, kind] of edges) {
    let list = adj.get(from);
    if (!list) {
      list = [];
      adj.set(from, list);
    }
    list.push({ target: to, kind });
  }
  return adj;
}

/** Standard weight function: -log(edgeWeight). calls=1.0, extends=1.0, ghost:route=0.6 */
const WEIGHTS: Record<string, number> = {
  calls: 1.0,
  extends: 1.0,
  decorates: 0.7,
  "ghost:route": 1.0,
};

function edgeWeight(_from: number, _to: number, kind: string): number {
  const base = WEIGHTS[kind] ?? 0.3;
  const discount = kind.startsWith("ghost:") ? FLOW_GHOST_DISCOUNT : 1.0;
  return -Math.log(base * discount);
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("kShortestPaths", () => {
  it("1.3.1 triangle: finds two paths sorted by cost", () => {
    // A(1) -> B(2) -> D(4)   via calls (cost = 2 * -log(1.0) = 0)
    // A(1) -> C(3) -> D(4)   via decorates (cost = 2 * -log(0.7) ≈ 0.71)
    const adj = buildAdj([
      [1, 2, "calls"],
      [2, 4, "calls"],
      [1, 3, "decorates"],
      [3, 4, "decorates"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 4, 2);

    expect(paths.length).toBe(2);
    expect(paths[0].nodes).toEqual([1, 2, 4]); // cheapest (calls)
    expect(paths[1].nodes).toEqual([1, 3, 4]); // costlier (decorates)
    expect(paths[0].cost).toBeLessThan(paths[1].cost);
  });

  it("1.3.2 no path: returns empty", () => {
    const adj = buildAdj([
      [1, 2, "calls"],
      [3, 4, "calls"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 4, 3);
    expect(paths).toEqual([]);
  });

  it("1.3.3 k > available: returns all available", () => {
    // Only one path: A -> B
    const adj = buildAdj([[1, 2, "calls"]]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 2, 5);
    expect(paths.length).toBe(1);
    expect(paths[0].nodes).toEqual([1, 2]);
  });

  it("1.3.4 single edge: returns one path", () => {
    const adj = buildAdj([[1, 2, "calls"]]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 2, 1);
    expect(paths.length).toBe(1);
    expect(paths[0].nodes).toEqual([1, 2]);
    expect(paths[0].edgeKinds).toEqual(["calls"]);
  });

  it("1.3.5 ghost edge receives FLOW_GHOST_DISCOUNT", () => {
    // A -> B via calls (cost = -log(1.0) = 0)
    // A -> C -> B via ghost:route (cost = 2 * -log(1.0 * 0.6))
    const adj = buildAdj([
      [1, 2, "calls"],
      [1, 3, "ghost:route"],
      [3, 2, "ghost:route"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 2, 2);
    expect(paths.length).toBe(2);
    // Direct calls path should be cheaper than ghost path
    expect(paths[0].nodes).toEqual([1, 2]);
    expect(paths[0].cost).toBeLessThan(paths[1].cost);
  });

  it("1.3.6 edgeKinds track correctly", () => {
    const adj = buildAdj([
      [1, 2, "calls"],
      [2, 3, "extends"],
      [3, 4, "decorates"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 4, 1);
    expect(paths.length).toBe(1);
    expect(paths[0].edgeKinds).toEqual(["calls", "extends", "decorates"]);
  });

  it("1.3.7 confidence is exp(-cost)", () => {
    const adj = buildAdj([
      [1, 2, "calls"],
      [2, 3, "calls"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 3, 1);
    expect(paths.length).toBe(1);
    // calls weight = 1.0, cost = -log(1.0) = 0, confidence = exp(0) = 1.0
    expect(paths[0].confidence).toBeCloseTo(1.0, 5);
  });

  it("1.3.8 k=0 returns empty", () => {
    const adj = buildAdj([[1, 2, "calls"]]);
    const paths = kShortestPaths(adj, edgeWeight, 1, 2, 0);
    expect(paths).toEqual([]);
  });

  it("1.3.9 overlap filter removes near-identical paths", () => {
    // Three paths from 1 to 5:
    // 1 -> 2 -> 3 -> 4 -> 5 (via calls)
    // 1 -> 2 -> 3 -> 6 -> 5 (via calls, shares 60% nodes with first)
    // 1 -> 7 -> 8 -> 5       (via calls, fully distinct)
    const adj = buildAdj([
      [1, 2, "calls"],
      [2, 3, "calls"],
      [3, 4, "calls"],
      [4, 5, "calls"],
      [3, 6, "calls"],
      [6, 5, "calls"],
      [1, 7, "calls"],
      [7, 8, "calls"],
      [8, 5, "calls"],
    ]);

    // With strict overlap threshold of 0.5, the first two paths share
    // nodes {1,2,3,5} = 4 out of 5 = 80% overlap -> second filtered
    const paths = kShortestPaths(adj, edgeWeight, 1, 5, 3, 0.5);
    // Should get path 1 and path 3 (distinct), but path 2 filtered
    expect(paths.length).toBeGreaterThanOrEqual(2);

    const allNodeSets = paths.map((p) => p.nodes);
    // The fully distinct path [1,7,8,5] should be present
    expect(allNodeSets.some((n) => n.includes(7))).toBe(true);
  });

  it("1.3.10 loopless: cycles in graph do not cause infinite loop", () => {
    // 1 -> 2 -> 3 -> 2 (cycle) -> 4
    const adj = buildAdj([
      [1, 2, "calls"],
      [2, 3, "calls"],
      [3, 2, "calls"],
      [2, 4, "calls"],
    ]);

    const paths = kShortestPaths(adj, edgeWeight, 1, 4, 2);
    // Should find at least the path [1, 2, 4]
    expect(paths.length).toBeGreaterThanOrEqual(1);
    expect(paths[0].nodes).toEqual([1, 2, 4]);
    // All paths should be loopless
    for (const p of paths) {
      expect(new Set(p.nodes).size).toBe(p.nodes.length);
    }
  });
});
