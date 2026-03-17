import { describe, it, expect } from "vitest";
import {
  classifyAbsorbing,
  computeTransitionRow,
  propagateAbsorbing,
  reconstructGreedyPath,
  traceMarkovFlow,
} from "../core/graph/markov-flow.js";
import type {
  InMemorySymbolGraph,
  InMemorySymbolNode,
  InMemorySymEdge,
  LeanFileGraph,
  LeanFileNode,
} from "../storage/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: number, overrides: Partial<InMemorySymbolNode> = {}): InMemorySymbolNode {
  return {
    id,
    filePath: overrides.filePath ?? `src/file${id}.ts`,
    name: overrides.name ?? `sym${id}`,
    kind: overrides.kind ?? "function",
    startLine: overrides.startLine ?? id * 10,
    isExported: overrides.isExported ?? true,
    authority: overrides.authority ?? 0.5,
  };
}

function makeEdge(from: number, to: number, kind = "calls"): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind };
}

function buildSymGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]): InMemorySymbolGraph {
  const symbols = new Map<number, InMemorySymbolNode>();
  const forward = new Map<number, InMemorySymEdge[]>();
  const reverse = new Map<number, InMemorySymEdge[]>();
  const byFile = new Map<string, number[]>();

  for (const n of nodes) {
    symbols.set(n.id, n);
    let fileIds = byFile.get(n.filePath);
    if (!fileIds) {
      fileIds = [];
      byFile.set(n.filePath, fileIds);
    }
    fileIds.push(n.id);
  }

  for (const e of edges) {
    let fwd = forward.get(e.fromSymbolId);
    if (!fwd) {
      fwd = [];
      forward.set(e.fromSymbolId, fwd);
    }
    fwd.push(e);

    let rev = reverse.get(e.toSymbolId);
    if (!rev) {
      rev = [];
      reverse.set(e.toSymbolId, rev);
    }
    rev.push(e);
  }

  return { symbols, forward, reverse, byFile };
}

function makeLeanFile(path: string, overrides: Partial<LeanFileNode> = {}): [string, LeanFileNode] {
  return [
    path,
    {
      path,
      hash: "abc",
      authority: overrides.authority ?? 0.5,
      hubScore: overrides.hubScore ?? 0.1,
      betweenness: overrides.betweenness ?? 0.1,
      isBarrel: false,
      isDead: false,
      isChokepoint: false,
      communityId: overrides.communityId ?? 0,
    },
  ];
}

/**
 * Chain graph: A(1) -> B(2) -> C(3) -> D(4).
 * D is absorbing (no outgoing "calls" edges).
 * All symbols in community 0.
 */
function buildChainGraph() {
  const A = makeNode(1, { filePath: "src/a.ts", name: "A", authority: 0.5 });
  const B = makeNode(2, { filePath: "src/b.ts", name: "B", authority: 0.8 });
  const C = makeNode(3, { filePath: "src/c.ts", name: "C", authority: 0.3 });
  const D = makeNode(4, { filePath: "src/d.ts", name: "D", authority: 0.6 });

  const symGraph = buildSymGraph([A, B, C, D], [makeEdge(1, 2), makeEdge(2, 3), makeEdge(3, 4)]);

  const fileGraph: LeanFileGraph = {
    nodes: new Map([
      makeLeanFile("src/a.ts", { communityId: 0 }),
      makeLeanFile("src/b.ts", { communityId: 0 }),
      makeLeanFile("src/c.ts", { communityId: 0 }),
      makeLeanFile("src/d.ts", { communityId: 0 }),
    ]),
    forward: new Map(),
    reverse: new Map(),
  };

  const changeCoupling = new Map<string, number>();

  return { symGraph, fileGraph, changeCoupling };
}

// ── classifyAbsorbing ────────────────────────────────────────────────────────

describe("classifyAbsorbing", () => {
  it("marks nodes with no forward edges as absorbing", () => {
    const { symGraph } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    expect(abs.has(4)).toBe(true);
    expect(abs.has(1)).toBe(false);
    expect(abs.has(2)).toBe(false);
    expect(abs.has(3)).toBe(false);
  });

  it("marks nodes with only non-flow edges as absorbing", () => {
    const nodes = [makeNode(1, { filePath: "src/a.ts", name: "A" }), makeNode(2, { filePath: "src/b.ts", name: "B" })];
    // "uses_type" is not in FLOW_EDGE_KINDS
    const symGraph = buildSymGraph(nodes, [makeEdge(1, 2, "uses_type")]);
    const abs = classifyAbsorbing(symGraph);

    expect(abs.has(1)).toBe(true);
    expect(abs.has(2)).toBe(true);
  });

  it("treats nodes with flow edges as transitive", () => {
    const nodes = [makeNode(1, { filePath: "src/a.ts", name: "A" }), makeNode(2, { filePath: "src/b.ts", name: "B" })];
    const symGraph = buildSymGraph(nodes, [makeEdge(1, 2, "calls")]);
    const abs = classifyAbsorbing(symGraph);

    expect(abs.has(1)).toBe(false);
    expect(abs.has(2)).toBe(true);
  });
});

