import { describe, it, expect } from "vitest";
import { traceExecutionFlows, compressFlowPath } from "../core/graph/flow-trace";
import type { FlowNode } from "../core/graph/flow-trace";
import type {
  InMemorySymbolGraph,
  InMemorySymbolNode,
  InMemorySymEdge,
  LeanFileGraph,
  LeanFileNode,
} from "../storage/types";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: number, overrides: Partial<InMemorySymbolNode> = {}): InMemorySymbolNode {
  return {
    id,
    filePath: overrides.filePath ?? `src/file${id}.ts`,
    name: overrides.name ?? `fn${id}`,
    kind: overrides.kind ?? "function",
    startLine: overrides.startLine ?? id * 10,
    isExported: overrides.isExported ?? true,
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
      communityId: overrides.communityId ?? null,
    },
  ];
}

function buildFileGraph(entries: Array<[string, LeanFileNode]>): LeanFileGraph {
  return {
    nodes: new Map(entries),
    forward: new Map(),
    reverse: new Map(),
  };
}

// ── Tests: traceExecutionFlows ───────────────────────────────────────────────

describe("traceExecutionFlows", () => {
  it("3.1.1 linear flow: A -> B -> C -> D finds the flow", () => {
    // A is entry (exported, no incoming calls), D is terminal (no outgoing)
    const symGraph = buildSymGraph(
      [
        makeNode(1, { name: "entryFn", filePath: "src/a.ts" }),
        makeNode(2, { name: "middleware", filePath: "src/b.ts" }),
        makeNode(3, { name: "service", filePath: "src/c.ts" }),
        makeNode(4, { name: "dbQuery", filePath: "src/d.ts" }),
      ],
      [makeEdge(1, 2), makeEdge(2, 3), makeEdge(3, 4)],
    );
    const fileGraph = buildFileGraph([
      makeLeanFile("src/a.ts"),
      makeLeanFile("src/b.ts"),
      makeLeanFile("src/c.ts"),
      makeLeanFile("src/d.ts"),
    ]);

    const flows = traceExecutionFlows(["src/b.ts"], "middleware", symGraph, fileGraph);

    expect(flows.length).toBeGreaterThanOrEqual(1);
    const flow = flows[0];
    expect(flow.nodes.length).toBeGreaterThanOrEqual(2);
    expect(flow.confidence).toBeGreaterThan(0);
  });

  it("3.1.2 returns empty when target has no symbols", () => {
    const symGraph = buildSymGraph([], []);
    const fileGraph = buildFileGraph([]);

    const flows = traceExecutionFlows(["src/nonexistent.ts"], undefined, symGraph, fileGraph);

    expect(flows).toEqual([]);
  });

  it("3.1.3 target unreachable from any entry returns empty", () => {
    // Two disconnected components
    const symGraph = buildSymGraph(
      [makeNode(1, { name: "entryA", filePath: "src/a.ts" }), makeNode(2, { name: "isolated", filePath: "src/b.ts" })],
      [], // no edges
    );
    const fileGraph = buildFileGraph([makeLeanFile("src/a.ts"), makeLeanFile("src/b.ts")]);

    const flows = traceExecutionFlows(["src/b.ts"], "isolated", symGraph, fileGraph);

    // isolated has no incoming edges, so it IS an entry point itself
    // but there are no terminals reachable from it and no entries that reach it
    // The flow should be empty or contain only trivial flows
    expect(flows.length).toBe(0);
  });

  it("3.1.4 flows ranked by confidence", () => {
    // Two paths: via calls (confidence 1.0) and via decorates (confidence 0.7)
    const symGraph = buildSymGraph(
      [
        makeNode(1, { name: "entry", filePath: "src/a.ts" }),
        makeNode(2, { name: "target", filePath: "src/b.ts" }),
        makeNode(3, { name: "alt", filePath: "src/c.ts" }),
        makeNode(4, { name: "sink", filePath: "src/d.ts" }),
      ],
      [makeEdge(1, 2, "calls"), makeEdge(2, 4, "calls"), makeEdge(1, 3, "decorates"), makeEdge(3, 4, "decorates")],
    );
    const fileGraph = buildFileGraph([
      makeLeanFile("src/a.ts"),
      makeLeanFile("src/b.ts"),
      makeLeanFile("src/c.ts"),
      makeLeanFile("src/d.ts"),
    ]);

    const flows = traceExecutionFlows(["src/b.ts"], "target", symGraph, fileGraph);

    if (flows.length > 1) {
      expect(flows[0].confidence).toBeGreaterThanOrEqual(flows[1].confidence);
    }
  });
});

