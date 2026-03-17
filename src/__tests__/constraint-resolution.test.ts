import { describe, it, expect } from "vitest";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../storage/types.js";
import type { SymbolIndex, SymbolEntry } from "../core/graph/symbol-resolution.js";
import type { ResolvedSymbolEdge } from "../core/graph/symbol-types.js";
import { RESOLUTION_CONFIDENCE } from "../core/graph/symbol-types.js";
import {
  smoothedJaccard,
  buildSymbolNeighborhoods,
  buildFileNeighborhoods,
  buildNeighborhoodsFromResolvedEdges,
  resolveByProximity,
} from "../core/graph/constraint-resolution.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(
  id: number,
  filePath: string,
  name: string,
  opts: Partial<InMemorySymbolNode> = {},
): InMemorySymbolNode {
  return {
    id,
    filePath,
    name,
    kind: "function",
    startLine: 1,
    isExported: true,
    ...opts,
  };
}

function makeEdge(from: number, to: number): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind: "calls" };
}

function makeSymbolGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]): InMemorySymbolGraph {
  const symbols = new Map<number, InMemorySymbolNode>();
  const forward = new Map<number, InMemorySymEdge[]>();
  const reverse = new Map<number, InMemorySymEdge[]>();
  const byFile = new Map<string, number[]>();

  for (const n of nodes) {
    symbols.set(n.id, n);
    const arr = byFile.get(n.filePath) ?? [];
    arr.push(n.id);
    byFile.set(n.filePath, arr);
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

function makeSymbolIndex(entries: SymbolEntry[]): SymbolIndex {
  const byFileAndName = new Map<string, SymbolEntry[]>();
  const byFile = new Map<string, SymbolEntry[]>();
  const byName = new Map<string, SymbolEntry[]>();

  for (const e of entries) {
    const key = `${e.filePath}::${e.name}`;
    const fan = byFileAndName.get(key) ?? [];
    fan.push(e);
    byFileAndName.set(key, fan);

    const bf = byFile.get(e.filePath) ?? [];
    bf.push(e);
    byFile.set(e.filePath, bf);

    const bn = byName.get(e.name) ?? [];
    bn.push(e);
    byName.set(e.name, bn);
  }

  return { byFileAndName, byFile, byName };
}

// ── smoothedJaccard ──────────────────────────────────────────────────────────

describe("smoothedJaccard", () => {
  it("returns 1 for identical non-empty sets", () => {
    const s = new Set([1, 2, 3]);
    // (3 + 1) / (3 + 2) = 4/5 = 0.8
    expect(smoothedJaccard(s, s)).toBeCloseTo(0.8, 10);
  });

  it("returns Laplace floor for disjoint sets", () => {
    const a = new Set([1, 2]);
    const b = new Set([3, 4]);
    // (0 + 1) / (4 + 2) = 1/6
    expect(smoothedJaccard(a, b)).toBeCloseTo(1 / 6, 10);
  });

  it("handles partial overlap", () => {
    const a = new Set([1, 2, 3]);
    const b = new Set([2, 3, 4]);
    // intersection=2, union=4 -> (2+1)/(4+2) = 3/6 = 0.5
    expect(smoothedJaccard(a, b)).toBeCloseTo(0.5, 10);
  });

  it("returns 1/(0+2) for two empty sets", () => {
    const empty = new Set<number>();
    // (0+1)/(0+2) = 0.5
    expect(smoothedJaccard(empty, empty)).toBeCloseTo(0.5, 10);
  });

  it("handles one empty set against non-empty", () => {
    const empty = new Set<number>();
    const s = new Set([1, 2, 3]);
    // (0+1)/(3+2) = 1/5 = 0.2
    expect(smoothedJaccard(empty, s)).toBeCloseTo(0.2, 10);
  });
});

// ── buildSymbolNeighborhoods ─────────────────────────────────────────────────

describe("buildSymbolNeighborhoods", () => {
  it("builds 1-hop neighborhoods from forward and reverse edges", () => {
    //  1 -> 2 -> 3
    const graph = makeSymbolGraph(
      [makeNode(1, "a.ts", "A"), makeNode(2, "a.ts", "B"), makeNode(3, "b.ts", "C")],
      [makeEdge(1, 2), makeEdge(2, 3)],
    );

    const hoods = buildSymbolNeighborhoods(graph);

    // Node 1: forward to 2
    expect(hoods.get(1)).toEqual(new Set([2]));
    // Node 2: forward to 3, reverse from 1
    expect(hoods.get(2)).toEqual(new Set([1, 3]));
    // Node 3: reverse from 2
    expect(hoods.get(3)).toEqual(new Set([2]));
  });

  it("returns empty neighborhoods for isolated nodes", () => {
    const graph = makeSymbolGraph([makeNode(10, "x.ts", "X")], []);
    const hoods = buildSymbolNeighborhoods(graph);
    expect(hoods.get(10)).toEqual(new Set());
  });
});

// ── buildFileNeighborhoods ───────────────────────────────────────────────────

describe("buildFileNeighborhoods", () => {
  it("builds bidirectional neighborhoods from file edges", () => {
    const edges = [
      { fromPath: "a.ts", toPath: "b.ts" },
      { fromPath: "a.ts", toPath: "c.ts" },
    ];

    const hoods = buildFileNeighborhoods(edges);

    expect(hoods.get("a.ts")).toEqual(new Set(["b.ts", "c.ts"]));
    expect(hoods.get("b.ts")).toEqual(new Set(["a.ts"]));
    expect(hoods.get("c.ts")).toEqual(new Set(["a.ts"]));
  });

  it("returns empty map for no edges", () => {
    expect(buildFileNeighborhoods([])).toEqual(new Map());
  });
});

// ── buildNeighborhoodsFromResolvedEdges ──────────────────────────────────────

describe("buildNeighborhoodsFromResolvedEdges", () => {
  it("builds bidirectional neighborhoods from resolved edges", () => {
    const entries: SymbolEntry[] = [
      { id: 1, filePath: "a.ts", name: "foo", kind: "function", startLine: 1 },
      { id: 2, filePath: "b.ts", name: "bar", kind: "function", startLine: 1 },
      { id: 3, filePath: "c.ts", name: "baz", kind: "function", startLine: 1 },
    ];
    const index = makeSymbolIndex(entries);

    const edges: ResolvedSymbolEdge[] = [
      { fromFile: "a.ts", fromSymbol: "foo", toFile: "b.ts", toSymbol: "bar", kind: "calls", line: 5, confidence: 0.9 },
      {
        fromFile: "b.ts",
        fromSymbol: "bar",
        toFile: "c.ts",
        toSymbol: "baz",
        kind: "calls",
        line: 10,
        confidence: 0.9,
      },
    ];

    const hoods = buildNeighborhoodsFromResolvedEdges(edges, index);

    expect(hoods.get(1)).toEqual(new Set([2]));
    expect(hoods.get(2)).toEqual(new Set([1, 3]));
    expect(hoods.get(3)).toEqual(new Set([2]));
  });

  it("skips edges with unresolvable symbols", () => {
    const index = makeSymbolIndex([{ id: 1, filePath: "a.ts", name: "foo", kind: "function", startLine: 1 }]);

    const edges: ResolvedSymbolEdge[] = [
      {
        fromFile: "a.ts",
        fromSymbol: "foo",
        toFile: "z.ts",
        toSymbol: "missing",
        kind: "calls",
        line: 1,
        confidence: 0.5,
      },
    ];

    const hoods = buildNeighborhoodsFromResolvedEdges(edges, index);
    // Edge skipped entirely, no neighborhood for id 1
    expect(hoods.has(1)).toBe(false);
  });
});

// ── resolveByProximity ───────────────────────────────────────────────────────

describe("resolveByProximity", () => {
  it("returns null when no candidates exist for the callee name", () => {
    const graph = makeSymbolGraph([], []);
    const index = makeSymbolIndex([]);

    const result = resolveByProximity(
      "caller.ts",
      1,
      "nonexistent",
      10,
      "main",
      new Map(),
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).toBeNull();
  });

  it("resolves single candidate with TIER_5_PROXIMITY confidence", () => {
    // Caller (id=1) and candidate (id=2) share a neighbor (id=3)
    const nodes = [
      makeNode(1, "caller.ts", "main", { authority: 0.5 }),
      makeNode(2, "target.ts", "helper", { authority: 0.8, isExported: true }),
      makeNode(3, "shared.ts", "shared", { authority: 0.3 }),
    ];
    const edges = [makeEdge(1, 3), makeEdge(2, 3)];
    const graph = makeSymbolGraph(nodes, edges);
    const symHoods = buildSymbolNeighborhoods(graph);

    const index = makeSymbolIndex([{ id: 2, filePath: "target.ts", name: "helper", kind: "function", startLine: 1 }]);

    const result = resolveByProximity(
      "caller.ts",
      1,
      "helper",
      5,
      "main",
      symHoods,
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).not.toBeNull();
    expect(result?.toFile).toBe("target.ts");
    expect(result?.toSymbol).toBe("helper");
    expect(result?.confidence).toBe(RESOLUTION_CONFIDENCE.TIER_5_PROXIMITY);
    expect(result?.kind).toBe("calls");
    expect(result?.fromSymbol).toBe("main");
    expect(result?.line).toBe(5);
  });

  it("picks highest-scoring candidate among multiple", () => {
    // Caller shares neighbors with candidate A (high overlap) and B (no overlap)
    const nodes = [
      makeNode(1, "caller.ts", "main"),
      makeNode(10, "a.ts", "target", { authority: 0.5, isExported: true }),
      makeNode(20, "b.ts", "target", { authority: 0.5, isExported: true }),
      makeNode(30, "shared.ts", "s1"),
      makeNode(31, "shared.ts", "s2"),
      makeNode(32, "shared.ts", "s3"),
    ];
    // Caller -> s1, s2, s3 (3 neighbors, above cold-start threshold)
    // Candidate A -> s1, s2 (overlap with caller)
    // Candidate B has no edges (no overlap)
    const edges = [makeEdge(1, 30), makeEdge(1, 31), makeEdge(1, 32), makeEdge(10, 30), makeEdge(10, 31)];
    const graph = makeSymbolGraph(nodes, edges);
    const symHoods = buildSymbolNeighborhoods(graph);

    const index = makeSymbolIndex([
      { id: 10, filePath: "a.ts", name: "target", kind: "function", startLine: 1 },
      { id: 20, filePath: "b.ts", name: "target", kind: "function", startLine: 1 },
    ]);

    const result = resolveByProximity(
      "caller.ts",
      1,
      "target",
      1,
      "main",
      symHoods,
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).not.toBeNull();
    expect(result?.toFile).toBe("a.ts");
  });

  it("filters unexported cross-file candidates (locality=0)", () => {
    // Candidate is unexported and in a different file -> invisible
    const nodes = [
      makeNode(1, "caller.ts", "main"),
      makeNode(2, "other.ts", "secret", { isExported: false, authority: 0.5 }),
      makeNode(3, "shared.ts", "s1"),
    ];
    const edges = [makeEdge(1, 3), makeEdge(2, 3)];
    const graph = makeSymbolGraph(nodes, edges);
    const symHoods = buildSymbolNeighborhoods(graph);

    const index = makeSymbolIndex([{ id: 2, filePath: "other.ts", name: "secret", kind: "function", startLine: 1 }]);

    const result = resolveByProximity(
      "caller.ts",
      1,
      "secret",
      1,
      "main",
      symHoods,
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).toBeNull();
  });

  it("includes same-file candidates even when unexported", () => {
    // Same file -> locality=10, even if unexported
    const nodes = [
      makeNode(1, "same.ts", "caller", { authority: 0.5 }),
      makeNode(2, "same.ts", "helper", { isExported: false, authority: 0.5 }),
      makeNode(3, "other.ts", "s1"),
      makeNode(4, "other.ts", "s2"),
      makeNode(5, "other.ts", "s3"),
    ];
    // Give caller enough neighbors to avoid cold start
    const edges = [makeEdge(1, 3), makeEdge(1, 4), makeEdge(1, 5), makeEdge(2, 3)];
    const graph = makeSymbolGraph(nodes, edges);
    const symHoods = buildSymbolNeighborhoods(graph);

    const index = makeSymbolIndex([{ id: 2, filePath: "same.ts", name: "helper", kind: "function", startLine: 10 }]);

    const result = resolveByProximity(
      "same.ts",
      1,
      "helper",
      5,
      "caller",
      symHoods,
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).not.toBeNull();
    expect(result?.toFile).toBe("same.ts");
    expect(result?.toSymbol).toBe("helper");
  });

  it("falls back to file-level Jaccard when symbol neighborhood < cold-start threshold", () => {
    // Caller has fewer than 3 symbol neighbors -> cold start -> file-level Jaccard
    const nodes = [
      makeNode(1, "caller.ts", "main", { authority: 0.5 }),
      makeNode(2, "target.ts", "fn", { authority: 0.5, isExported: true }),
    ];
    // Caller has 0 symbol neighbors (below threshold=3)
    const graph = makeSymbolGraph(nodes, []);
    const symHoods = buildSymbolNeighborhoods(graph);

    // File neighborhoods: caller.ts imports shared.ts, target.ts imports shared.ts
    const fileHoods = buildFileNeighborhoods([
      { fromPath: "caller.ts", toPath: "shared.ts" },
      { fromPath: "target.ts", toPath: "shared.ts" },
    ]);

    const index = makeSymbolIndex([{ id: 2, filePath: "target.ts", name: "fn", kind: "function", startLine: 1 }]);

    const result = resolveByProximity("caller.ts", 1, "fn", 1, "main", symHoods, fileHoods, index, graph, new Map());

    expect(result).not.toBeNull();
    expect(result?.toFile).toBe("target.ts");
  });

  it("weights candidates by authority^beta", () => {
    // Two candidates with identical Jaccard and locality but different authority
    const nodes = [
      makeNode(1, "caller.ts", "main"),
      makeNode(10, "a.ts", "target", { authority: 0.04, isExported: true }),
      makeNode(20, "b.ts", "target", { authority: 1.0, isExported: true }),
      makeNode(30, "s1.ts", "s1"),
      makeNode(31, "s2.ts", "s2"),
      makeNode(32, "s3.ts", "s3"),
    ];
    // All three share the same 3 neighbors -> identical Jaccard
    const edges = [
      makeEdge(1, 30),
      makeEdge(1, 31),
      makeEdge(1, 32),
      makeEdge(10, 30),
      makeEdge(10, 31),
      makeEdge(10, 32),
      makeEdge(20, 30),
      makeEdge(20, 31),
      makeEdge(20, 32),
    ];
    const graph = makeSymbolGraph(nodes, edges);
    const symHoods = buildSymbolNeighborhoods(graph);

    const index = makeSymbolIndex([
      { id: 10, filePath: "a.ts", name: "target", kind: "function", startLine: 1 },
      { id: 20, filePath: "b.ts", name: "target", kind: "function", startLine: 1 },
    ]);

    const result = resolveByProximity(
      "caller.ts",
      1,
      "target",
      1,
      "main",
      symHoods,
      new Map(),
      index,
      graph,
      new Map(),
    );

    expect(result).not.toBeNull();
    // authority=1.0 beats authority=0.04 because 1.0^0.5 > 0.04^0.5
    expect(result?.toFile).toBe("b.ts");
  });
});
