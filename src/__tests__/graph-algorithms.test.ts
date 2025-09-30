import { describe, expect, it } from "vitest";
import {
  findSCCs,
  findCircularDeps,
  getHubFiles,
  computeHITS,
  deriveRole,
} from "../graph.js";
import type { ImportEdge, ImportGraph } from "../types.js";

function makeGraph(files: string[], edges: ImportEdge[]): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  for (const f of files) {
    inDegree.set(f, 0);
    centrality.set(f, 1 / files.length);
  }
  for (const e of edges) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }
  return {
    edges,
    inDegree,
    centrality,
    externalImportCounts: new Map(),
    authority: centrality,
    hubScores: new Map(files.map((f) => [f, 1 / files.length])),
  };
}

function edge(from: string, to: string, names: string[] = [], isTypeOnly = false): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: names, isTypeOnly };
}

describe("findSCCs", () => {
  it("finds a simple cycle", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty for a chain with no cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
    ]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(0);
  });

});

describe("findCircularDeps", () => {
  it("reports cycles as circular deps", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b"),
      edge("b", "a"),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    // Chain should close the loop
    expect(deps[0].chain[0]).toBe(deps[0].chain[deps[0].chain.length - 1]);
  });

  it("respects maxCycles limit", () => {
    // Create 3 separate cycles
    const graph = makeGraph(
      ["a", "b", "c", "d", "e", "f"],
      [
        edge("a", "b"),
        edge("b", "a"),
        edge("c", "d"),
        edge("d", "c"),
        edge("e", "f"),
        edge("f", "e"),
      ],
    );
    const deps = findCircularDeps(graph, 2);
    expect(deps.length).toBeLessThanOrEqual(2);
  });

  it("reports only valid paths (every consecutive pair has an edge)", () => {
    // SCC {A, B, C} with edges A->B, B->A, B->C, C->B (two overlapping 2-cycles)
    // Previously this would report [A, B, C, A] which has no edge A->C
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "a"),
      edge("b", "c"),
      edge("c", "b"),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps.length).toBeGreaterThan(0);

    // Build adjacency set for edge validation
    const edgeSet = new Set<string>();
    for (const e of graph.edges) {
      if (!e.isExternal) edgeSet.add(`${e.from}->${e.to}`);
    }

    // Every consecutive pair in each chain must be a real edge
    for (const dep of deps) {
      for (let i = 0; i < dep.chain.length - 1; i++) {
        const key = `${dep.chain[i]}->${dep.chain[i + 1]}`;
        expect(edgeSet.has(key)).toBe(true);
      }
    }
  });

  it("finds mutual imports as 2-cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "a"),
      edge("b", "c"),
      edge("c", "b"),
    ]);
    const deps = findCircularDeps(graph);
    // Should find both 2-cycles: a<->b and b<->c
    const twoCycles = deps.filter((d) => d.chain.length === 3);
    expect(twoCycles.length).toBe(2);
  });
});

