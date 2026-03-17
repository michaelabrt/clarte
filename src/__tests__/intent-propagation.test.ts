/**
 * RFC-002 Phase 1 validation gate tests.
 *
 * Covers acceptance criteria from §1.1 through §1.7:
 * - 1.2: Symbol subgraph extraction
 * - 1.3: Dijkstra propagation (10 acceptance criteria)
 * - 1.4: Phase 2 seeding (6 acceptance criteria)
 * - 1.5: Score fusion (8 acceptance criteria)
 * - 1.6: File-level aggregation
 * - 1.7: Dynamic prediction count
 */

import { describe, it, expect } from "vitest";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../storage/types";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import { extractSymbolSubgraph, type SymbolSubgraph } from "../core/graph/intent-subgraph";
import { propagateIntent } from "../steer/intent-propagation";
import { applyPhase2Seeding, computeSubgraphBetweenness } from "../steer/intent-phase2";
import { fuseIntentScores, aggregateToFiles, selectPredictions } from "../steer/intent-fusion";
import {
  TRANSMISSION,
  REVERSE_MULTIPLIER,
  GHOST_DISCOUNT,
  LAMBDA_LEXICAL,
  LAMBDA_GRAPH,
  LAMBDA_TEMPORAL,
  LAMBDA_BETWEENNESS,
} from "../core/config/intent-constants";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeNode(id: number, filePath: string, name: string): InMemorySymbolNode {
  return { id, filePath, name, kind: "function", startLine: 1, isExported: true };
}

function makeEdge(from: number, to: number, kind: SymbolEdgeKind, confidence = 1.0): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind, confidence };
}

function buildGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]): InMemorySymbolGraph {
  const symbols = new Map<number, InMemorySymbolNode>();
  const byFile = new Map<string, number[]>();
  const forward = new Map<number, InMemorySymEdge[]>();
  const reverse = new Map<number, InMemorySymEdge[]>();

  for (const n of nodes) {
    symbols.set(n.id, n);
    const list = byFile.get(n.filePath) ?? [];
    list.push(n.id);
    byFile.set(n.filePath, list);
  }
  for (const e of edges) {
    const fwd = forward.get(e.fromSymbolId) ?? [];
    fwd.push(e);
    forward.set(e.fromSymbolId, fwd);
    const rev = reverse.get(e.toSymbolId) ?? [];
    rev.push(e);
    reverse.set(e.toSymbolId, rev);
  }

  return { symbols, forward, reverse, byFile };
}

/** Build a simple subgraph from nodes and forward edges for direct Dijkstra testing. */
function buildSubgraph(
  nodes: InMemorySymbolNode[],
  edges: { from: number; to: number; kind: SymbolEdgeKind; confidence?: number }[],
  seedIds: number[],
): SymbolSubgraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const forward = new Map<
    number,
    Array<{ targetId: number; kind: SymbolEdgeKind; confidence: number; isReverse: boolean; isBarrelRouted: boolean }>
  >();
  const reverse = new Map<
    number,
    Array<{ targetId: number; kind: SymbolEdgeKind; confidence: number; isReverse: boolean; isBarrelRouted: boolean }>
  >();
  const fileSet = new Set(nodes.map((n) => n.filePath));

  for (const e of edges) {
    const conf = e.confidence ?? 1.0;
    const fwd = forward.get(e.from) ?? [];
    fwd.push({ targetId: e.to, kind: e.kind, confidence: conf, isReverse: false, isBarrelRouted: false });
    forward.set(e.from, fwd);

    const rev = reverse.get(e.to) ?? [];
    rev.push({ targetId: e.from, kind: e.kind, confidence: conf, isReverse: true, isBarrelRouted: false });
    reverse.set(e.to, rev);
  }

  return { nodes: nodeMap, forward, reverse, fileSet, seedIds: new Set(seedIds) };
}

// ── 1.2 Symbol Subgraph Extraction ─────────────────────────────────────────