// ── computeTransitionRow ─────────────────────────────────────────────────────

describe("computeTransitionRow", () => {
  it("returns null for absorbing nodes", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const row = computeTransitionRow(4, symGraph, fileGraph, changeCoupling, 0, abs);
    expect(row).toBeNull();
  });

  it("produces a stochastic row (weights sum to 1.0)", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const row = computeTransitionRow(1, symGraph, fileGraph, changeCoupling, 0, abs);
    expect(row).not.toBeNull();

    const sum = row?.weights.reduce((a, b) => a + b, 0);
    expect(sum).toBeCloseTo(1.0, 10);
  });

  it("reflects authority weighting in relative weights", () => {
    // A -> B (authority=0.9), A -> C (authority=0.1)
    const A = makeNode(1, { filePath: "src/a.ts", name: "A", authority: 0.5 });
    const B = makeNode(2, { filePath: "src/b.ts", name: "B", authority: 0.9 });
    const C = makeNode(3, { filePath: "src/c.ts", name: "C", authority: 0.1 });

    const symGraph = buildSymGraph([A, B, C], [makeEdge(1, 2), makeEdge(1, 3)]);
    const fileGraph: LeanFileGraph = {
      nodes: new Map([
        makeLeanFile("src/a.ts", { communityId: 0 }),
        makeLeanFile("src/b.ts", { communityId: 0 }),
        makeLeanFile("src/c.ts", { communityId: 0 }),
      ]),
      forward: new Map(),
      reverse: new Map(),
    };
    const abs = classifyAbsorbing(symGraph);

    const row = computeTransitionRow(1, symGraph, fileGraph, new Map(), 0, abs);
    expect(row).not.toBeNull();
    expect(row?.targets).toContain(2);
    expect(row?.targets).toContain(3);

    const idxB = row?.targets.indexOf(2) ?? -1;
    const idxC = row?.targets.indexOf(3) ?? -1;
    // Higher authority -> higher weight
    expect(row?.weights[idxB]).toBeGreaterThan(row?.weights[idxC] ?? 0);
  });

  it("applies temporal decay via changeCouplingIndex", () => {
    // A -> B, with two coupling scenarios
    const A = makeNode(1, { filePath: "src/a.ts", name: "A", authority: 0.5 });
    const B = makeNode(2, { filePath: "src/b.ts", name: "B", authority: 0.5 });
    const C = makeNode(3, { filePath: "src/c.ts", name: "C", authority: 0.5 });

    const symGraph = buildSymGraph([A, B, C], [makeEdge(1, 2), makeEdge(1, 3)]);
    const fileGraph: LeanFileGraph = {
      nodes: new Map([
        makeLeanFile("src/a.ts", { communityId: 0 }),
        makeLeanFile("src/b.ts", { communityId: 0 }),
        makeLeanFile("src/c.ts", { communityId: 0 }),
      ]),
      forward: new Map(),
      reverse: new Map(),
    };
    const abs = classifyAbsorbing(symGraph);

    // Recent coupling for A-B (0 days), ancient coupling for A-C (999 days)
    const coupling = new Map<string, number>();
    coupling.set("src/a.ts||src/b.ts", 0);
    coupling.set("src/a.ts||src/c.ts", 999);

    const row = computeTransitionRow(1, symGraph, fileGraph, coupling, 0, abs);
    expect(row).not.toBeNull();

    const idxB = row?.targets.indexOf(2) ?? -1;
    const idxC = row?.targets.indexOf(3) ?? -1;
    // Recent coupling -> higher temporal factor -> higher weight
    expect(row?.weights[idxB]).toBeGreaterThan(row?.weights[idxC] ?? 0);
  });
});

// ── propagateAbsorbing ───────────────────────────────────────────────────────

describe("propagateAbsorbing", () => {
  it("conserves mass (visits + absorbed + residual = 1.0)", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const result = propagateAbsorbing(1, symGraph, fileGraph, changeCoupling, 0, abs);

    // Total absorbed mass should account for everything that reached terminals
    let totalAbsorbed = 0;
    for (const m of result.absorbed.values()) totalAbsorbed += m;

    // In a pure chain A->B->C->D(absorbing), all mass eventually reaches D
    // so absorbed + residual should be close to 1.0
    expect(totalAbsorbed + result.residualMass).toBeCloseTo(1.0, 4);
  });

  it("gives entry node the highest visit probability", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const result = propagateAbsorbing(1, symGraph, fileGraph, changeCoupling, 0, abs);

    const entryVisit = result.visits.get(1) ?? 0;
    for (const [id, prob] of result.visits) {
      if (id !== 1) {
        expect(entryVisit).toBeGreaterThanOrEqual(prob);
      }
    }
  });

  it("converges within maxSteps", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const result = propagateAbsorbing(1, symGraph, fileGraph, changeCoupling, 0, abs, 100);
    expect(result.steps).toBeLessThanOrEqual(100);
  });

  it("accumulates mass on absorbing nodes", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const result = propagateAbsorbing(1, symGraph, fileGraph, changeCoupling, 0, abs);

    // D (id=4) is the only absorbing node; it should capture absorbed mass
    expect(result.absorbed.has(4)).toBe(true);
    expect(result.absorbed.get(4) ?? 0).toBeGreaterThan(0);
  });
});