describe("computeHITS", () => {
  it("assigns high authority to star center (widely depended upon)", () => {
    const files = ["center", "a", "b", "c"];
    const edges = [
      edge("a", "center", ["foo", "bar"]),
      edge("b", "center", ["foo"]),
      edge("c", "center", ["baz"]),
    ];

    const { authority, hub } = computeHITS(files, edges);

    // Center has highest authority (many files depend on it)
    expect(authority.get("center")).toBeGreaterThan(authority.get("a")!);
    expect(authority.get("center")).toBeGreaterThan(authority.get("b")!);
    expect(authority.get("center")).toBeGreaterThan(authority.get("c")!);

    // Spokes have higher hub scores (they import from center)
    expect(hub.get("a")).toBeGreaterThan(hub.get("center")!);
  });

  it("handles chain graph — intermediate nodes as bridges", () => {
    const files = ["a", "b", "c", "d"];
    const edges = [
      edge("a", "b", ["x"]),
      edge("b", "c", ["y"]),
      edge("c", "d", ["z"]),
    ];

    const { authority, hub } = computeHITS(files, edges);

    // d is most depended upon (end of chain)
    // a is least depended upon (start)
    // Both b and c are in the middle
    expect(authority.get("d")!).toBeGreaterThanOrEqual(authority.get("a")!);
    expect(hub.get("a")!).toBeGreaterThanOrEqual(hub.get("d")!);
  });

  it("assigns ~0 scores to isolated nodes", () => {
    const files = ["a", "b", "isolated"];
    const edges = [edge("a", "b", ["x"])];

    const { authority, hub } = computeHITS(files, edges);

    // Isolated node should have 0 after min-max normalization
    expect(authority.get("isolated")).toBe(0);
    expect(hub.get("isolated")).toBe(0);
  });

  it("type-only edges contribute less weight", () => {
    const files = ["a", "b", "typeTarget", "valueTarget"];
    const edges = [
      edge("a", "typeTarget", ["Foo", "Bar"], true),  // type-only
      edge("b", "valueTarget", ["Foo", "Bar"], false), // value import
    ];

    const { authority } = computeHITS(files, edges);

    // Value target should have higher authority than type-only target
    expect(authority.get("valueTarget")!).toBeGreaterThan(authority.get("typeTarget")!);
  });

  it("converges within 30 iterations", () => {
    // Create a moderately complex graph
    const files = ["a", "b", "c", "d", "e"];
    const edges = [
      edge("a", "b", ["x"]),
      edge("b", "c", ["y"]),
      edge("c", "d", ["z"]),
      edge("d", "e", ["w"]),
      edge("a", "c", ["q"]),
      edge("b", "d", ["r"]),
    ];

    // Should not throw and should produce valid results
    const { authority, hub } = computeHITS(files, edges);

    // All scores should be between 0 and 1
    for (const [, score] of authority) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    for (const [, score] of hub) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("returns empty maps for empty input", () => {
    const { authority, hub } = computeHITS([], []);
    expect(authority.size).toBe(0);
    expect(hub.size).toBe(0);
  });
});

describe("deriveRole", () => {
  it("Foundation: high authority, low hub", () => {
    expect(deriveRole(0.8, 0.1)).toBe("Foundation");
  });

  it("Orchestrator: high hub, low authority", () => {
    expect(deriveRole(0.1, 0.8)).toBe("Orchestrator");
  });

  it("Bridge: both high", () => {
    expect(deriveRole(0.5, 0.5)).toBe("Bridge");
  });

  it("Utility: moderate authority, low hub", () => {
    expect(deriveRole(0.4, 0.1)).toBe("Utility");
  });

  it("Leaf: both low", () => {
    expect(deriveRole(0.1, 0.1)).toBe("Leaf");
  });
});

describe("getHubFiles", () => {
  it("returns hub files sorted by max(authority, hubScore)", () => {
    // Star graph: center is the hub
    const graph = makeGraph(["center", "a", "b", "c"], [
      edge("a", "center", ["foo"]),
      edge("b", "center", ["bar"]),
      edge("c", "center", ["baz"]),
    ]);
    // Manually set scores for testing
    graph.centrality.set("center", 1.0);
    graph.authority = new Map([["center", 1.0], ["a", 0.1], ["b", 0.1], ["c", 0.1]]);
    graph.hubScores = new Map([["center", 0.0], ["a", 0.3], ["b", 0.3], ["c", 0.3]]);
    graph.inDegree.set("center", 3);

    const hubs = getHubFiles(graph);
    expect(hubs[0].path).toBe("center");
    expect(hubs[0].importedBy).toBe(3);
    expect(hubs[0].role).toBe("Foundation");
    expect(hubs[0].authority).toBe(1.0);
    expect(hubs[0].hubScore).toBe(0.0);
  });

  it("respects limit parameter", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("a", "c"),
      edge("a", "d"),
      edge("b", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ]);
    graph.centrality.set("d", 1.0);
    graph.authority = new Map([["a", 0.2], ["b", 0.5], ["c", 0.8], ["d", 1.0]]);
    graph.hubScores = new Map([["a", 0.8], ["b", 0.5], ["c", 0.3], ["d", 0.0]]);
    graph.centrality.set("c", 0.8);
    graph.centrality.set("b", 0.5);
    graph.centrality.set("a", 0.2);

    const hubs = getHubFiles(graph, 2);
    expect(hubs).toHaveLength(2);
  });

  it("assigns correct roles based on HITS scores", () => {
    const graph = makeGraph(["types", "index", "utils"], [
      edge("index", "types", ["Foo"]),
      edge("index", "utils", ["bar"]),
      edge("utils", "types", ["Baz"]),
    ]);
    graph.authority = new Map([["types", 0.9], ["utils", 0.4], ["index", 0.0]]);
    graph.hubScores = new Map([["types", 0.0], ["utils", 0.2], ["index", 0.9]]);
    graph.centrality = new Map([["types", 0.9], ["utils", 0.4], ["index", 0.0]]);

    const hubs = getHubFiles(graph);
    const typesHub = hubs.find((h) => h.path === "types");
    const indexHub = hubs.find((h) => h.path === "index");

    expect(typesHub?.role).toBe("Foundation");
    expect(indexHub?.role).toBe("Orchestrator");
  });
});