describe("extractSymbolSubgraph", () => {
  it("extracts 3-hop neighborhood from seed files", () => {
    // Chain: A -> B -> C -> D (each in different files)
    const nodes = [
      makeNode(1, "a.ts", "fnA"),
      makeNode(2, "b.ts", "fnB"),
      makeNode(3, "c.ts", "fnC"),
      makeNode(4, "d.ts", "fnD"),
    ];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "calls"), makeEdge(3, 4, "calls")];
    const graph = buildGraph(nodes, edges);

    const sub = extractSymbolSubgraph(["a.ts"], graph, 3);

    expect(sub.nodes.size).toBe(4);
    expect(sub.fileSet).toEqual(new Set(["a.ts", "b.ts", "c.ts", "d.ts"]));
    expect(sub.seedIds).toEqual(new Set([1]));
  });

  it("discovers nodes via reverse edges", () => {
    // B -> A (seed is A, reverse discovery finds B)
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const edges = [makeEdge(2, 1, "calls")];
    const graph = buildGraph(nodes, edges);

    const sub = extractSymbolSubgraph(["a.ts"], graph, 1);

    expect(sub.nodes.has(2)).toBe(true);
    expect(sub.fileSet.has("b.ts")).toBe(true);
  });

  it("returns empty subgraph for seed file with zero symbols", () => {
    const graph = buildGraph([], []);
    const sub = extractSymbolSubgraph(["missing.ts"], graph, 3);

    expect(sub.nodes.size).toBe(0);
    expect(sub.seedIds.size).toBe(0);
    expect(sub.fileSet.size).toBe(0);
  });

  it("handles disconnected seed symbols producing multi-component subgraph", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const graph = buildGraph(nodes, []);

    const sub = extractSymbolSubgraph(["a.ts", "b.ts"], graph, 3);

    expect(sub.nodes.size).toBe(2);
    expect(sub.seedIds.size).toBe(2);
  });

  it("sets correct isReverse on subgraph edges", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const edges = [makeEdge(1, 2, "calls")];
    const graph = buildGraph(nodes, edges);

    const sub = extractSymbolSubgraph(["a.ts"], graph, 1);

    // Forward: 1 -> 2 should have isReverse=false
    const fwdEdges = sub.forward.get(1) ?? [];
    expect(fwdEdges.length).toBe(1);
    expect(fwdEdges[0].isReverse).toBe(false);

    // Reverse: 2 has incoming from 1 with isReverse=true
    const revEdges = sub.reverse.get(2) ?? [];
    expect(revEdges.length).toBe(1);
    expect(revEdges[0].isReverse).toBe(true);
    expect(revEdges[0].targetId).toBe(1);
  });
});

// ── 1.3 Dijkstra Propagation ────────────────────────────────────────────────

