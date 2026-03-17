/**
 * RFC-002 Phase 2 validation gate tests.
 *
 * Covers acceptance criteria from SS2.1 through SS2.6:
 * - 2.1: Theory of Impact generator (5 criteria)
 * - 2.2: Verification protocol (7 criteria)
 * - 2.3: Confidence calibration (4 criteria)
 * - 2.4: Smart Silence (6 criteria)
 * - 2.5: Staleness Guard (4 criteria)
 * - 2.6: Integration test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge, InMemoryFileGraph } from "../storage/types";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { IntentPrediction, TheoryOfImpact } from "../core/config/intent-constants";
import { generateTheoryOfImpact } from "../steer/theory-of-impact";
import { verifyPredictions } from "../steer/intent-verification";
import { evaluateSmartSilence } from "../steer/smart-silence";
import { fuseIntentScores } from "../steer/intent-fusion";
import {
  THETA_HIGH,
  THETA_LOW,
  STALE_GRAPH_DISCOUNT,
  LAMBDA_LEXICAL,
  LAMBDA_GRAPH,
  LAMBDA_TEMPORAL,
  LAMBDA_BETWEENNESS,
} from "../core/config/intent-constants";

// Mock node:fs to control existsSync
import * as fs from "node:fs";
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: vi.fn(() => true) };
});

const mockedExistsSync = vi.mocked(fs.existsSync);

// ── Test helpers ────────────────────────────────────────────────────────────

function makeNode(id: number, filePath: string, name: string): InMemorySymbolNode {
  return { id, filePath, name, kind: "function", startLine: 1, isExported: true };
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

function emptyFileGraph(): InMemoryFileGraph {
  return { nodes: new Map(), forward: new Map(), reverse: new Map() };
}

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
    signals,
    theory: {
      lexical_evidence: null,
      graph_path: null,
      temporal_pair: null,
      betweenness_rank: null,
      ...theory,
    },
    verification: {
      edge_exists: true,
      file_exists: true,
      symbol_exists: true,
      monotonic: true,
    },
    symbols: symbols ?? [],
  };
}

beforeEach(() => {
  mockedExistsSync.mockReturnValue(true);
});

afterEach(() => {
  mockedExistsSync.mockReset();
  mockedExistsSync.mockReturnValue(true);
});

// ── 2.1 Theory of Impact Generator ─────────────────────────────────────────

describe("generateTheoryOfImpact", () => {
  it("2.1.1: lexical-only prediction has lexical_evidence non-null, rest null", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fetchUser")], []);
    const signals = { lexical: 5.0, graph: 0, temporal: 0, betweenness: 0 };

    const toi = generateTheoryOfImpact("a.ts", signals, 1, new Map(), graph, new Set(), new Map(), new Map());

    expect(toi.lexical_evidence).not.toBeNull();
    expect(toi.lexical_evidence).toContain("fetchUser");
    expect(toi.graph_path).toBeNull();
    expect(toi.temporal_pair).toBeNull();
    expect(toi.betweenness_rank).toBeNull();
  });

  it("2.1.2: graph-only prediction has graph_path with hop count and edge kinds", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "extends")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[3, [1, 2, 3]]]);
    const signals = { lexical: 0, graph: 0.56, temporal: 0, betweenness: 0 };

    const toi = generateTheoryOfImpact("c.ts", signals, 3, paths, graph, new Set(["a.ts"]), new Map(), new Map());

    expect(toi.graph_path).not.toBeNull();
    expect(toi.graph_path).toContain("2-hop");
    expect(toi.graph_path).toContain("fnA");
    expect(toi.graph_path).toContain("calls");
    expect(toi.graph_path).toContain("extends");
    expect(toi.lexical_evidence).toBeNull();
  });

  it("2.1.3: multiple non-zero signals produce non-null evidence for each", () => {
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")];
    const edges = [makeEdge(1, 2, "calls")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[2, [1, 2]]]);
    const coupling = new Map([["b.ts", new Map([["a.ts", 0.7]])]]);
    const betweenness = new Map([
      [2, 0.8],
      [1, 0.2],
    ]);
    const signals = { lexical: 3.0, graph: 0.7, temporal: 0.7, betweenness: 0.8 };

    const toi = generateTheoryOfImpact("b.ts", signals, 2, paths, graph, new Set(["a.ts"]), coupling, betweenness);

    expect(toi.lexical_evidence).not.toBeNull();
    expect(toi.graph_path).not.toBeNull();
    expect(toi.temporal_pair).not.toBeNull();
    expect(toi.betweenness_rank).not.toBeNull();
  });

  it("2.1.4: graph path gamma is the product of transmission coefficients", () => {
    // Path: 1 ->calls-> 2 ->extends-> 3; gamma = 0.7 * 0.8 = 0.56
    const nodes = [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")];
    const edges = [makeEdge(1, 2, "calls"), makeEdge(2, 3, "extends")];
    const graph = buildSymbolGraph(nodes, edges);
    const paths = new Map([[3, [1, 2, 3]]]);
    const signals = { lexical: 0, graph: 0.56, temporal: 0, betweenness: 0 };

    const toi = generateTheoryOfImpact("c.ts", signals, 3, paths, graph, new Set(["a.ts"]), new Map(), new Map());

    expect(toi.graph_path).toContain("0.56");
  });

  it("2.1.5: temporal evidence identifies best seed file", () => {
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
    const signals = { lexical: 0, graph: 0, temporal: 0.85, betweenness: 0 };

    const toi = generateTheoryOfImpact(
      "target.ts",
      signals,
      1,
      new Map(),
      graph,
      new Set(["s1.ts", "s2.ts"]),
      coupling,
      new Map(),
    );

    expect(toi.temporal_pair).toContain("s2.ts");
    expect(toi.temporal_pair).toContain("0.85");
  });
});

// ── 2.2 Verification Protocol ──────────────────────────────────────────────

describe("verifyPredictions", () => {
  it("2.2.1: missing edge zeros graph signal and recomputes score", () => {
    // Graph has edge 1->2, but path claims 1->2->3 and edge 2->3 is missing
    const graph = buildSymbolGraph(
      [makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB"), makeNode(3, "c.ts", "fnC")],
      [makeEdge(1, 2, "calls")],
    );

    const pred = makePrediction(
      "c.ts",
      0.6,
      { lexical: 0.5, graph: 0.5, temporal: 0, betweenness: 0 },
      { graph_path: "2-hop from fnA via calls -> calls (gamma: 0.49)" },
      [{ name: "fnC", score: 0.5, line: 3 }],
    );

    const paths = new Map([[3, [1, 2, 3]]]);
    const topIds = new Map([["c.ts", 3]]);

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root", paths, topIds);

    expect(result.length).toBe(1);
    expect(result[0].verification.edge_exists).toBe(false);
    expect(result[0].signals.graph).toBe(0);
    expect(result[0].score).toBeCloseTo(LAMBDA_LEXICAL * 0.5, 10);
  });

  it("2.2.2: deleted file removes prediction from output", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA")], []);
    const pred = makePrediction("deleted.ts", 0.8, { lexical: 1.0, graph: 0, temporal: 0, betweenness: 0 });

    mockedExistsSync.mockReturnValue(false);

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");

    expect(result.length).toBe(0);
  });

  it("2.2.3: missing symbol flags symbol_exists but retains prediction", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA")], []);
    const pred = makePrediction("a.ts", 0.5, { lexical: 0.5, graph: 0, temporal: 0, betweenness: 0 }, {}, [
      { name: "missingSymbol", score: 0.5, line: 99 },
    ]);

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");

    expect(result.length).toBe(1);
    expect(result[0].verification.symbol_exists).toBe(false);
  });

  it("2.2.4: non-monotonic pair flagged", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], []);

    const sameSignals = { lexical: 0.5, graph: 0.3, temporal: 0.2, betweenness: 0.1 };
    const pred1 = makePrediction("a.ts", 0.5, { ...sameSignals });
    const pred2 = makePrediction("b.ts", 0.49, { ...sameSignals });

    const result = verifyPredictions([pred1, pred2], graph, emptyFileGraph(), "/root");

    expect(result.length).toBe(2);
    expect(result[1].verification.monotonic).toBe(false);
  });

  it("2.2.5: all checks pass on valid data", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], [makeEdge(1, 2, "calls")]);

    const pred = makePrediction(
      "a.ts",
      0.8,
      { lexical: 0.8, graph: 0.7, temporal: 0, betweenness: 0 },
      { graph_path: "1-hop from fnA via calls (gamma: 0.70)" },
      [{ name: "fnA", score: 0.8, line: 1 }],
    );

    const paths = new Map([[1, [1, 2]]]);
    const topIds = new Map([["a.ts", 1]]);

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root", paths, topIds);

    expect(result.length).toBe(1);
    expect(result[0].verification.edge_exists).toBe(true);
    expect(result[0].verification.file_exists).toBe(true);
    expect(result[0].verification.symbol_exists).toBe(true);
    expect(result[0].verification.monotonic).toBe(true);
  });

  it("2.2.6: re-scoring preserves rank order when possible", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA"), makeNode(2, "b.ts", "fnB")], [makeEdge(1, 2, "calls")]);

    const pred1 = makePrediction("a.ts", 0.9, { lexical: 0.9, graph: 0.8, temporal: 0, betweenness: 0 });
    const pred2 = makePrediction("b.ts", 0.6, { lexical: 0.6, graph: 0.3, temporal: 0, betweenness: 0 });

    const result = verifyPredictions([pred2, pred1], graph, emptyFileGraph(), "/root");

    expect(result[0].file).toBe("a.ts");
    expect(result[0].rank).toBe(1);
    expect(result[1].rank).toBe(2);
  });

  it("2.2.7: predictions without graph path skip edge check", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fnA")], []);
    const pred = makePrediction("a.ts", 0.5, { lexical: 0.5, graph: 0, temporal: 0, betweenness: 0 });

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");

    expect(result.length).toBe(1);
    expect(result[0].verification.edge_exists).toBe(true);
  });
});

// ── 2.3 Confidence Calibration ──────────────────────────────────────────────

describe("confidence calibration", () => {
  it("2.3.1: score 0.85 -> high", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.85, { lexical: 1.0, graph: 0.8, temporal: 0, betweenness: 0 });

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");
    expect(result[0].confidence).toBe("high");
  });

  it("2.3.2: score 0.45 -> medium", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", 0.45, { lexical: 0.45, graph: 0, temporal: 0, betweenness: 0 });

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");
    expect(result[0].confidence).toBe("medium");
  });

  it("2.3.3: score exactly at THETA_HIGH boundary -> medium", () => {
    const graph = buildSymbolGraph([makeNode(1, "a.ts", "fn")], []);
    const pred = makePrediction("a.ts", THETA_HIGH, { lexical: 0.7, graph: 0, temporal: 0, betweenness: 0 });

    const result = verifyPredictions([pred], graph, emptyFileGraph(), "/root");
    // score > THETA_HIGH is "high", score === THETA_HIGH is "medium"
    expect(result[0].confidence).toBe("medium");
  });
});

// ── 2.4 Smart Silence ──────────────────────────────────────────────────────

describe("evaluateSmartSilence", () => {
  it("2.4.1: empty predictions -> suppress, reason 'all below threshold'", () => {
    const result = evaluateSmartSilence([], "fix the bug", 50, "abc", "def", [], []);

    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });

  it("2.4.1b: all predictions below THETA_LOW -> suppress", () => {
    const preds = [
      makePrediction("a.ts", 0.2, { lexical: 0.2, graph: 0, temporal: 0, betweenness: 0 }),
      makePrediction("b.ts", 0.1, { lexical: 0.1, graph: 0, temporal: 0, betweenness: 0 }),
    ];

    const result = evaluateSmartSilence(preds, "fix the bug", 50, "abc", "def", [], ["a.ts", "b.ts"]);

    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });

  it("2.4.2: query mentioning predicted file -> suppress, reason 'explicit paths'", () => {
    const preds = [makePrediction("src/foo/bar.ts", 0.8, { lexical: 0.8, graph: 0, temporal: 0, betweenness: 0 })];

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

  it("2.4.3: 40% of predicted files changed -> fallbackToLexical, reason 'stale graph'", () => {
    const preds = [
      makePrediction("a.ts", 0.8, { lexical: 0.8, graph: 0.5, temporal: 0, betweenness: 0 }),
      makePrediction("b.ts", 0.7, { lexical: 0.7, graph: 0.3, temporal: 0, betweenness: 0 }),
    ];

    // 1 of 2 predicted files changed = 50% > 30% threshold
    const result = evaluateSmartSilence(preds, "fix the bug", 50, "abc", "def", ["a.ts", "c.ts"], ["a.ts", "b.ts"]);

    expect(result.shouldSuppress).toBe(false);
    expect(result.reason).toBe("stale graph");
    expect(result.fallbackToLexical).toBe(true);
  });

  it("2.4.4: 3-file project -> suppress, reason 'small project'", () => {
    const preds = [makePrediction("a.ts", 0.8, { lexical: 0.8, graph: 0, temporal: 0, betweenness: 0 })];

    const result = evaluateSmartSilence(preds, "fix the bug", 3, "abc", "def", [], ["a.ts"]);

    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("small project");
  });

  it("2.4.5: normal case -> no suppression", () => {
    const preds = [makePrediction("a.ts", 0.8, { lexical: 0.8, graph: 0.5, temporal: 0, betweenness: 0 })];

    const result = evaluateSmartSilence(preds, "fix the validation bug", 50, "abc", "def", [], ["a.ts"]);

    expect(result.shouldSuppress).toBe(false);
    expect(result.reason).toBeNull();
    expect(result.fallbackToLexical).toBe(false);
  });

  it("2.4.6: condition priority - threshold check before explicit paths", () => {
    const preds = [makePrediction("src/foo.ts", THETA_LOW, { lexical: 0.3, graph: 0, temporal: 0, betweenness: 0 })];

    const result = evaluateSmartSilence(preds, "fix src/foo.ts", 50, "abc", "def", [], ["src/foo.ts"]);

    expect(result.shouldSuppress).toBe(true);
    expect(result.reason).toBe("all below threshold");
  });
});

// ── 2.5 Staleness Guard ─────────────────────────────────────────────────────

describe("staleness guard", () => {
  it("2.5.1: fresh graph - no discount, graph signal at full weight", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0.8, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set());
    const fused = result.get(1);

    const expected = LAMBDA_LEXICAL * 1.0 + LAMBDA_GRAPH * 0.8;
    expect(fused?.score).toBeCloseTo(expected, 10);
  });

  it("2.5.2: stale graph - graph signal halved", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 1.0, graphScore: 0.8, betweennessScore: 0 }];
    const result = fuseIntentScores(inputs, new Map(), new Set(), STALE_GRAPH_DISCOUNT);
    const fused = result.get(1);

    // G_effective = 0.8 * 0.5 = 0.4
    const expected = LAMBDA_LEXICAL * 1.0 + LAMBDA_GRAPH * 0.4;
    expect(fused?.score).toBeCloseTo(expected, 10);
  });

  it("2.5.3: stale discount formula correct", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 1.0, betweennessScore: 0.5 }];
    const coupling = new Map([["a.ts", new Map([["seed.ts", 0.6]])]]);
    const seedFiles = new Set(["seed.ts"]);
    const result = fuseIntentScores(inputs, coupling, seedFiles, STALE_GRAPH_DISCOUNT);
    const fused = result.get(1);

    // L=0, G=1.0*0.5=0.5, T=0.6, B=0.5
    const expected = LAMBDA_LEXICAL * 0 + LAMBDA_GRAPH * 0.5 + LAMBDA_TEMPORAL * 0.6 + LAMBDA_BETWEENNESS * 0.5;
    expect(fused?.score).toBeCloseTo(expected, 10);
  });

  it("2.5.4: undefined staleDiscount does not affect graph signal", () => {
    const inputs = [{ symbolId: 1, filePath: "a.ts", lexicalScore: 0, graphScore: 0.6, betweennessScore: 0 }];
    const withDiscount = fuseIntentScores(inputs, new Map(), new Set(), undefined);
    const withoutDiscount = fuseIntentScores(inputs, new Map(), new Set());

    expect(withDiscount.get(1)?.score).toBe(withoutDiscount.get(1)?.score);
  });
});

// ── 2.6 Integration Test ────────────────────────────────────────────────────

describe("Phase 2 integration", () => {
  it("synthetic query through Phase 1 + Phase 2 produces valid IntentPrediction[]", () => {
    // Build a small symbol graph: A -> B -> C
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

    // Build predictions (simulating Phase 4 orchestrator)
    const predictions: IntentPrediction[] = [
      {
        file: "b.ts",
        rank: 1,
        score: 0.75,
        confidence: "high",
        signals: { lexical: 0.8, graph: 0.7, temporal: 0.6, betweenness: 0.9 },
        theory: generateTheoryOfImpact(
          "b.ts",
          { lexical: 0.8, graph: 0.7, temporal: 0.6, betweenness: 0.9 },
          2,
          propagationPaths,
          graph,
          seedFiles,
          coupling,
          betweenness,
        ),
        verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
        symbols: [{ name: "validateInput", score: 0.75, line: 1 }],
      },
      {
        file: "c.ts",
        rank: 2,
        score: 0.45,
        confidence: "medium",
        signals: { lexical: 0.3, graph: 0.343, temporal: 0, betweenness: 0.3 },
        theory: generateTheoryOfImpact(
          "c.ts",
          { lexical: 0.3, graph: 0.343, temporal: 0, betweenness: 0.3 },
          3,
          propagationPaths,
          graph,
          seedFiles,
          coupling,
          betweenness,
        ),
        verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
        symbols: [{ name: "saveToDb", score: 0.45, line: 1 }],
      },
    ];

    // Verify ToI fields are populated
    expect(predictions[0].theory.graph_path).not.toBeNull();
    expect(predictions[0].theory.graph_path).toContain("1-hop");
    expect(predictions[0].theory.temporal_pair).not.toBeNull();
    expect(predictions[0].theory.betweenness_rank).not.toBeNull();

    expect(predictions[1].theory.graph_path).not.toBeNull();
    expect(predictions[1].theory.graph_path).toContain("2-hop");

    // Smart Silence doesn't suppress
    const silence = evaluateSmartSilence(predictions, "fix the validation bug", 50, "abc", "def", [], ["b.ts", "c.ts"]);
    expect(silence.shouldSuppress).toBe(false);

    // Verification
    const topIds = new Map([
      ["b.ts", 2],
      ["c.ts", 3],
    ]);
    const verified = verifyPredictions(predictions, graph, emptyFileGraph(), "/root", propagationPaths, topIds);

    expect(verified.length).toBe(2);
    for (const v of verified) {
      expect(v.verification.edge_exists).toBe(true);
      expect(v.verification.file_exists).toBe(true);
      expect(v.verification.symbol_exists).toBe(true);
      expect(v.confidence).toBeDefined();
      expect(["high", "medium"]).toContain(v.confidence);
    }

    // Confidence calibration
    expect(verified[0].confidence).toBe("high"); // 0.75 > 0.7
    expect(verified[1].confidence).toBe("medium"); // 0.45 <= 0.7
  });
});
