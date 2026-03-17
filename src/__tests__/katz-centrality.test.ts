import { describe, it, expect } from "vitest";
import { estimateSpectralRadius, propagateKatz } from "../core/graph/katz-centrality";
import type { SymbolSubgraph, SymbolSubEdge } from "../core/graph/intent-subgraph";
import type { InMemorySymbolNode } from "../storage/types";
import type { ExtendedEdgeKind } from "../core/graph/symbol-types";
import { TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT } from "../core/config/intent-constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: number): InMemorySymbolNode {
  return { id, filePath: `test${id}.ts`, name: `sym${id}`, kind: "function", startLine: id, isExported: true };
}

function buildSubgraph(nodeIds: number[], edges: Array<[number, number, Partial<SymbolSubEdge>?]>): SymbolSubgraph {
  const nodes = new Map<number, InMemorySymbolNode>();
  for (const id of nodeIds) nodes.set(id, makeNode(id));

  const forward = new Map<number, SymbolSubEdge[]>();
  const reverse = new Map<number, SymbolSubEdge[]>();

  for (const [from, to, opts] of edges) {
    const kind = (opts?.kind ?? "calls") as ExtendedEdgeKind;
    const confidence = opts?.confidence ?? 1.0;
    const isBarrelRouted = opts?.isBarrelRouted ?? false;

    let fwd = forward.get(from);
    if (!fwd) {
      fwd = [];
      forward.set(from, fwd);
    }
    fwd.push({ targetId: to, kind, confidence, isReverse: false, isBarrelRouted });

    let rev = reverse.get(to);
    if (!rev) {
      rev = [];
      reverse.set(to, rev);
    }
    rev.push({ targetId: from, kind, confidence, isReverse: true, isBarrelRouted });
  }

  return {
    nodes,
    forward,
    reverse,
    fileSet: new Set(nodeIds.map((id) => `test${id}.ts`)),
    seedIds: new Set(),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("Katz Centrality", () => {
  it("chain: scores decrease with distance from seed", () => {
    const sub = buildSubgraph(
      [1, 2, 3, 4],
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    );
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    // All nodes scored
    expect(scores.size).toBe(4);
    // Seed node has high score
    expect(scores.get(1)).toBeGreaterThan(0.9);
    // Forward propagation decays: nodes further from seed score lower
    expect(scores.get(2)).toBeGreaterThan(scores.get(3) ?? 0);
    expect(scores.get(3)).toBeGreaterThan(scores.get(4) ?? 0);
  });

  it("diamond: multi-path compounding (D scores higher than B or C)", () => {
    // A->B, A->C, B->D, C->D
    const sub = buildSubgraph(
      [1, 2, 3, 4],
      [
        [1, 2],
        [1, 3],
        [2, 4],
        [3, 4],
      ],
    );
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    expect(scores.get(4)).toBeGreaterThan(scores.get(2) ?? 0);
    expect(scores.get(4)).toBeGreaterThan(scores.get(3) ?? 0);
  });

  it("multi-seed: middle nodes receive signal from both ends", () => {
    const sub = buildSubgraph(
      [1, 2, 3, 4],
      [
        [1, 2],
        [2, 3],
        [3, 4],
      ],
    );
    const scores = propagateKatz(
      new Map([
        [1, 1.0],
        [4, 1.0],
      ]),
      sub,
      TRANSMISSION,
      REVERSE_MULTIPLIER,
      GHOST_DISCOUNT,
    );

    expect(scores.get(2)).toBeGreaterThan(0);
    expect(scores.get(3)).toBeGreaterThan(0);
  });

  it("ghost edge produces lower score than regular edge in shared graph", () => {
    // Use the same graph so alpha is identical; compare ghost vs non-ghost targets
    const sub = buildSubgraph(
      [1, 2, 3],
      [
        [1, 2], // normal "calls" edge
        [1, 3, { kind: "ghost:di_inject" as ExtendedEdgeKind }], // ghost edge
      ],
    );
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    // Node 2 (normal edge) should score higher than node 3 (ghost-discounted)
    expect(scores.get(2)).toBeGreaterThan(scores.get(3) ?? 0);
  });

  it("reverse edge modifier applied", () => {
    // Build graph where traversal would use reverse edges
    const sub = buildSubgraph([1, 2], [[2, 1]]); // edge is 2->1, so from seed 1, traversal is reverse
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    // Node 2 should receive some signal via reverse traversal
    expect(scores.has(2)).toBe(true);
    expect(scores.get(2)).toBeGreaterThan(0);
    expect(scores.get(2)).toBeLessThan(1.0);
  });

  it("output normalized to [0, 1]", () => {
    const sub = buildSubgraph(
      [1, 2, 3],
      [
        [1, 2],
        [2, 3],
      ],
    );
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    for (const val of scores.values()) {
      expect(val).toBeGreaterThanOrEqual(0);
      expect(val).toBeLessThanOrEqual(1.0);
    }
    expect(Math.max(...scores.values())).toBe(1.0);
  });

  it("empty subgraph returns empty map", () => {
    const sub: SymbolSubgraph = {
      nodes: new Map(),
      forward: new Map(),
      reverse: new Map(),
      fileSet: new Set(),
      seedIds: new Set(),
    };
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);
    expect(scores.size).toBe(0);
  });

  it("converges for a moderately sized graph", () => {
    const n = 50;
    const nodeIds = Array.from({ length: n }, (_, i) => i + 1);
    const edges: Array<[number, number]> = [];
    for (let i = 1; i < n; i++) edges.push([i, i + 1]);
    edges.push([1, 25], [25, 50], [10, 40]);

    const sub = buildSubgraph(nodeIds, edges);
    const scores = propagateKatz(new Map([[1, 1.0]]), sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    expect(scores.size).toBeGreaterThan(1);
  });

  it("spectral radius > 0 for connected graph", () => {
    const sub = buildSubgraph(
      [1, 2, 3],
      [
        [1, 2],
        [2, 3],
      ],
    );
    const rho = estimateSpectralRadius(sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);
    expect(rho).toBeGreaterThan(0);
  });

  it("spectral radius = 0 for empty graph", () => {
    const sub: SymbolSubgraph = {
      nodes: new Map(),
      forward: new Map(),
      reverse: new Map(),
      fileSet: new Set(),
      seedIds: new Set(),
    };
    const rho = estimateSpectralRadius(sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);
    expect(rho).toBe(0);
  });
});
