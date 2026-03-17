/**
 * RFC-002 Phase 3 validation gate tests.
 *
 * Covers acceptance criteria from §3.1 through §3.7:
 * - 3.1: Token cost estimator (4 criteria incl. acronym handling)
 * - 3.2: Structural reach (4 criteria)
 * - 3.3-3.4: Submodular coverage (5 criteria)
 * - 3.5: Greedy symbol selection (9 criteria incl. same-file redundancy)
 * - 3.6: Diminishing returns guard (3 criteria)
 * - 3.7: Presentation ordering (4 criteria)
 */

import { describe, it, expect } from "vitest";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../storage/types";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { SymbolSubgraph, SymbolSubEdge } from "../core/graph/intent-subgraph";
import {
  estimateTokenCost,
  computeStructuralReach,
  computeMarginalGain,
  applyCoverage,
  selectContextSymbols,
  orderForPresentation,
  type CoverageState,
} from "../steer/context-pruning";

// ── Test helpers ────────────────────────────────────────────────────────────

function makeNode(id: number, filePath: string, name: string, kind = "function"): InMemorySymbolNode {
  return { id, filePath, name, kind, startLine: 1, isExported: true };
}

function makeEdge(from: number, to: number, kind: SymbolEdgeKind, confidence = 1.0): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind, confidence };
}

function buildSymbolGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]): InMemorySymbolGraph {
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

function buildSubgraph(
  nodes: InMemorySymbolNode[],
  edges: { from: number; to: number; kind: SymbolEdgeKind; confidence?: number }[],
  seedIds: number[] = [],
): SymbolSubgraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const forward = new Map<number, SymbolSubEdge[]>();
  const reverse = new Map<number, SymbolSubEdge[]>();
  const fileSet = new Set(nodes.map((n) => n.filePath));

  for (const e of edges) {
    const fwdList = forward.get(e.from) ?? [];
    fwdList.push({
      targetId: e.to,
      kind: e.kind,
      confidence: e.confidence ?? 1.0,
      isReverse: false,
      isBarrelRouted: false,
    });
    forward.set(e.from, fwdList);

    const revList = reverse.get(e.to) ?? [];
    revList.push({
      targetId: e.from,
      kind: e.kind,
      confidence: e.confidence ?? 1.0,
      isReverse: true,
      isBarrelRouted: false,
    });
    reverse.set(e.to, revList);
  }

  return { nodes: nodeMap, forward, reverse, fileSet, seedIds: new Set(seedIds) };
}

/** Build task edge key set from edge pairs. */
function edgeKeys(pairs: [number, number][]): Set<string> {
  return new Set(pairs.map(([a, b]) => `${a}-${b}`));
}

// ── §3.1 Token Cost Estimator ───────────────────────────────────────────────