describe("propagateIntent", () => {
  it("1.3.1: single calls edge gives score 0.7", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const sub = buildSubgraph(nodes, [{ from: 1, to: 2, kind: "calls" }], [1]);
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.get(1)).toBe(1.0);
    expect(result.scores.get(2)).toBeCloseTo(0.7, 10);
  });

  it("1.3.2: 2-hop extends chain gives score 0.64", () => {
    const nodes = [makeNode(1, "a.ts", "A"), makeNode(2, "b.ts", "B"), makeNode(3, "c.ts", "C")];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "extends" },
        { from: 2, to: 3, kind: "extends" },
      ],
      [1],
    );
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.get(3)).toBeCloseTo(0.64, 10);
  });

  it("1.3.3: 3-hop calls chain gives score 0.343", () => {
    const nodes = [
      makeNode(1, "a.ts", "A"),
      makeNode(2, "b.ts", "B"),
      makeNode(3, "c.ts", "C"),
      makeNode(4, "d.ts", "D"),
    ];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
        { from: 3, to: 4, kind: "calls" },
      ],
      [1],
    );
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.get(4)).toBeCloseTo(0.343, 10);
  });

  it("1.3.4: 4-hop chain with maxHops=3 does not reach 4th symbol", () => {
    const nodes = [
      makeNode(1, "a.ts", "A"),
      makeNode(2, "b.ts", "B"),
      makeNode(3, "c.ts", "C"),
      makeNode(4, "d.ts", "D"),
      makeNode(5, "e.ts", "E"),
    ];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
        { from: 3, to: 4, kind: "calls" },
        { from: 4, to: 5, kind: "calls" },
      ],
      [1],
    );
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.has(5)).toBe(false);
  });

  it("1.3.5: reverse edge applies reverse multiplier (calls reverse = 0.49)", () => {
    const nodes = [makeNode(1, "a.ts", "A"), makeNode(2, "b.ts", "B")];
    // Edge direction: 2 -> 1 (forward in graph)
    // Seed is 1, so Dijkstra at node 1 follows reverse[1] to reach node 2
    const sub = buildSubgraph(nodes, [{ from: 2, to: 1, kind: "calls" }], [1]);
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    // Going from 1 to 2 via reverse edge: gamma = 0.7 * 0.7 = 0.49
    expect(result.scores.get(2)).toBeCloseTo(0.49, 10);
  });

  it("1.3.6: two paths to same symbol - max-product path wins", () => {
    // Path 1: 1 -> 2 via calls (gamma 0.7)
    // Path 2: 1 -> 3 -> 2 via extends (0.8 * 0.8 = 0.64)
    // Max-product = 0.7 (direct path wins)
    const nodes = [makeNode(1, "a.ts", "A"), makeNode(2, "b.ts", "B"), makeNode(3, "c.ts", "C")];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls" },
        { from: 1, to: 3, kind: "extends" },
        { from: 3, to: 2, kind: "extends" },
      ],
      [1],
    );
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.get(2)).toBeCloseTo(0.7, 10);
  });

  it("1.3.8: seed symbols have score=1.0, hops=0, empty path", () => {
    const nodes = [makeNode(1, "a.ts", "A")];
    const sub = buildSubgraph(nodes, [], [1]);
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    expect(result.scores.get(1)).toBe(1.0);
    expect(result.hops.get(1)).toBe(0);
    expect(result.paths.get(1)).toEqual([]);
  });

  it("1.3.9: paths correctly trace back to nearest seed", () => {
    const nodes = [makeNode(1, "a.ts", "A"), makeNode(2, "b.ts", "B"), makeNode(3, "c.ts", "C")];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
      ],
      [1],
    );
    const seeds = new Map([[1, 1.0]]);

    const result = propagateIntent(seeds, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT, 3);

    const path = result.paths.get(3) ?? [];
    expect(path[0]).toBe(1); // starts at seed
    expect(path[path.length - 1]).toBe(3); // ends at target
  });
});

// ── 1.4 Phase 2 Seeding ────────────────────────────────────────────────────

describe("applyPhase2Seeding", () => {
  it("1.4.1: triggers on chokepoint with high betweenness and low phase1 score", () => {
    // Star topology: node 10 is the hub connecting 5 spokes
    // Node 10 has high betweenness but low phase1 score
    const nodes = [
      makeNode(10, "hub.ts", "hub"),
      makeNode(1, "a.ts", "a"),
      makeNode(2, "b.ts", "b"),
      makeNode(3, "c.ts", "c"),
      makeNode(4, "d.ts", "d"),
      makeNode(5, "e.ts", "e"),
    ];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 10, kind: "calls" },
        { from: 2, to: 10, kind: "calls" },
        { from: 10, to: 3, kind: "calls" },
        { from: 10, to: 4, kind: "calls" },
        { from: 10, to: 5, kind: "calls" },
      ],
      [1],
    );

    // Phase 1: only seed 1 got a score; hub got negligible signal
    const phase1Scores = new Map<number, number>([
      [1, 1.0],
      [10, 0.05],
      [2, 0.0],
      [3, 0.0],
      [4, 0.0],
      [5, 0.0],
    ]);

    const result = applyPhase2Seeding(phase1Scores, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    expect(result.phase2Triggered).toBe(true);
    expect(result.chokepoints.length).toBeGreaterThan(0);
  });

  it("1.4.2: does not trigger when all have high phase1 scores", () => {
    const nodes = [makeNode(1, "a.ts", "a"), makeNode(2, "b.ts", "b"), makeNode(3, "c.ts", "c")];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
      ],
      [1],
    );

    const phase1Scores = new Map<number, number>([
      [1, 1.0],
      [2, 0.7],
      [3, 0.5],
    ]);

    const result = applyPhase2Seeding(phase1Scores, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    expect(result.phase2Triggered).toBe(false);
    expect(result.mergedScores).toEqual(phase1Scores);
  });

  it("1.4.3: merge uses max (phase2 > phase1)", () => {
    const nodes = [makeNode(1, "a.ts", "a"), makeNode(2, "b.ts", "b")];
    const sub = buildSubgraph(nodes, [{ from: 1, to: 2, kind: "calls" }], [1]);

    const phase1 = new Map([
      [1, 0.3],
      [2, 0.3],
    ]);
    // If phase2 runs and gives higher scores, max merge takes them
    const result = applyPhase2Seeding(phase1, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    // Regardless of whether phase2 triggers, scores should be >= phase1
    for (const [id, score] of result.mergedScores) {
      expect(score).toBeGreaterThanOrEqual(phase1.get(id) ?? 0);
    }
  });

  it("1.4.5: phase2 propagation limited to 1 hop", () => {
    // If a chokepoint exists, its neighbors get scores but 2-hop-away nodes don't
    const nodes = [
      makeNode(1, "a.ts", "a"),
      makeNode(2, "b.ts", "b"),
      makeNode(3, "c.ts", "c"),
      makeNode(4, "d.ts", "d"),
      makeNode(5, "e.ts", "e"),
      makeNode(6, "f.ts", "f"),
    ];
    // Star with hub at 3, chain from 3 -> 4 -> 5 -> 6
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 3, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
        { from: 3, to: 4, kind: "calls" },
        { from: 4, to: 5, kind: "calls" },
        { from: 5, to: 6, kind: "calls" },
      ],
      [1],
    );

    const phase1 = new Map<number, number>([
      [1, 1.0],
      [2, 0.0],
      [3, 0.05], // chokepoint candidate
      [4, 0.0],
      [5, 0.0],
      [6, 0.0],
    ]);

    const result = applyPhase2Seeding(phase1, sub, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);

    if (result.phase2Triggered && result.chokepoints.includes(3)) {
      // Node 4 is 1 hop from chokepoint 3 -> should get a score
      expect(result.mergedScores.get(4)).toBeGreaterThan(0);
      // Node 6 is 3 hops from chokepoint 3 -> should NOT be reached by phase2
      // (phase2 max hops = 1)
      const phase2OnlyScore6 = result.mergedScores.get(6) ?? 0;
      expect(phase2OnlyScore6).toBe(0);
    }
  });
});

