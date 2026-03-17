import { describe, it, expect } from "vitest";
import { findScoredEntryPoints, findTerminalNodes } from "../core/graph/entry-points";
import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../storage/types";
import { ENTRY_WEIGHTS } from "../core/config/flow-constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeNode(id: number, overrides: Partial<InMemorySymbolNode> = {}): InMemorySymbolNode {
  return {
    id,
    filePath: overrides.filePath ?? "src/test.ts",
    name: overrides.name ?? `fn${id}`,
    kind: overrides.kind ?? "function",
    startLine: overrides.startLine ?? id * 10,
    isExported: overrides.isExported ?? true,
  };
}

function makeEdge(from: number, to: number, kind = "calls"): InMemorySymEdge {
  return { fromSymbolId: from, toSymbolId: to, kind };
}

function buildGraph(nodes: InMemorySymbolNode[], edges: InMemorySymEdge[]): InMemorySymbolGraph {
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

// ── Tests: Entry Points ──────────────────────────────────────────────────────

describe("findScoredEntryPoints", () => {
  it("2.1.1 exported function with no callers scores >= NO_CALLERS weight", () => {
    const graph = buildGraph([makeNode(1, { name: "doSomething" })], []);

    const entries = findScoredEntryPoints(graph, new Map());

    expect(entries.length).toBe(1);
    expect(entries[0].score).toBeGreaterThanOrEqual(ENTRY_WEIGHTS.NO_CALLERS);
    expect(entries[0].signals.noCallers).toBe(true);
  });

  it("2.1.2 ghost:route target gets route bonus even with callers", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "getUser" }), makeNode(2, { name: "caller" })],
      [makeEdge(2, 1, "calls"), makeEdge(2, 1, "ghost:route")],
    );

    const entries = findScoredEntryPoints(graph, new Map());

    expect(entries.length).toBeGreaterThanOrEqual(1);
    const entry = entries.find((e) => e.symbolId === 1);
    expect(entry).toBeDefined();
    expect(entry?.signals.isRouteTarget).toBe(true);
    expect(entry?.kind).toBe("route_handler");
  });

  it("2.1.3 sorted by score descending", () => {
    const graph = buildGraph(
      [
        makeNode(1, { name: "handleRequest" }), // framework match + no callers
        makeNode(2, { name: "helper" }), // only no callers
      ],
      [],
    );

    const entries = findScoredEntryPoints(graph, new Map());

    expect(entries.length).toBe(2);
    expect(entries[0].score).toBeGreaterThanOrEqual(entries[1].score);
    expect(entries[0].name).toBe("handleRequest");
  });

  it("2.1.4 below minimum score excluded", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "lowScore" })],
      [makeEdge(2, 1, "calls")], // has callers -> no noCallers signal
    );

    const entries = findScoredEntryPoints(graph, new Map(), { minScore: 0.5 });

    expect(entries.length).toBe(0);
  });

  it("2.1.5 non-exported functions excluded", () => {
    const graph = buildGraph([makeNode(1, { name: "privateHelper", isExported: false })], []);

    const entries = findScoredEntryPoints(graph, new Map());

    expect(entries.length).toBe(0);
  });

  it("2.1.6 high hub score adds HUB_EXPORTED weight", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "orchestrate", filePath: "src/server.ts" })],
      [makeEdge(2, 1, "calls")], // has callers
    );

    const hubScores = new Map([["src/server.ts", 0.8]]);
    const entries = findScoredEntryPoints(graph, hubScores, { minScore: 0.1 });

    expect(entries.length).toBe(1);
    expect(entries[0].signals.highHubExported).toBe(true);
    expect(entries[0].score).toBeGreaterThanOrEqual(ENTRY_WEIGHTS.HUB_EXPORTED * 0.8);
  });

  it("2.1.7 framework convention match classifies correctly", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "handleAuth" }), makeNode(2, { name: "onConnect" }), makeNode(3, { name: "main" })],
      [],
    );

    const entries = findScoredEntryPoints(graph, new Map());

    const auth = entries.find((e) => e.name === "handleAuth");
    const connect = entries.find((e) => e.name === "onConnect");
    const main = entries.find((e) => e.name === "main");
    expect(auth?.kind).toBe("api_export");
    expect(connect?.kind).toBe("event_handler");
    expect(main?.kind).toBe("cli_command");
  });

  it("2.1.8 non-function kinds excluded", () => {
    const graph = buildGraph([makeNode(1, { name: "MyClass", kind: "class" })], []);

    const entries = findScoredEntryPoints(graph, new Map());
    expect(entries.length).toBe(0);
  });
});

// ── Tests: Terminal Nodes ────────────────────────────────────────────────────

describe("findTerminalNodes", () => {
  it("2.2.1 function with no outgoing calls is terminal", () => {
    const graph = buildGraph([makeNode(1, { name: "leafFn" })], []);

    const terminals = findTerminalNodes(graph);

    expect(terminals.length).toBe(1);
    expect(terminals[0].reason).toBe("no_outgoing");
  });

  it("2.2.2 function calling cross-package targets is terminal", () => {
    const graph = buildGraph(
      [
        makeNode(1, { name: "callExternal", filePath: "packages/a/src/foo.ts" }),
        makeNode(2, { name: "externalFn", filePath: "packages/b/src/bar.ts" }),
      ],
      [makeEdge(1, 2, "calls")],
    );

    const terminals = findTerminalNodes(graph);

    const crossPkg = terminals.find((t) => t.symbolId === 1);
    expect(crossPkg).toBeDefined();
    expect(crossPkg?.reason).toBe("cross_package");
  });

  it("2.2.3 function with same-package calls is NOT terminal", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "caller", filePath: "src/a.ts" }), makeNode(2, { name: "callee", filePath: "src/b.ts" })],
      [makeEdge(1, 2, "calls")],
    );

    const terminals = findTerminalNodes(graph);

    const caller = terminals.find((t) => t.symbolId === 1);
    expect(caller).toBeUndefined();
  });

  it("2.2.4 non-flow edge kinds do not prevent terminal status", () => {
    const graph = buildGraph(
      [makeNode(1, { name: "typeUser" }), makeNode(2, { name: "SomeType" })],
      [makeEdge(1, 2, "uses_type")], // uses_type is NOT in FLOW_EDGE_KINDS
    );

    const terminals = findTerminalNodes(graph);

    const typeUser = terminals.find((t) => t.symbolId === 1);
    expect(typeUser).toBeDefined();
    expect(typeUser?.reason).toBe("no_outgoing");
  });
});