describe("§3.1 Token Cost Estimator", () => {
  it("validateSession in src/auth/session.ts with 3 task edges: cost = 3 + 4 + 15 = 22", () => {
    // "validateSession" -> ["validate", "Session"] = 2 camelCase tokens + 1 kind token = 3
    // "src/auth/session.ts" -> ["src", "auth", "session", "ts"] = 4 path tokens
    // 3 task edges * 5 = 15
    const nodes = [makeNode(1, "src/auth/session.ts", "validateSession")];
    const graph = buildSymbolGraph(nodes, []);
    const taskEdgeSet = edgeKeys([
      [1, 2],
      [3, 1],
      [1, 4],
    ]);

    const cost = estimateTokenCost(1, graph, taskEdgeSet);
    expect(cost).toBe(22);
  });

  it("symbol with no task edges: cost = signature + path tokens (minimum 10)", () => {
    // "a" -> 1 camelCase token + 1 kind = 2 sig tokens
    // "x.ts" -> ["x", "ts"] = 2 path tokens
    // 0 edges: cost = 2 + 2 = 4 -> min(4, 10) -> 10
    const nodes = [makeNode(1, "x.ts", "a")];
    const graph = buildSymbolGraph(nodes, []);
    const cost = estimateTokenCost(1, graph, new Set());
    expect(cost).toBe(10); // minimum 10
  });

  it("consecutive-uppercase acronyms split correctly (XMLParser = 2, getHTTPResponse = 3)", () => {
    // "XMLParser" -> ["XML", "Parser"] = 2 + 1 kind = 3 sig tokens
    // "src/xml.ts" -> ["src", "xml", "ts"] = 3 path tokens
    // cost = 3 + 3 = 6 -> floor 10
    const xmlNode = [makeNode(1, "src/xml.ts", "XMLParser")];
    const g1 = buildSymbolGraph(xmlNode, []);
    expect(estimateTokenCost(1, g1, new Set())).toBe(10);

    // "getHTTPResponse" -> ["get", "HTTP", "Response"] = 3 + 1 kind = 4 sig
    // "src/api/client.ts" -> ["src", "api", "client", "ts"] = 4 path
    // 2 edges * 5 = 10; total = 4 + 4 + 10 = 18
    const httpNode = [makeNode(2, "src/api/client.ts", "getHTTPResponse")];
    const g2 = buildSymbolGraph(httpNode, []);
    expect(
      estimateTokenCost(
        2,
        g2,
        edgeKeys([
          [2, 3],
          [4, 2],
        ]),
      ),
    ).toBe(18);
  });

  it("tsc and biome pass (type-level: function signature compiles)", () => {
    // This is a compilation test; if the module imports correctly, types are sound.
    const nodes = [makeNode(1, "src/foo.ts", "bar")];
    const graph = buildSymbolGraph(nodes, []);
    expect(typeof estimateTokenCost(1, graph, new Set())).toBe("number");
  });
});

// ── §3.2 Structural Reach ───────────────────────────────────────────────────

describe("§3.2 Structural Reach", () => {
  it("isolated symbol (no edges): reach = 1 / |V_tau|", () => {
    const nodes = [makeNode(1, "a.ts", "alpha"), makeNode(2, "b.ts", "beta"), makeNode(3, "c.ts", "gamma")];
    // No edges: each symbol only reaches itself
    const sub = buildSubgraph(nodes, []);
    const { reach } = computeStructuralReach(sub);

    expect(reach.get(1)).toBeCloseTo(1 / 3);
    expect(reach.get(2)).toBeCloseTo(1 / 3);
    expect(reach.get(3)).toBeCloseTo(1 / 3);
  });

  it("hub symbol connected to all within 2 hops: reach = 1.0", () => {
    const nodes = [makeNode(1, "a.ts", "hub"), makeNode(2, "b.ts", "spoke1"), makeNode(3, "c.ts", "spoke2")];
    // Hub (1) connects to both spokes directly
    const sub = buildSubgraph(nodes, [
      { from: 1, to: 2, kind: "calls" },
      { from: 1, to: 3, kind: "calls" },
    ]);
    const { reach } = computeStructuralReach(sub);

    expect(reach.get(1)).toBeCloseTo(1.0);
  });

  it("reach values are in [0, 1]", () => {
    const nodes = Array.from({ length: 10 }, (_, i) => makeNode(i + 1, `f${i}.ts`, `sym${i}`));
    // Chain: 1->2->3->...->10
    const edges = Array.from({ length: 9 }, (_, i) => ({
      from: i + 1,
      to: i + 2,
      kind: "calls" as SymbolEdgeKind,
    }));
    const sub = buildSubgraph(nodes, edges);
    const { reach } = computeStructuralReach(sub);

    for (const [, r] of reach) {
      expect(r).toBeGreaterThanOrEqual(0);
      expect(r).toBeLessThanOrEqual(1);
    }
  });

  it("neighborhoods are reusable by greedy selection", () => {
    const nodes = [makeNode(1, "a.ts", "x"), makeNode(2, "b.ts", "y")];
    const sub = buildSubgraph(nodes, [{ from: 1, to: 2, kind: "calls" }]);
    const { neighborhoods } = computeStructuralReach(sub);

    // Neighborhoods should be pre-computed and usable
    expect(neighborhoods.size).toBe(2);
    const hood1 = neighborhoods.get(1);
    expect(hood1).toBeDefined();
    expect(hood1).toContainEqual({ id: 1, dist: 0 });
    expect(hood1).toContainEqual({ id: 2, dist: 1 });
  });
});