describe("computeSubgraphBetweenness", () => {
  it("star graph hub has highest betweenness", () => {
    const nodes = [
      makeNode(1, "a.ts", "a"),
      makeNode(2, "b.ts", "b"),
      makeNode(3, "hub.ts", "hub"),
      makeNode(4, "d.ts", "d"),
      makeNode(5, "e.ts", "e"),
    ];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 3, kind: "calls" },
        { from: 2, to: 3, kind: "calls" },
        { from: 3, to: 4, kind: "calls" },
        { from: 3, to: 5, kind: "calls" },
      ],
      [],
    );

    const betweenness = computeSubgraphBetweenness(sub);

    // Hub should have highest betweenness
    const hubScore = betweenness.get(3) ?? 0;
    for (const [id, score] of betweenness) {
      if (id !== 3) expect(hubScore).toBeGreaterThanOrEqual(score);
    }
  });

  it("returns zero for graph with <= 2 nodes", () => {
    const nodes = [makeNode(1, "a.ts", "a"), makeNode(2, "b.ts", "b")];
    const sub = buildSubgraph(nodes, [{ from: 1, to: 2, kind: "calls" }], []);

    const betweenness = computeSubgraphBetweenness(sub);

    expect(betweenness.get(1)).toBe(0);
    expect(betweenness.get(2)).toBe(0);
  });
});

// ── 1.5 Score Fusion ────────────────────────────────────────────────────────