// ── reconstructGreedyPath ────────────────────────────────────────────────────

describe("reconstructGreedyPath", () => {
  it("follows highest-probability edges through the chain", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const path = reconstructGreedyPath(1, symGraph, fileGraph, changeCoupling, 0, abs, 10);

    // Chain has only one path: A -> B -> C -> D
    expect(path).toEqual([1, 2, 3, 4]);
  });

  it("stops at absorbing states", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();
    const abs = classifyAbsorbing(symGraph);

    const path = reconstructGreedyPath(1, symGraph, fileGraph, changeCoupling, 0, abs, 10);

    // Should stop at D (absorbing), not extend beyond
    expect(path[path.length - 1]).toBe(4);
  });

  it("avoids cycles", () => {
    // A -> B -> C -> A (cycle), B -> D (escape)
    const A = makeNode(1, { filePath: "src/a.ts", name: "A", authority: 0.5 });
    const B = makeNode(2, { filePath: "src/b.ts", name: "B", authority: 0.5 });
    const C = makeNode(3, { filePath: "src/c.ts", name: "C", authority: 0.5 });
    const D = makeNode(4, { filePath: "src/d.ts", name: "D", authority: 0.5 });

    const symGraph = buildSymGraph([A, B, C, D], [makeEdge(1, 2), makeEdge(2, 3), makeEdge(3, 1), makeEdge(2, 4)]);
    const fileGraph: LeanFileGraph = {
      nodes: new Map([
        makeLeanFile("src/a.ts", { communityId: 0 }),
        makeLeanFile("src/b.ts", { communityId: 0 }),
        makeLeanFile("src/c.ts", { communityId: 0 }),
        makeLeanFile("src/d.ts", { communityId: 0 }),
      ]),
      forward: new Map(),
      reverse: new Map(),
    };
    const abs = classifyAbsorbing(symGraph);

    const path = reconstructGreedyPath(1, symGraph, fileGraph, new Map(), 0, abs, 10);

    // No duplicate node ids
    const unique = new Set(path);
    expect(unique.size).toBe(path.length);
  });

  it("returns at least the entry node", () => {
    // Single isolated node
    const symGraph = buildSymGraph([makeNode(1, { filePath: "src/a.ts", name: "A" })], []);
    const fileGraph: LeanFileGraph = {
      nodes: new Map([makeLeanFile("src/a.ts", { communityId: 0 })]),
      forward: new Map(),
      reverse: new Map(),
    };
    const abs = classifyAbsorbing(symGraph);

    const path = reconstructGreedyPath(1, symGraph, fileGraph, new Map(), 0, abs, 10);
    expect(path).toEqual([1]);
  });
});

// ── traceMarkovFlow ──────────────────────────────────────────────────────────

describe("traceMarkovFlow", () => {
  it("returns a valid FlowSignature for a chain graph", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();

    const sig = traceMarkovFlow(1, symGraph, fileGraph, changeCoupling);

    expect(sig.entrySymbolId).toBe(1);
    expect(sig.convergenceSteps).toBeGreaterThan(0);
    expect(sig.states.length).toBeGreaterThan(0);
  });

  it("produces a non-empty summary for non-trivial graphs", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();

    const sig = traceMarkovFlow(1, symGraph, fileGraph, changeCoupling);

    expect(sig.summary.length).toBeGreaterThan(0);
  });

  it("sorts states by visit probability (descending)", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();

    const sig = traceMarkovFlow(1, symGraph, fileGraph, changeCoupling);

    for (let i = 1; i < sig.states.length; i++) {
      expect(sig.states[i - 1].visitProbability).toBeGreaterThanOrEqual(sig.states[i].visitProbability);
    }
  });

  it("includes the entry symbol in states", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();

    const sig = traceMarkovFlow(1, symGraph, fileGraph, changeCoupling);

    const entryState = sig.states.find((s) => s.symbolId === 1);
    expect(entryState).toBeDefined();
    expect(entryState?.name).toBe("A");
  });

  it("returns an empty signature for a missing entry node", () => {
    const { symGraph, fileGraph, changeCoupling } = buildChainGraph();

    const sig = traceMarkovFlow(999, symGraph, fileGraph, changeCoupling);

    expect(sig.entrySymbolId).toBe(999);
    expect(sig.states).toEqual([]);
    expect(sig.summary).toBe("");
  });
});