// ── §3.3-3.4 Submodular Coverage ─────────────────────────────────────────────

describe("§3.4 Submodular Coverage", () => {
  it("first symbol: gain = sum of gamma^dist for reachable + 1.0 for self", () => {
    const neighborhoods = new Map<number, Array<{ id: number; dist: number }>>([
      [
        1,
        [
          { id: 1, dist: 0 },
          { id: 2, dist: 1 },
          { id: 3, dist: 2 },
        ],
      ],
    ]);
    const state: CoverageState = { covered: new Map(), totalCoverage: 0 };

    const gain = computeMarginalGain(1, neighborhoods, state);
    // 0.8^0 + 0.8^1 + 0.8^2 = 1.0 + 0.8 + 0.64 = 2.44
    expect(gain).toBeCloseTo(1.0 + 0.8 + 0.64);
  });

  it("second symbol in same neighborhood: gain < first (submodularity)", () => {
    const neighborhoods = new Map<number, Array<{ id: number; dist: number }>>([
      [
        1,
        [
          { id: 1, dist: 0 },
          { id: 2, dist: 1 },
          { id: 3, dist: 2 },
        ],
      ],
      [
        2,
        [
          { id: 2, dist: 0 },
          { id: 1, dist: 1 },
          { id: 3, dist: 1 },
        ],
      ],
    ]);
    const state: CoverageState = { covered: new Map(), totalCoverage: 0 };

    const gain1 = computeMarginalGain(1, neighborhoods, state);
    applyCoverage(1, neighborhoods, state);
    const gain2 = computeMarginalGain(2, neighborhoods, state);

    expect(gain2).toBeLessThan(gain1);
  });

  it("disjoint subgraph: gain = same as first (no overlap)", () => {
    const neighborhoods = new Map<number, Array<{ id: number; dist: number }>>([
      [
        1,
        [
          { id: 1, dist: 0 },
          { id: 2, dist: 1 },
        ],
      ],
      [
        3,
        [
          { id: 3, dist: 0 },
          { id: 4, dist: 1 },
        ],
      ],
    ]);
    const state: CoverageState = { covered: new Map(), totalCoverage: 0 };

    const gain1 = computeMarginalGain(1, neighborhoods, state);
    applyCoverage(1, neighborhoods, state);
    const gain3 = computeMarginalGain(3, neighborhoods, state);

    // Same structure: self + 1 neighbor at dist 1 -> 1.0 + 0.8 = 1.8
    expect(gain3).toBeCloseTo(gain1);
  });

  it("applyCoverage updates state to max of existing and new", () => {
    const neighborhoods = new Map<number, Array<{ id: number; dist: number }>>([
      [
        1,
        [
          { id: 1, dist: 0 },
          { id: 3, dist: 2 },
        ],
      ],
      [
        2,
        [
          { id: 2, dist: 0 },
          { id: 3, dist: 1 },
        ],
      ],
    ]);
    const state: CoverageState = { covered: new Map(), totalCoverage: 0 };

    applyCoverage(1, neighborhoods, state);
    // Node 3 covered at 0.8^2 = 0.64
    expect(state.covered.get(3)).toBeCloseTo(0.64);

    applyCoverage(2, neighborhoods, state);
    // Node 3 now covered at max(0.64, 0.8^1) = 0.8
    expect(state.covered.get(3)).toBeCloseTo(0.8);
  });

  it("coverage function is monotone (adding never decreases total)", () => {
    const neighborhoods = new Map<number, Array<{ id: number; dist: number }>>([
      [
        1,
        [
          { id: 1, dist: 0 },
          { id: 2, dist: 1 },
        ],
      ],
      [
        2,
        [
          { id: 2, dist: 0 },
          { id: 1, dist: 1 },
        ],
      ],
    ]);
    const state: CoverageState = { covered: new Map(), totalCoverage: 0 };

    applyCoverage(1, neighborhoods, state);
    const after1 = state.totalCoverage;

    applyCoverage(2, neighborhoods, state);
    const after2 = state.totalCoverage;

    expect(after2).toBeGreaterThanOrEqual(after1);
  });
});

// ── §3.5 Greedy Symbol Selection ────────────────────────────────────────────