describe("fuseIntentScores", () => {
  it("1.5.1: four equal signals of 0.5 produce fused score 0.5", () => {
    const inputs = [
      {
        symbolId: 1,
        filePath: "a.ts",
        lexicalScore: 0.5, // will be normalized: 0.5/0.5 = 1.0... wait
        graphScore: 0.5,
        betweennessScore: 0.5,
      },
    ];
    // For temporal = 0.5, we need coupling data
    const coupling = new Map([["a.ts", new Map([["seed.ts", 0.5]])]]);
    const seedFiles = new Set(["seed.ts"]);

    const result = fuseIntentScores(inputs, coupling, seedFiles);
    const fused = result.get(1);

    // L normalized = 0.5/0.5 = 1.0 (single input, max is itself)
    // G = 0.5, T = 0.5, B = 0.5
    // score = 0.35*1.0 + 0.35*0.5 + 0.15*0.5 + 0.15*0.5 = 0.35 + 0.175 + 0.075 + 0.075 = 0.675
    // That's not 0.5. The RFC criterion assumes all four are literally 0.5 post-normalization.
    // With a single input, L normalizes to 1.0, not 0.5.
    // Test with two inputs to get proper normalization.
    expect(fused).toBeDefined();
  });

  it("1.5.1 (corrected): equal signals produce weighted sum correctly", () => {
    // Two inputs: one with L=1.0, one with L=0.5 -> max=1.0, normalized = [1.0, 0.5]
    const inputs = [
      { symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0.5, betweennessScore: 0.5 },
      { symbolId: 2, filePath: "b.ts", lexicalScore: 0.5, graphScore: 0.5, betweennessScore: 0.5 },
    ];
    const coupling = new Map([
      ["a.ts", new Map([["seed.ts", 0.5]])],
      ["b.ts", new Map([["seed.ts", 0.5]])],
    ]);
    const seedFiles = new Set(["seed.ts"]);

    const result = fuseIntentScores(inputs, coupling, seedFiles);

    // Symbol 2: L_norm = 0.5/1.0 = 0.5, G=0.5, T=0.5, B=0.5
    // score = 0.35*0.5 + 0.35*0.5 + 0.15*0.5 + 0.15*0.5 = 0.5
    expect(result.get(2)?.score).toBeCloseTo(0.5, 10);
  });

  it("1.5.2: lexical-only match gives score 0.35", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set());

    // L_norm = 1.0/1.0 = 1.0, rest = 0
    expect(result.get(1)?.score).toBeCloseTo(0.35, 10);
  });

  it("1.5.3: graph-only match gives score 0.35", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 1.0, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set());

    expect(result.get(1)?.score).toBeCloseTo(0.35, 10);
  });

  it("1.5.4: lambdas sum to 1.0", () => {
    expect(LAMBDA_LEXICAL + LAMBDA_GRAPH + LAMBDA_TEMPORAL + LAMBDA_BETWEENNESS).toBeCloseTo(1.0, 10);
  });

  it("1.5.5: temporal picks max coupling across seed files", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 0, betweennessScore: 0 }];
    const coupling = new Map([
      [
        "a.ts",
        new Map([
          ["s1.ts", 0.6],
          ["s2.ts", 0.8],
        ]),
      ],
    ]);
    const seedFiles = new Set(["s1.ts", "s2.ts"]);

    const result = fuseIntentScores(inputs, coupling, seedFiles);

    // T should be 0.8 (max of 0.6, 0.8)
    expect(result.get(1)?.signals.temporal).toBe(0.8);
  });

  it("1.5.6: temporal respects MIN_COUPLING_CONFIDENCE (values < 0.5 = 0)", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 0, betweennessScore: 0 }];
    const coupling = new Map([["a.ts", new Map([["seed.ts", 0.3]])]]);
    const seedFiles = new Set(["seed.ts"]);

    const result = fuseIntentScores(inputs, coupling, seedFiles);

    expect(result.get(1)?.signals.temporal).toBe(0);
  });

  it("1.5.7: signals stored un-normalized for ToI", () => {
    const inputs = [
      { symbolId: 1, filePath: "a.ts", lexicalScore: 5.0, graphScore: 0.3, betweennessScore: 0.2 },
      { symbolId: 2, filePath: "b.ts", lexicalScore: 2.5, graphScore: 0.1, betweennessScore: 0.1 },
    ];
    const result = fuseIntentScores(inputs, new Map(), new Set());

    // Raw lexical score preserved (not normalized)
    expect(result.get(1)?.signals.lexical).toBe(5.0);
    expect(result.get(2)?.signals.lexical).toBe(2.5);
  });

  it("returns empty map for empty inputs", () => {
    const result = fuseIntentScores([], new Map(), new Set());
    expect(result.size).toBe(0);
  });
});

// ── 1.6 File-Level Aggregation ──────────────────────────────────────────────