// ── Tests: compressFlowPath ──────────────────────────────────────────────────

describe("compressFlowPath", () => {
  it("3.2.1 waypoints shown, low-betweenness collapsed", () => {
    const nodes: FlowNode[] = [
      {
        symbolId: 1,
        file: "a.ts",
        name: "entry",
        line: 1,
        communityId: 0,
        communityLabel: null,
        isDominator: true,
        isBoundary: false,
      },
      {
        symbolId: 2,
        file: "b.ts",
        name: "mid1",
        line: 2,
        communityId: 0,
        communityLabel: null,
        isDominator: false,
        isBoundary: false,
      },
      {
        symbolId: 3,
        file: "c.ts",
        name: "mid2",
        line: 3,
        communityId: 0,
        communityLabel: null,
        isDominator: false,
        isBoundary: false,
      },
      {
        symbolId: 4,
        file: "d.ts",
        name: "exit",
        line: 4,
        communityId: 0,
        communityLabel: null,
        isDominator: false,
        isBoundary: false,
      },
    ];

    const betweenness = new Map([
      ["a.ts", 0.9],
      ["b.ts", 0.1],
      ["c.ts", 0.1],
      ["d.ts", 0.9],
    ]);

    const summary = compressFlowPath(nodes, betweenness, 0.5);

    expect(summary).toContain("entry");
    expect(summary).toContain("exit");
    expect(summary).toContain("[2 calls]");
  });

  it("3.2.2 all waypoints: no collapsed segments", () => {
    const nodes: FlowNode[] = [
      {
        symbolId: 1,
        file: "a.ts",
        name: "A",
        line: 1,
        communityId: 0,
        communityLabel: null,
        isDominator: true,
        isBoundary: false,
      },
      {
        symbolId: 2,
        file: "b.ts",
        name: "B",
        line: 2,
        communityId: 0,
        communityLabel: null,
        isDominator: true,
        isBoundary: false,
      },
      {
        symbolId: 3,
        file: "c.ts",
        name: "C",
        line: 3,
        communityId: 0,
        communityLabel: null,
        isDominator: true,
        isBoundary: false,
      },
    ];

    const betweenness = new Map([
      ["a.ts", 0.9],
      ["b.ts", 0.9],
      ["c.ts", 0.9],
    ]);

    const summary = compressFlowPath(nodes, betweenness, 0.5);

    expect(summary).toBe("A -> B -> C");
  });

  it("3.2.3 community boundary forces flush", () => {
    const nodes: FlowNode[] = [
      {
        symbolId: 1,
        file: "a.ts",
        name: "start",
        line: 1,
        communityId: 0,
        communityLabel: "auth",
        isDominator: false,
        isBoundary: false,
      },
      {
        symbolId: 2,
        file: "b.ts",
        name: "mid",
        line: 2,
        communityId: 0,
        communityLabel: "auth",
        isDominator: false,
        isBoundary: false,
      },
      {
        symbolId: 3,
        file: "c.ts",
        name: "dbCall",
        line: 3,
        communityId: 1,
        communityLabel: "database",
        isDominator: false,
        isBoundary: true,
      },
    ];

    const betweenness = new Map([
      ["a.ts", 0.1],
      ["b.ts", 0.1],
      ["c.ts", 0.1],
    ]);

    const summary = compressFlowPath(nodes, betweenness, 0.5);

    expect(summary).toContain("start");
    expect(summary).toContain("[database]");
    expect(summary).toContain("dbCall");
  });

  it("3.2.4 empty path returns empty string", () => {
    expect(compressFlowPath([], new Map())).toBe("");
  });

  it("3.2.5 two-node path: no compression", () => {
    const nodes: FlowNode[] = [
      {
        symbolId: 1,
        file: "a.ts",
        name: "A",
        line: 1,
        communityId: 0,
        communityLabel: null,
        isDominator: false,
        isBoundary: false,
      },
      {
        symbolId: 2,
        file: "b.ts",
        name: "B",
        line: 2,
        communityId: 0,
        communityLabel: null,
        isDominator: false,
        isBoundary: false,
      },
    ];

    const summary = compressFlowPath(nodes, new Map());

    expect(summary).toBe("A -> B");
  });
});