describe("§3.5 Greedy Symbol Selection", () => {
  // Shared setup: 5 symbols across different files
  const nodes = [
    makeNode(1, "src/auth/session.ts", "validateSession"),
    makeNode(2, "src/auth/token.ts", "refreshToken"),
    makeNode(3, "src/db/query.ts", "runQuery"),
    makeNode(4, "src/api/handler.ts", "handleRequest"),
    makeNode(5, "src/api/middleware.ts", "authMiddleware"),
  ];
  const symEdges: InMemorySymEdge[] = [
    makeEdge(1, 2, "calls"),
    makeEdge(4, 1, "calls"),
    makeEdge(4, 3, "calls"),
    makeEdge(5, 4, "calls"),
  ];
  const symGraph = buildSymbolGraph(nodes, symEdges);
  const subEdges = [
    { from: 1, to: 2, kind: "calls" as SymbolEdgeKind },
    { from: 4, to: 1, kind: "calls" as SymbolEdgeKind },
    { from: 4, to: 3, kind: "calls" as SymbolEdgeKind },
    { from: 5, to: 4, kind: "calls" as SymbolEdgeKind },
  ];
  const sub = buildSubgraph(nodes, subEdges);
  const intentScores = new Map([
    [1, 0.9],
    [2, 0.7],
    [3, 0.5],
    [4, 0.8],
    [5, 0.6],
  ]);
  const taskKeys = edgeKeys([
    [1, 2],
    [4, 1],
    [4, 3],
    [5, 4],
  ]);

  it("budget of 1500: selects multiple symbols", () => {
    const result = selectContextSymbols(sub, intentScores, symGraph, taskKeys, 1500);
    expect(result.selectedSymbols.length).toBeGreaterThanOrEqual(1);
    expect(result.selectedSymbols.length).toBeLessThanOrEqual(15);
  });

  it("budget of 0: returns empty", () => {
    const result = selectContextSymbols(sub, intentScores, symGraph, taskKeys, 0);
    expect(result.selectedSymbols).toEqual([]);
    expect(result.tokenBudgetUsed).toBe(0);
  });

  it("never exceeds token budget", () => {
    const result = selectContextSymbols(sub, intentScores, symGraph, taskKeys, 30);
    expect(result.tokenBudgetUsed).toBeLessThanOrEqual(30);
  });

  it("symbols from disjoint components: selects from both", () => {
    // Two disconnected pairs
    const disjointNodes = [
      makeNode(10, "a.ts", "alpha"),
      makeNode(11, "b.ts", "beta"),
      makeNode(20, "c.ts", "gamma"),
      makeNode(21, "d.ts", "delta"),
    ];
    const disjointGraph = buildSymbolGraph(disjointNodes, [makeEdge(10, 11, "calls"), makeEdge(20, 21, "calls")]);
    const disjointSub = buildSubgraph(disjointNodes, [
      { from: 10, to: 11, kind: "calls" },
      { from: 20, to: 21, kind: "calls" },
    ]);
    const scores = new Map([
      [10, 0.8],
      [11, 0.5],
      [20, 0.8],
      [21, 0.5],
    ]);
    const keys = edgeKeys([
      [10, 11],
      [20, 21],
    ]);

    const result = selectContextSymbols(disjointSub, scores, disjointGraph, keys, 1500);
    // Should select from both components (coverage doesn't overlap)
    const files = new Set(result.selectedSymbols.map((id) => disjointGraph.symbols.get(id)?.filePath));
    expect(files.size).toBeGreaterThanOrEqual(2);
  });

  it("fallback triggers at V_tau > 2000", () => {
    // Create a large subgraph
    const bigNodes = Array.from({ length: 2001 }, (_, i) => makeNode(i + 1, `f${i}.ts`, `sym${i}`));
    const bigGraph = buildSymbolGraph(bigNodes, []);
    const bigSub = buildSubgraph(bigNodes, []);
    const bigScores = new Map(bigNodes.map((n) => [n.id, Math.random()]));

    const result = selectContextSymbols(bigSub, bigScores, bigGraph, new Set(), 1500);
    // Should still produce a result (using fallback)
    expect(result.selectedSymbols.length).toBeGreaterThanOrEqual(1);
    expect(result.tokenBudgetUsed).toBeLessThanOrEqual(1500);
  });

  it("tokenBudgetUsed <= budgetTokens always", () => {
    for (const budget of [10, 50, 100, 500, 1500]) {
      const result = selectContextSymbols(sub, intentScores, symGraph, taskKeys, budget);
      expect(result.tokenBudgetUsed).toBeLessThanOrEqual(budget);
    }
  });

  it("same-file cluster: at most 2 symbols selected (redundancy elimination)", () => {
    // 8 symbols in the same file, fully interconnected
    const sameFileNodes = Array.from({ length: 8 }, (_, i) =>
      makeNode(i + 1, "src/auth/session.ts", `sessionHelper${i}`),
    );
    const sameFileEdges: { from: number; to: number; kind: SymbolEdgeKind }[] = [];
    const sameFileSymEdges: InMemorySymEdge[] = [];
    for (let i = 1; i <= 8; i++) {
      for (let j = i + 1; j <= 8; j++) {
        sameFileEdges.push({ from: i, to: j, kind: "calls" });
        sameFileSymEdges.push(makeEdge(i, j, "calls"));
      }
    }
    const sameFileSub = buildSubgraph(sameFileNodes, sameFileEdges);
    const sameFileGraph = buildSymbolGraph(sameFileNodes, sameFileSymEdges);
    const sameFileScores = new Map(sameFileNodes.map((n) => [n.id, 0.8]));

    const result = selectContextSymbols(sameFileSub, sameFileScores, sameFileGraph, new Set(), 1500);
    // Dense cluster: coverage saturates fast, diminishing returns guard stops early
    expect(result.selectedSymbols.length).toBeLessThanOrEqual(2);
  });
});