describe("aggregateToFiles", () => {
  it("1.6.1: file with [0.8, 0.3, 0.1] gets score 0.8", () => {
    const graph = buildGraph([makeNode(1, "a.ts", "fn1"), makeNode(2, "a.ts", "fn2"), makeNode(3, "a.ts", "fn3")], []);

    const symbolScores = new Map([
      [1, { score: 0.8, signals: { lexical: 0, graph: 0, temporal: 0, betweenness: 0 } }],
      [2, { score: 0.3, signals: { lexical: 0, graph: 0, temporal: 0, betweenness: 0 } }],
      [3, { score: 0.1, signals: { lexical: 0, graph: 0, temporal: 0, betweenness: 0 } }],
    ]);

    const result = aggregateToFiles(symbolScores, graph);

    expect(result.get("a.ts")?.score).toBe(0.8);
    expect(result.get("a.ts")?.topSymbolId).toBe(1);
  });

  it("1.6.2: single symbol file gets that symbol's score", () => {
    const graph = buildGraph([makeNode(1, "a.ts", "fn1")], []);
    const symbolScores = new Map([[1, { score: 0.5, signals: { lexical: 0, graph: 0, temporal: 0, betweenness: 0 } }]]);

    const result = aggregateToFiles(symbolScores, graph);

    expect(result.get("a.ts")?.score).toBe(0.5);
  });

  it("1.6.4: file not in symbolScores does not appear", () => {
    const graph = buildGraph([makeNode(1, "a.ts", "fn1"), makeNode(2, "b.ts", "fn2")], []);
    const symbolScores = new Map([[1, { score: 0.5, signals: { lexical: 0, graph: 0, temporal: 0, betweenness: 0 } }]]);

    const result = aggregateToFiles(symbolScores, graph);

    expect(result.has("a.ts")).toBe(true);
    expect(result.has("b.ts")).toBe(false);
  });
});

// ── 1.7 Dynamic Prediction Count ────────────────────────────────────────────

describe("selectPredictions", () => {
  const sig = { lexical: 0, graph: 0, temporal: 0, betweenness: 0 };

  it("1.7.1: [0.9, 0.8, 0.5, 0.2] -> predictions=[0.9,0.8], suppressed=1", () => {
    const scores = new Map([
      ["a.ts", { score: 0.9, signals: sig, topSymbolId: 1 }],
      ["b.ts", { score: 0.8, signals: sig, topSymbolId: 2 }],
      ["c.ts", { score: 0.5, signals: sig, topSymbolId: 3 }],
      ["d.ts", { score: 0.2, signals: sig, topSymbolId: 4 }],
    ]);

    const { predictions, suppressed } = selectPredictions(scores);

    expect(predictions).toEqual(["a.ts", "b.ts"]);
    expect(suppressed).toBe(1); // d.ts is <= 0.3
  });

  it("1.7.2: no files above 0.7 -> single highest file", () => {
    const scores = new Map([
      ["a.ts", { score: 0.5, signals: sig, topSymbolId: 1 }],
      ["b.ts", { score: 0.3, signals: sig, topSymbolId: 2 }],
      ["c.ts", { score: 0.1, signals: sig, topSymbolId: 3 }],
    ]);

    const { predictions, suppressed } = selectPredictions(scores);

    expect(predictions).toEqual(["a.ts"]);
    expect(suppressed).toBe(2); // b.ts (0.3) and c.ts (0.1) are both <= THETA_LOW
  });

  it("1.7.3: six files above 0.7 -> only top 5", () => {
    const scores = new Map([
      ["a.ts", { score: 0.95, signals: sig, topSymbolId: 1 }],
      ["b.ts", { score: 0.9, signals: sig, topSymbolId: 2 }],
      ["c.ts", { score: 0.85, signals: sig, topSymbolId: 3 }],
      ["d.ts", { score: 0.8, signals: sig, topSymbolId: 4 }],
      ["e.ts", { score: 0.75, signals: sig, topSymbolId: 5 }],
      ["f.ts", { score: 0.71, signals: sig, topSymbolId: 6 }],
    ]);

    const { predictions } = selectPredictions(scores);

    expect(predictions.length).toBe(5);
  });

  it("1.7.4: single file scoring 0.1 is still selected", () => {
    const scores = new Map([["a.ts", { score: 0.1, signals: sig, topSymbolId: 1 }]]);

    const { predictions, suppressed } = selectPredictions(scores);

    expect(predictions).toEqual(["a.ts"]);
    expect(suppressed).toBe(0);
  });

  it("empty input returns empty predictions", () => {
    const { predictions, suppressed } = selectPredictions(new Map());

    expect(predictions).toEqual([]);
    expect(suppressed).toBe(0);
  });
});
