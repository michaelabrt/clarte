/**
 * Verification and smart silence validation gate tests.
 *
 * Covers:
 * - Theory of Impact generator (5 criteria + anti-fabrication + token intersection)
 * - Verification protocol (7 criteria)
 * - Confidence calibration (4 criteria)
 * - Smart Silence (6 criteria)
 * - Staleness Guard (4 criteria)
 * - Integration test
 * - Score inflation invariant
 * - Confidence product attenuation
 * - Per-prediction staleness flag
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InMemorySymbolNode, InMemorySymEdge } from "../storage/types";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { IntentPrediction, TheoryOfImpact } from "../core/config/intent-constants";
import { generateTheoryOfImpact } from "../steer/theory-of-impact";
import { verifyPredictions } from "../steer/intent-verification";
import { evaluateSmartSilence } from "../steer/smart-silence";
import { fuseIntentScores } from "../steer/intent-fusion";
import { computePathConfidenceProducts } from "../steer/intent-propagation";
import type { SymbolSubgraph, SymbolSubEdge } from "../core/graph/intent-subgraph";
import {
  THETA_HIGH,
  THETA_LOW,
  STALE_GRAPH_DISCOUNT,
  LAMBDA_LEXICAL,
  LAMBDA_GRAPH,
  LAMBDA_TEMPORAL,
  LAMBDA_BETWEENNESS,
} from "../core/config/intent-constants";

// Mock node:fs
import * as fs from "node:fs";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => true) };
});
const mockedExistsSync = vi.mocked(fs.existsSync);

// ── Helpers ─────────────────────────────────────────────────────────────────

function makeNode(id: number, filePath: string, name: string): InMemorySymbolNode {
  return { id, filePath, name, kind: "function", startLine: 1, isExported: true };
}

function makeEdge(from: number, to: number, kind: SymbolEdgeKind, confidence = 1.0): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind, confidence };
}

function buildSymbolGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]) {
  const symbols = new Map(nodes.map((n) => [n.id, n]));
  const byFile = new Map<string, number[]>();
  const forward = new Map<number, InMemorySymEdge[]>();
  const reverse = new Map<number, InMemorySymEdge[]>();

  for (const n of nodes) {
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
  seedIds: number[],
): SymbolSubgraph {
  const nodeMap = new Map(nodes.map((n) => [n.id, n]));
  const forward = new Map<number, SymbolSubEdge[]>();
  const reverse = new Map<number, SymbolSubEdge[]>();

  for (const e of edges) {
    const conf = e.confidence ?? 1.0;
    const fwd = forward.get(e.from) ?? [];
    fwd.push({ targetId: e.to, kind: e.kind, confidence: conf, isReverse: false, isBarrelRouted: false });
    forward.set(e.from, fwd);
    const rev = reverse.get(e.to) ?? [];
    rev.push({ targetId: e.from, kind: e.kind, confidence: conf, isReverse: true, isBarrelRouted: false });
    reverse.set(e.to, rev);
  }

  return {
    nodes: nodeMap,
    forward,
    reverse,
    fileSet: new Set(nodes.map((n) => n.filePath)),
    seedIds: new Set(seedIds),
  };
}

const sig = { lexical: 0, rawLexical: 0, graph: 0, temporal: 0, betweenness: 0 };

function makePrediction(
  file: string,
  score: number,
  signals: IntentPrediction["signals"],
  theory?: Partial<TheoryOfImpact>,
  symbols?: IntentPrediction["symbols"],
): IntentPrediction {
  return {
    file,
    rank: 1,
    score,
    confidence: score > THETA_HIGH ? "high" : "medium",
    isStale: false,
    signals,
    theory: { lexical_evidence: null, graph_path: null, temporal_pair: null, betweenness_rank: null, ...theory },
    verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
    symbols: symbols ?? [],
  };
}

beforeEach(() => mockedExistsSync.mockReturnValue(true));
afterEach(() => {
  mockedExistsSync.mockReset();
  mockedExistsSync.mockReturnValue(true);
});

// ── Theory of Impact Generator ──────────────────────────────────────────────

describe("generateTheoryOfImpact", () => {
  it("lexical-only prediction has lexical_evidence non-null, rest null", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fetchUser")], []);
    const signals = { ...sig, rawLexical: 5.0 };

    const toi = generateTheoryOfImpact(
      "a.ts",
      signals,
      1,
      new Map(),
      graph,
      new Set(),
      new Map(),
      new Map(),
      "fetch user data",
    );

    expect(toi.lexical_evidence).not.toBeNull();
    expect(toi.lexical_evidence).toContain("fetch");
    expect(toi.graph_path).toBeNull();
    expect(toi.temporal_pair).toBeNull();
    expect(toi.betweenness_rank).toBeNull();
  });

  it("graph-only prediction has graph_path with hop count and edge kinds", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "extends")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[3, [1, 2, 3]]]);
    const signals = { ...sig, graph: 0.56 };

    const toi = generateTheoryOfImpact(
      "c.ts",
      signals,
      3,
      paths,
      graph,
      new Set(["a.ts"]),
      new Map(),
      new Map(),
      "find fnA",
    );

    expect(toi.graph_path).not.toBeNull();
    expect(toi.graph_path).toContain("2-hop");
    expect(toi.graph_path).toContain("fnA");
    expect(toi.graph_path).toContain("calls");
    expect(toi.graph_path).toContain("extends");
    expect(toi.lexical_evidence).toBeNull();
  });

  it("multiple non-zero signals produce non-null evidence for each", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const edges = [makeEdge(1, 2, "calls")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[2, [1, 2]]]);
    const coupling = new Map([["b.ts", new Map([["a.ts", 0.7]])]]);
    const betweenness = new Map([
      [2, 0.8],
      [1, 0.2],
    ]);
    const signals = { lexical: 0.5, rawLexical: 3.0, graph: 0.7, temporal: 0.7, betweenness: 0.8 };

    const toi = generateTheoryOfImpact(
      "b.ts",
      signals,
      2,
      paths,
      graph,
      new Set(["a.ts"]),
      coupling,
      betweenness,
      "fix fnB",
    );

    expect(toi.lexical_evidence).not.toBeNull();
    expect(toi.graph_path).not.toBeNull();
    expect(toi.temporal_pair).not.toBeNull();
    expect(toi.betweenness_rank).not.toBeNull();
  });

  it("graph path gamma is the product of transmission coefficients", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "extends")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[3, [1, 2, 3]]]);
    const signals = { ...sig, graph: 0.56 };

    const toi = generateTheoryOfImpact(
      "c.ts",
      signals,
      3,
      paths,
      graph,
      new Set(["a.ts"]),
      new Map(),
      new Map(),
      "test",
    );

    expect(toi.graph_path).toContain("gamma: 0.56");
  });

  it("temporal evidence identifies best seed file", () => {
    const graph = buildSymbolGraph([makeNode(1, "target.ts", "fnT")], []);
    const coupling = new Map([
      [
        "target.ts",
        new Map([
          ["s1.ts", 0.6],
          ["s2.ts", 0.85],
        ]),
      ],
    ]);
    const signals = { ...sig, temporal: 0.85 };

    const toi = generateTheoryOfImpact(
      "target.ts",
      signals,
      1,
      new Map(),
      graph,
      new Set(["s1.ts", "s2.ts"]),
      coupling,
      new Map(),
      "test",
    );

    expect(toi.temporal_pair).toContain("s2.ts");
    expect(toi.temporal_pair).toContain("0.85");
  });

  it("returns null graph_path when edge is unresolvable (anti-fabrication)", () => {
    // Path claims [1, 2, 3] but edge 2->3 doesn't exist in graph
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")];
    const edges = [makeEdge(1, 2, "calls")]; // no 2->3 edge
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[3, [1, 2, 3]]]);
    const signals = { ...sig, graph: 0.5 };

    const toi = generateTheoryOfImpact("c.ts", signals, 3, paths, graph, new Set(), new Map(), new Map(), "test");

    expect(toi.graph_path).toBeNull(); // Must NOT fabricate
  });

  it("lexical evidence uses query token intersection", () => {
    const graph = buildSymbolGraph([makeNode(1, "src/auth/session.ts", "validateSession")], []);
    const signals = { ...sig, rawLexical: 5.0 };

    const toi = generateTheoryOfImpact(
      "src/auth/session.ts",
      signals,
      1,
      new Map(),
      graph,
      new Set(),
      new Map(),
      new Map(),
      "fix validateSession bug",
    );

    // Should contain matched tokens, not just symbol name
    expect(toi.lexical_evidence).toContain("validate");
    expect(toi.lexical_evidence).toContain("Session");
  });

  it("F2: graph_path includes confidence product from edge resolution tiers", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const edges = [makeEdge(1, 2, "calls", 0.25)]; // Tier-3 factory
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[2, [1, 2]]]);
    const signals = { ...sig, graph: 0.7 };

    const toi = generateTheoryOfImpact(
      "b.ts",
      signals,
      2,
      paths,
      graph,
      new Set(["a.ts"]),
      new Map(),
      new Map(),
      "test",
    );

    expect(toi.graph_path).toContain("confidence: 0.25");
  });
});

// ── Verification Protocol ───────────────────────────────────────────────────

describe("verifyPredictions", () => {
  it("missing edge zeros graph signal and recomputes score", () => {
    const graph = buildSymbolGraph(
      [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")],
      [makeEdge(1, 2, "calls")],
    );

    const pred = makePrediction(
      "c.ts",
      0.6,
      { lexical: 0.5, rawLexical: 0.5, graph: 0.5, temporal: 0, betweenness: 0 },
      { graph_path: "2-hop from fnA via calls -> calls (gamma: 0.49, confidence: 1.00)" },
      [{ name: "fnC", score: 0.5, line: 3 }],
    );

    const paths = new Map([[3, [1, 2, 3]]]);
    const topIds = new Map([["c.ts", 3]]);

    const result = verifyPredictions([pred], graph, "/root", paths, topIds);

    expect(result.length).toBe(1);
    expect(result[0].verification.edge_exists).toBe(false);
    expect(result[0].signals.graph).toBe(0);
    expect(result[0].score).toBeCloseTo(LAMBDA_LEXICAL * 0.5, 10);
  });

  it("deleted file removes prediction from output", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA")], []);
    const pred = makePrediction("deleted.ts", 0.8, { ...sig, lexical: 1.0, rawLexical: 1.0 });
    mockedExistsSync.mockReturnValue(false);

    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map());

    expect(result.length).toBe(0);
  });

  it("missing symbol flags symbol_exists but retains prediction", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA")], []);
    const pred = makePrediction("a.ts", 0.5, { ...sig, lexical: 0.5, rawLexical: 0.5 }, {}, [
      { name: "missingSymbol", score: 0.5, line: 99 },
    ]);

    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map());

    expect(result.length).toBe(1);
    expect(result[0].verification.symbol_exists).toBe(false);
  });

  it("non-monotonic pair flagged", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], []);
    const sameSignals = { lexical: 0.5, rawLexical: 0.5, graph: 0.3, temporal: 0.2, betweenness: 0.1 };
    const pred1 = makePrediction("a.ts", 0.5, { ...sameSignals });
    const pred2 = makePrediction("b.ts", 0.49, { ...sameSignals });

    const result = verifyPredictions([pred1, pred2], graph, "/root", new Map(), new Map());

    expect(result.length).toBe(2);
    expect(result[1].verification.monotonic).toBe(false);
  });

  it("all checks pass on valid data", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], [makeEdge(1, 2, "calls")]);
    const pred = makePrediction(
      "a.ts",
      0.8,
      { lexical: 0.8, rawLexical: 0.8, graph: 0.7, temporal: 0, betweenness: 0 },
      { graph_path: "1-hop from fnA via calls (gamma: 0.70, confidence: 1.00)" },
      [{ name: "fnA", score: 0.8, line: 1 }],
    );
    const paths = new Map([[1, [1, 2]]]);
    const topIds = new Map([["a.ts", 1]]);

    const result = verifyPredictions([pred], graph, "/root", paths, topIds);

    expect(result.length).toBe(1);
    expect(result[0].verification.edge_exists).toBe(true);
    expect(result[0].verification.file_exists).toBe(true);
    expect(result[0].verification.symbol_exists).toBe(true);
    expect(result[0].verification.monotonic).toBe(true);
  });

  it("re-scoring preserves rank order", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], [makeEdge(1, 2, "calls")]);
    const pred1 = makePrediction("a.ts", 0.9, {
      lexical: 0.9,
      rawLexical: 0.9,
      graph: 0.8,
      temporal: 0,
      betweenness: 0,
    });
    const pred2 = makePrediction("b.ts", 0.6, {
      lexical: 0.6,
      rawLexical: 0.6,
      graph: 0.3,
      temporal: 0,
      betweenness: 0,
    });

    const result = verifyPredictions([pred2, pred1], graph, "/root", new Map(), new Map());

    expect(result[0].file).toBe("a.ts");
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });
});

// ── Confidence Calibration ──────────────────────────────────────────────────

describe("confidence calibration", () => {
  it("score 0.85 -> high", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.85, { ...sig, lexical: 1.0, rawLexical: 1.0, graph: 0.8 });
    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map());
    expect(result[0].confidence).toBe("high");
  });

  it("score 0.45 -> medium", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.45, { ...sig, lexical: 0.45, rawLexical: 0.45 });
    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map());
    expect(result[0].confidence).toBe("medium");
  });

  it("score exactly at THETA_HIGH boundary -> medium", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", THETA_HIGH, { ...sig, lexical: 0.7, rawLexical: 0.7 });
    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map());
    expect(result[0].confidence).toBe("medium");
  });
});

// ── Smart Silence ───────────────────────────────────────────────────────────

describe("evaluateSmartSilence", () => {
  it("empty predictions -> suppress", () => {
    const result = evaluateSmartSilence([], "fix the bug", 50, "abc", "def", [], []);
    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });

  it("all predictions below THETA_LOW -> suppress", () => {
    const preds = [
      makePrediction("a.ts", 0.2, { ...sig, lexical: 0.2, rawLexical: 0.2 }),
      makePrediction("b.ts", 0.1, { ...sig, lexical: 0.1, rawLexical: 0.1 }),
    ];
    const result = evaluateSmartSilence(preds, "fix the bug", 50, "abc", "def", [], ["a.ts", "b.ts"]);
    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });

  it("query mentioning predicted file -> suppress", () => {
    const preds = [makePrediction("src/foo/bar.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8 })];
    const result = evaluateSmartSilence(
      preds,
      "fix the bug in src/foo/bar.ts",
      50,
      "abc",
      "def",
      [],
      ["src/foo/bar.ts"],
    );
    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("explicit paths");
  });

  it("50% of predicted files changed -> stale graph fallback", () => {
    const preds = [
      makePrediction("a.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8, graph: 0.5 }),
      makePrediction("b.ts", 0.7, { ...sig, lexical: 0.7, rawLexical: 0.7, graph: 0.3 }),
    ];
    const result = evaluateSmartSilence(preds, "fix the bug", 50, "abc", "def", ["a.ts", "c.ts"], ["a.ts", "b.ts"]);
    expect(result.shouldSuppress).toBe(false);
    expect(result.reason).toBe("stale graph");
    expect(result.fallbackToLexical).toBe(true);
  });

  it("3-file project -> suppress", () => {
    const preds = [makePrediction("a.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8 })];
    const result = evaluateSmartSilence(preds, "fix the bug", 3, "abc", "def", [], ["a.ts"]);
    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("small project");
  });

  it("normal case -> no suppression", () => {
    const preds = [makePrediction("a.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8, graph: 0.5 })];
    const result = evaluateSmartSilence(preds, "fix the validation bug", 50, "abc", "def", [], ["a.ts"]);
    expect(result.shouldSuppress).toBe(false);
    expect(result.reason).toBeNull();
  });

  it("condition priority - threshold before explicit paths", () => {
    const preds = [makePrediction("src/foo.ts", THETA_LOW, { ...sig, lexical: 0.3, rawLexical: 0.3 })];
    const result = evaluateSmartSilence(preds, "fix src/foo.ts", 50, "abc", "def", [], ["src/foo.ts"]);
    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });
});

// ── Staleness Guard ─────────────────────────────────────────────────────────

describe("staleness guard", () => {
  it("fresh graph - full weight", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0.8, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set());
    const expected = LAMBDA_LEXICAL * 1.0 + LAMBDA_GRAPH * 0.8;
    expect(result.get(1)?.score).toBeCloseTo(expected, 10);
  });

  it("stale graph - graph signal halved", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0.8, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set(), STALE_GRAPH_DISCOUNT);
    const expected = LAMBDA_LEXICAL * 1.0 + LAMBDA_GRAPH * 0.4;
    expect(result.get(1)?.score).toBeCloseTo(expected, 10);
  });

  it("stale discount formula correct", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 1.0, betweennessScore: 0.5 }];
    const coupling = new Map([["a.ts", new Map([["seed.ts", 0.6]])]]);
    const result = fuseIntentScores(inputs, coupling, new Set(["seed.ts"]), STALE_GRAPH_DISCOUNT);
    const expected = LAMBDA_LEXICAL * 0 + LAMBDA_GRAPH * 0.5 + LAMBDA_TEMPORAL * 0.6 + LAMBDA_BETWEENNESS * 0.5;
    expect(result.get(1)?.score).toBeCloseTo(expected, 10);
  });

  it("undefined staleDiscount does not affect graph signal", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 0.6, betweennessScore: 0 }];
    const a = fuseIntentScores(inputs, new Map(), new Set(), undefined);
    const b = fuseIntentScores(inputs, new Map(), new Set());
    expect(a.get(1)?.score).toBe(b.get(1)?.score);
  });
});

// ── F1: Score inflation invariant ───────────────────────────────────────────

describe("F1 invariant", () => {
  it("zeroing graph signal with high BM25+ score (>1.0) always decreases score", () => {
    // Raw BM25+ scores: 8.0 and 4.0. maxLexical = 8.0.
    const inputs = [
      { symbolId: 1, filePath: "a.ts", lexicalScore: 8.0, graphScore: 0.6, betweennessScore: 0 },
      { symbolId: 2, filePath: "b.ts", lexicalScore: 4.0, graphScore: 0.3, betweennessScore: 0 },
    ];
    const fused = fuseIntentScores(inputs, new Map(), new Set());
    const original = fused.get(1) ?? expect.unreachable("symbol 1 missing");

    // signals.lexical must be normalized [0,1], NOT raw 8.0
    expect(original.signals.lexical).toBe(1.0); // 8.0/8.0
    expect(original.signals.rawLexical).toBe(8.0); // raw preserved for ToI

    // Zero graph signal and recompute using the same formula as recomputeScore
    const recomputed =
      LAMBDA_LEXICAL * original.signals.lexical +
      LAMBDA_GRAPH * 0 + // zeroed
      LAMBDA_TEMPORAL * original.signals.temporal +
      LAMBDA_BETWEENNESS * original.signals.betweenness;

    // Invariant: penalty always decreases score
    expect(recomputed).toBeLessThan(original.score);
    // Score must be bounded in [0,1]
    expect(recomputed).toBeLessThanOrEqual(1.0);
    expect(recomputed).toBeGreaterThanOrEqual(0);
  });

  it("recomputed score equals original when no signal is zeroed", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 5.0, graphScore: 0.7, betweennessScore: 0.3 }];
    const coupling = new Map([["a.ts", new Map([["seed.ts", 0.6]])]]);
    const fused = fuseIntentScores(inputs, coupling, new Set(["seed.ts"]));
    const s = fused.get(1) ?? expect.unreachable("symbol 1 missing");

    const recomputed =
      LAMBDA_LEXICAL * s.signals.lexical +
      LAMBDA_GRAPH * s.signals.graph +
      LAMBDA_TEMPORAL * s.signals.temporal +
      LAMBDA_BETWEENNESS * s.signals.betweenness;

    expect(recomputed).toBeCloseTo(s.score, 10);
  });
});

// ── F2: Confidence product attenuation ──────────────────────────────────────

describe("F2 confidence product", () => {
  it("computePathConfidenceProducts multiplies edge confidences along path", () => {
    const nodes = [makeNode(1, "a.ts", "A"), makeNode(2, "b.ts", "B"), makeNode(3, "c.ts", "C")];
    const sub = buildSubgraph(
      nodes,
      [
        { from: 1, to: 2, kind: "calls", confidence: 0.95 },
        { from: 2, to: 3, kind: "calls", confidence: 0.25 },
      ],
      [1],
    );
    const paths = new Map([[3, [1, 2, 3]]]);

    const products = computePathConfidenceProducts(paths, sub);

    expect(products.get(3)).toBeCloseTo(0.95 * 0.25, 10);
  });

  it("seed symbols have confidence product 1.0", () => {
    const nodes = [makeNode(1, "a.ts", "A")];
    const sub = buildSubgraph(nodes, [], [1]);
    const paths = new Map([[1, [] as number[]]]);

    const products = computePathConfidenceProducts(paths, sub);

    expect(products.get(1)).toBe(1.0);
  });

  it("3-hop Tier-3 factory chain produces near-zero graph contribution", () => {
    // 3 hops of calls with Tier-3 factory confidence (0.25)
    const inputs = [
      {
        symbolId: 4,
        filePath: "d.ts",
        lexicalScore: 0,
        graphScore: 0.343, // 0.7^3 calls chain
        betweennessScore: 0,
        pathConfidence: 0.25 ** 3, // Tier-3 factory chain
      },
    ];

    const fused = fuseIntentScores(inputs, new Map(), new Set());
    const entry = fused.get(4);
    expect(entry).toBeDefined();

    // G_effective = 0.343 * 0.016 = 0.005, contribution = 0.35 * 0.005 = 0.002
    expect(entry?.score).toBeCloseTo(LAMBDA_GRAPH * 0.343 * 0.25 ** 3, 4);
    expect(entry?.score).toBeLessThan(THETA_LOW); // Below silence threshold
  });

  it("Tier-1 direct chain produces 54x higher contribution than Tier-3", () => {
    const tier1 = [
      {
        symbolId: 1,
        filePath: "a.ts",
        lexicalScore: 0,
        graphScore: 0.343,
        betweennessScore: 0,
        pathConfidence: 0.95 ** 3,
      },
    ];
    const tier3 = [
      {
        symbolId: 1,
        filePath: "a.ts",
        lexicalScore: 0,
        graphScore: 0.343,
        betweennessScore: 0,
        pathConfidence: 0.25 ** 3,
      },
    ];

    const e1 = fuseIntentScores(tier1, new Map(), new Set()).get(1);
    const e3 = fuseIntentScores(tier3, new Map(), new Set()).get(1);
    expect(e1).toBeDefined();
    expect(e3).toBeDefined();

    expect((e1?.score ?? 0) / (e3?.score ?? 1)).toBeGreaterThan(50);
  });
});

// ── F3: Per-prediction staleness ────────────────────────────────────────────

describe("F3 staleness flag", () => {
  it("isStale=true when prediction file is in changedFilesSinceGraph", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8 });
    const changed = new Set(["a.ts"]);

    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map(), changed);

    expect(result[0].isStale).toBe(true);
  });

  it("isStale=true when a symbol in the propagation path is in a changed file", () => {
    const graph = buildSymbolGraph(
      [makeNode(1, "seed.ts", "fnSeed"), makeNode(2, "mid.ts", "fnMid"), makeNode(3, "target.ts", "fnTarget")],
      [makeEdge(1, 2, "calls"), makeEdge(2, 3, "calls")],
    );
    const pred = makePrediction(
      "target.ts",
      0.6,
      { ...sig, lexical: 0.6, rawLexical: 0.6, graph: 0.5 },
      { graph_path: "2-hop" },
      [{ name: "fnTarget", score: 0.6, line: 1 }],
    );
    const paths = new Map([[3, [1, 2, 3]]]);
    const topIds = new Map([["target.ts", 3]]);
    const changed = new Set(["mid.ts"]); // intermediate file changed

    const result = verifyPredictions([pred], graph, "/root", paths, topIds, changed);

    expect(result[0].isStale).toBe(true);
  });

  it("isStale=false when no related files changed", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.8, { ...sig, lexical: 0.8, rawLexical: 0.8 });
    const changed = new Set(["unrelated.ts"]);

    const result = verifyPredictions([pred], graph, "/root", new Map(), new Map(), changed);

    expect(result[0].isStale).toBe(false);
  });
});

// ── Integration Test ────────────────────────────────────────────────────────

describe("Verification integration", () => {
  it("synthetic query through propagation + verification produces valid IntentPrediction[]", () => {
    const nodes = [
      makeNode(1, "a.ts", "handleRequest"),
      makeNode(2, "b.ts", "validateInput"),
      makeNode(3, "c.ts", "saveToDb"),
    ];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "calls")];
    const graph = buildSymbolGraph(nodes, edges);

    const propagationPaths = new Map([
      [1, [] as number[]],
      [2, [1, 2]],
      [3, [1, 2, 3]],
    ]);
    const seedFiles = new Set(["a.ts"]);
    const coupling = new Map([["b.ts", new Map([["a.ts", 0.6]])]]);
    const betweenness = new Map([
      [1, 0.1],
      [2, 0.9],
      [3, 0.3],
    ]);

    const predictions: IntentPrediction[] = [
      {
        file: "b.ts",
        rank: 1,
        score: 0.75,
        confidence: "high",
        isStale: false,
        signals: { lexical: 0.8, rawLexical: 0.8, graph: 0.7, temporal: 0.6, betweenness: 0.9 },
        theory: generateTheoryOfImpact(
          "b.ts",
          { lexical: 0.8, rawLexical: 0.8, graph: 0.7, temporal: 0.6, betweenness: 0.9 },
          2,
          propagationPaths,
          graph,
          seedFiles,
          coupling,
          betweenness,
          "fix validate input",
        ),
        verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
        symbols: [{ name: "validateInput", score: 0.75, line: 1 }],
      },
      {
        file: "c.ts",
        rank: 2,
        score: 0.45,
        confidence: "medium",
        isStale: false,
        signals: { lexical: 0.3, rawLexical: 0.3, graph: 0.343, temporal: 0, betweenness: 0.3 },
        theory: generateTheoryOfImpact(
          "c.ts",
          { lexical: 0.3, rawLexical: 0.3, graph: 0.343, temporal: 0, betweenness: 0.3 },
          3,
          propagationPaths,
          graph,
          seedFiles,
          coupling,
          betweenness,
          "fix validate input",
        ),
        verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
        symbols: [{ name: "saveToDb", score: 0.45, line: 1 }],
      },
    ];

    // ToI populated
    expect(predictions[0].theory.graph_path).toContain("1-hop");
    expect(predictions[0].theory.temporal_pair).not.toBeNull();
    expect(predictions[0].theory.betweenness_rank).not.toBeNull();
    expect(predictions[1].theory.graph_path).toContain("2-hop");

    // Smart Silence passes
    const silence = evaluateSmartSilence(predictions, "fix validate input", 50, "abc", "def", [], ["b.ts", "c.ts"]);
    expect(silence.shouldSuppress).toBe(false);

    // Verification
    const topIds = new Map([
      ["b.ts", 2],
      ["c.ts", 3],
    ]);
    const verified = verifyPredictions(predictions, graph, "/root", propagationPaths, topIds);

    expect(verified.length).toBe(2);
    for (const v of verified) {
      expect(v.verification.edge_exists).toBe(true);
      expect(v.verification.file_exists).toBe(true);
      expect(v.verification.symbol_exists).toBe(true);
      expect(v.isStale).toBe(false);
      expect(["high", "medium"]).toContain(v.confidence);
    }

    expect(verified[0].confidence).toBe("high");
    expect(verified[1].confidence).toBe("medium");
  });
});