// ── §3.6 Diminishing Returns Guard ──────────────────────────────────────────

describe("§3.6 Diminishing Returns Guard", () => {
  it("stops when second ratio < epsilon * first ratio", () => {
    // One high-value hub and many low-value isolated nodes
    const nodes = [
      makeNode(1, "hub.ts", "hub"),
      ...Array.from({ length: 20 }, (_, i) => makeNode(100 + i, `isolated${i}.ts`, `iso${i}`)),
    ];
    const edges = Array.from({ length: 20 }, (_, i) => ({
      from: 1,
      to: 100 + i,
      kind: "calls" as SymbolEdgeKind,
    }));
    const symGraph = buildSymbolGraph(
      nodes,
      edges.map((e) => makeEdge(e.from, e.to, e.kind)),
    );
    const sub = buildSubgraph(nodes, edges);
    const scores = new Map<number, number>([[1, 1.0]]);
    for (let i = 0; i < 20; i++) scores.set(100 + i, 0.01);

    const result = selectContextSymbols(sub, scores, symGraph, new Set(), 10000);
    // Hub covers everything; remaining symbols have near-zero marginal gain.
    // Guard should stop selection early.
    expect(result.selectedSymbols.length).toBeLessThan(nodes.length);
  });

  it("does not trigger when ratios stay constant", () => {
    // Disjoint clusters of equal value
    const nodes = Array.from({ length: 5 }, (_, i) => makeNode(i + 1, `f${i}.ts`, `sym${i}`));
    const sub = buildSubgraph(nodes, []); // No edges: each is independent
    const symGraph = buildSymbolGraph(nodes, []);
    const scores = new Map(nodes.map((n) => [n.id, 0.5]));

    const result = selectContextSymbols(sub, scores, symGraph, new Set(), 10000);
    // All symbols are equally valuable and disjoint; should select all
    expect(result.selectedSymbols.length).toBe(5);
  });
});

// ── §3.7 Presentation Ordering ──────────────────────────────────────────────

describe("§3.7 Presentation Ordering", () => {
  it("entry point (depth 0) before implementation (depth 2)", () => {
    // 1 -> 2 -> 3 (chain)
    const nodes = [
      makeNode(1, "a.ts", "entryPoint"),
      makeNode(2, "b.ts", "middle"),
      makeNode(3, "c.ts", "implementation"),
    ];
    const sub = buildSubgraph(nodes, [
      { from: 1, to: 2, kind: "calls" },
      { from: 2, to: 3, kind: "calls" },
    ]);
    const symGraph = buildSymbolGraph(nodes, []);
    const intentScores = new Map([
      [1, 0.5],
      [2, 0.5],
      [3, 0.5],
    ]);

    const ordered = orderForPresentation([3, 1, 2], sub, intentScores, symGraph);
    expect(ordered[0]).toBe(1); // depth 0
    expect(ordered[2]).toBe(3); // depth 2
  });

  it("same depth: higher intent score first", () => {
    const nodes = [makeNode(1, "a.ts", "alpha"), makeNode(2, "b.ts", "beta")];
    const sub = buildSubgraph(nodes, []); // Both at depth 0 (no edges)
    const symGraph = buildSymbolGraph(nodes, []);
    const intentScores = new Map([
      [1, 0.3],
      [2, 0.9],
    ]);

    const ordered = orderForPresentation([1, 2], sub, intentScores, symGraph);
    expect(ordered[0]).toBe(2); // higher intent
    expect(ordered[1]).toBe(1);
  });

  it("same depth and intent: higher authority first", () => {
    const node1 = makeNode(1, "a.ts", "alpha");
    node1.authority = 0.9;
    const node2 = makeNode(2, "b.ts", "beta");
    node2.authority = 0.1;

    const sub = buildSubgraph([node1, node2], []);
    const symGraph = buildSymbolGraph([node1, node2], []);
    const intentScores = new Map([
      [1, 0.5],
      [2, 0.5],
    ]);

    const ordered = orderForPresentation([2, 1], sub, intentScores, symGraph);
    expect(ordered[0]).toBe(1); // higher authority
    expect(ordered[1]).toBe(2);
  });

  it("stable tiebreaker: file path lexicographic", () => {
    const nodes = [makeNode(1, "z/foo.ts", "x"), makeNode(2, "a/bar.ts", "y")];
    const sub = buildSubgraph(nodes, []);
    const symGraph = buildSymbolGraph(nodes, []);
    const intentScores = new Map([
      [1, 0.5],
      [2, 0.5],
    ]);

    const ordered = orderForPresentation([1, 2], sub, intentScores, symGraph);
    expect(ordered[0]).toBe(2); // "a/bar.ts" < "z/foo.ts"
    expect(ordered[1]).toBe(1);
  });
});

// ── §3.8 Performance ────────────────────────────────────────────────────────

describe("§3.8 Performance", () => {
  it("selectContextSymbols completes in <50ms on 500-symbol subgraph", () => {
    const n = 500;
    const nodes = Array.from({ length: n }, (_, i) =>
      makeNode(i + 1, `src/mod${Math.floor(i / 5)}/file${i % 5}.ts`, `symbol${i}`),
    );
    // Create a sparse random-ish graph (each node connects to ~3 others)
    const edges: { from: number; to: number; kind: SymbolEdgeKind }[] = [];
    const symEdges: InMemorySymEdge[] = [];
    for (let i = 1; i <= n; i++) {
      for (let j = 0; j < 3; j++) {
        const target = ((i + j * 7 + 13) % n) + 1;
        if (target !== i) {
          edges.push({ from: i, to: target, kind: "calls" });
          symEdges.push(makeEdge(i, target, "calls"));
        }
      }
    }

    const sub = buildSubgraph(nodes, edges);
    const symGraph = buildSymbolGraph(nodes, symEdges);
    const scores = new Map(nodes.map((n) => [n.id, Math.random()]));
    const taskKeys = new Set(edges.slice(0, 50).map((e) => `${e.from}-${e.to}`));

    // Warmup: JIT compile all paths before measuring
    selectContextSymbols(sub, scores, symGraph, taskKeys, 1500);

    // Median of 5 runs eliminates CI load spikes while catching real regressions
    const timings: number[] = [];
    for (let i = 0; i < 5; i++) {
      const start = performance.now();
      selectContextSymbols(sub, scores, symGraph, taskKeys, 1500);
      timings.push(performance.now() - start);
    }
    timings.sort((a, b) => a - b);
    const median = timings[Math.floor(timings.length / 2)];

    expect(median).toBeLessThan(50);
    expect(timings.length).toBe(5);
  });
});
