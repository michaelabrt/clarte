import { describe, expect, it } from "vitest";
import {
  findSCCs,
  findCircularDeps,
  getHubFiles,
  computeHITS,
  deriveRole,
  findStructuralTemporalMismatches,
  findTightCouplings,
  computeBetweenness,
  checkArchitecturalFitness,
} from "../graph.js";
import type { ArchitecturalLayer, ImportEdge, ImportGraph, LayerEdge } from "../types.js";

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

function edge(from: string, to: string, names: string[] = [], isTypeOnly = false, isDynamic = false): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: names, isTypeOnly, isDynamic };
}

function dynamicEdge(from: string, to: string, names: string[] = []): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: names, isDynamic: true };
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

describe("findCircularDeps severity", () => {
  it("assigns severity 0 for type-only cycles", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["Foo"], true),  // type-only
      edge("b", "a", ["Bar"], true),  // type-only
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(0);
    expect(deps[0].chain).toContain("a");
  });

  it("assigns severity 1 for all-runtime cycles", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo"]),
      edge("b", "a", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(1);
  });

  it("assigns mixed severity for mixed cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b", ["foo"]),       // runtime
      edge("b", "c", ["Bar"], true), // type-only
      edge("c", "a", ["baz"]),       // runtime
    ]);
    const deps = findCircularDeps(graph);
    // Should find a 3-cycle with 2/3 runtime edges
    const threeCycle = deps.find((d) => d.chain.length === 4);
    expect(threeCycle).toBeDefined();
    expect(threeCycle!.severity).toBeGreaterThan(0);
    expect(threeCycle!.severity).toBeLessThan(1);
  });

  it("provides break hints", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo"]),
      edge("b", "a", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps[0].breakHint).toBeDefined();
    expect(deps[0].breakHint!.length).toBeGreaterThan(0);
  });

  it("sorts type-only cycles after runtime cycles", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b", ["Foo"], true),  // type-only cycle
      edge("b", "a", ["Bar"], true),
      edge("c", "d", ["foo"]),         // runtime cycle
      edge("d", "c", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps.length).toBeGreaterThanOrEqual(2);
    // Runtime cycle should come first
    const firstSeverity = deps[0].severity ?? 1;
    const lastSeverity = deps[deps.length - 1].severity ?? 1;
    expect(firstSeverity).toBeGreaterThanOrEqual(lastSeverity);
  });
});

describe("findStructuralTemporalMismatches", () => {
  it("detects file pairs with high co-change but large graph distance", () => {
    // Linear chain: a -> b -> c -> d -> e
    const graph = makeGraph(["a", "b", "c", "d", "e"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
    ]);
    const coupling = [
      { fileA: "a", fileB: "e", confidence: 0.8, coChangeCount: 5 },
    ];
    const mismatches = findStructuralTemporalMismatches(graph, coupling, 0.4, 3);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].graphDistance).toBe(4);
    expect(mismatches[0].coChangeConfidence).toBe(0.8);
  });

  it("ignores pairs within threshold distance", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
    ]);
    const coupling = [
      { fileA: "a", fileB: "c", confidence: 0.8, coChangeCount: 5 },
    ];
    // Distance is 2 (a->b->c), threshold is 3
    const mismatches = findStructuralTemporalMismatches(graph, coupling, 0.4, 3);
    expect(mismatches).toHaveLength(0);
  });

  it("detects unreachable pairs", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("c", "d"),
    ]);
    const coupling = [
      { fileA: "a", fileB: "d", confidence: 0.6, coChangeCount: 3 },
    ];
    const mismatches = findStructuralTemporalMismatches(graph, coupling, 0.4, 3);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].graphDistance).toBe(-1);
  });

  it("returns empty for no coupling data", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b")]);
    expect(findStructuralTemporalMismatches(graph, [])).toHaveLength(0);
  });
});

describe("findTightCouplings", () => {
  it("detects files importing many names", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo", "bar", "baz", "qux", "quux"]),
    ]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(1);
    expect(couplings[0].from).toBe("a");
    expect(couplings[0].to).toBe("b");
    expect(couplings[0].importedNames).toBe(5);
  });

  it("ignores pairs below threshold", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo", "bar"]),
    ]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(0);
  });

  it("aggregates names across multiple edges", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo", "bar", "baz"]),
      edge("a", "b", ["qux", "quux"]),
    ]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(1);
    expect(couplings[0].importedNames).toBe(5);
  });

  it("sorts by name count descending", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b", ["w", "x", "y", "z", "v"]),
      edge("a", "c", ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]),
    ]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(2);
    expect(couplings[0].to).toBe("c"); // 7 names
    expect(couplings[1].to).toBe("b"); // 5 names
  });

  it("returns empty for no edges", () => {
    const graph = makeGraph(["a", "b"], []);
    expect(findTightCouplings(graph)).toHaveLength(0);
  });
});

describe("computeHITS with dynamic imports", () => {
  it("gives lower authority to dynamically-imported files vs statically-imported", () => {
    const files = ["a", "b", "staticTarget", "dynamicTarget"];
    const edges = [
      edge("a", "staticTarget", ["foo", "bar"]),
      dynamicEdge("b", "dynamicTarget", ["foo", "bar"]),
    ];

    const { authority } = computeHITS(files, edges);

    // Static target should have higher authority than dynamic target
    expect(authority.get("staticTarget")!).toBeGreaterThan(authority.get("dynamicTarget")!);
  });

  it("dynamic edges weigh between type-only and value imports", () => {
    const files = ["a", "b", "c", "typeTarget", "dynamicTarget", "valueTarget"];
    const edges = [
      edge("a", "typeTarget", ["Foo"], true),     // type-only: 0.3x weight
      dynamicEdge("b", "dynamicTarget", ["Foo"]),  // dynamic: 0.5x weight
      edge("c", "valueTarget", ["Foo"]),            // value: 1.0x weight
    ];

    const { authority } = computeHITS(files, edges);

    expect(authority.get("valueTarget")!).toBeGreaterThan(authority.get("dynamicTarget")!);
    expect(authority.get("dynamicTarget")!).toBeGreaterThan(authority.get("typeTarget")!);
  });
});

describe("computeHITS with barrel files", () => {
  it("gives lower authority to barrel files", () => {
    const files = ["a", "b", "barrel", "source"];
    const edges = [
      edge("a", "barrel", ["foo", "bar"]),
      edge("b", "barrel", ["baz"]),
      edge("a", "source", ["foo", "bar"]),
      edge("b", "source", ["baz"]),
    ];
    const barrelFiles = new Set(["barrel"]);

    const { authority } = computeHITS(files, edges, 30, 1e-6, barrelFiles);

    // Source (non-barrel) should have higher authority than barrel
    expect(authority.get("source")!).toBeGreaterThan(authority.get("barrel")!);
  });

  it("non-barrel files are not affected by barrel discount", () => {
    const files = ["a", "b", "target"];
    const edges = [
      edge("a", "target", ["foo"]),
      edge("b", "target", ["bar"]),
    ];
    const barrelFiles = new Set<string>(); // empty

    const withoutBarrels = computeHITS(files, edges);
    const withBarrels = computeHITS(files, edges, 30, 1e-6, barrelFiles);

    // Results should be identical when no barrels are present
    expect(withBarrels.authority.get("target")).toBe(withoutBarrels.authority.get("target"));
  });
});

describe("deriveRole with barrel files", () => {
  it("returns Barrel when isBarrel is true, regardless of scores", () => {
    // High authority + low hub normally = Foundation, but barrel overrides
    expect(deriveRole(0.9, 0.0, true)).toBe("Barrel");
    expect(deriveRole(0.5, 0.5, true)).toBe("Barrel");
    expect(deriveRole(0.0, 0.9, true)).toBe("Barrel");
  });

  it("returns normal roles when isBarrel is false", () => {
    expect(deriveRole(0.8, 0.1, false)).toBe("Foundation");
    expect(deriveRole(0.1, 0.8, false)).toBe("Orchestrator");
  });

  it("returns normal roles when isBarrel is not provided", () => {
    expect(deriveRole(0.8, 0.1)).toBe("Foundation");
  });
});

describe("findCircularDeps with dynamic imports", () => {
  it("assigns lower severity to dynamic-only cycles", () => {
    const graph = makeGraph(["a", "b"], [
      dynamicEdge("a", "b", ["foo"]),
      dynamicEdge("b", "a", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    // Dynamic-only cycle: each edge contributes 0.5, so severity = 0.5
    expect(deps[0].severity).toBe(0.5);
  });

  it("assigns severity 1 for static runtime cycles", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b", ["foo"]),
      edge("b", "a", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(1);
  });

  it("assigns mixed severity for static + dynamic cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b", ["foo"]),          // static: 1.0
      dynamicEdge("b", "c", ["bar"]),   // dynamic: 0.5
      edge("c", "a", ["baz"]),          // static: 1.0
    ]);
    const deps = findCircularDeps(graph);
    const threeCycle = deps.find((d) => d.chain.length === 4);
    expect(threeCycle).toBeDefined();
    // (1.0 + 0.5 + 1.0) / 3 = 0.833...
    expect(threeCycle!.severity).toBeCloseTo(2.5 / 3, 5);
  });

  it("sorts dynamic-only cycles after static runtime cycles", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      dynamicEdge("a", "b"),   // dynamic cycle
      dynamicEdge("b", "a"),
      edge("c", "d", ["foo"]), // runtime cycle
      edge("d", "c", ["bar"]),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps.length).toBeGreaterThanOrEqual(2);
    // Runtime cycle (severity 1.0) should come before dynamic cycle (severity 0.5)
    expect(deps[0].severity!).toBeGreaterThan(deps[deps.length - 1].severity!);
  });
});

// ── §3.2 Approximate Betweenness Centrality ──────────────────────────

describe("computeBetweenness", () => {
  it("assigns highest score to star center", () => {
    // Star graph: center connected to a, b, c, d (no leaf-to-leaf edges)
    const graph = makeGraph(["center", "a", "b", "c", "d"], [
      edge("a", "center"),
      edge("b", "center"),
      edge("c", "center"),
      edge("d", "center"),
    ]);

    const scores = computeBetweenness(graph);

    // Center is on all shortest paths between leaves
    expect(scores.get("center")).toBe(1);
    // Leaves have no paths passing through them (they are endpoints)
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
    expect(scores.get("c")).toBe(0);
    expect(scores.get("d")).toBe(0);
  });

  it("assigns highest scores to middle nodes in a chain", () => {
    // Chain: a - b - c - d - e
    const graph = makeGraph(["a", "b", "c", "d", "e"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
    ]);

    const scores = computeBetweenness(graph);

    // Middle nodes (b, c, d) should have higher betweenness than endpoints
    expect(scores.get("c")!).toBeGreaterThan(scores.get("a")!);
    expect(scores.get("c")!).toBeGreaterThan(scores.get("e")!);
    // Center of chain (c) should have highest score
    expect(scores.get("c")!).toBeGreaterThanOrEqual(scores.get("b")!);
    expect(scores.get("c")!).toBeGreaterThanOrEqual(scores.get("d")!);
    // Endpoints should have zero
    expect(scores.get("a")).toBe(0);
    expect(scores.get("e")).toBe(0);
  });

  it("assigns zero betweenness between disconnected components", () => {
    // Two disconnected pairs: a-b and c-d
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("c", "d"),
    ]);

    const scores = computeBetweenness(graph);

    // No shortest paths pass through any node between components
    // In each 2-node component, neither node lies on a path between other nodes
    for (const [, score] of scores) {
      expect(score).toBe(0);
    }
  });

  it("returns empty map for empty graph", () => {
    const graph = makeGraph([], []);
    const scores = computeBetweenness(graph);
    expect(scores.size).toBe(0);
  });

  it("produces deterministic results", () => {
    // Same graph should produce same scores every time
    const graph = makeGraph(["a", "b", "c", "d", "e", "f"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
      edge("a", "f"),
      edge("f", "e"),
    ]);

    const scores1 = computeBetweenness(graph);
    const scores2 = computeBetweenness(graph);

    for (const [file, score] of scores1) {
      expect(scores2.get(file)).toBe(score);
    }
  });

  it("normalizes scores to 0-1 range", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
    ]);

    const scores = computeBetweenness(graph);

    for (const [, score] of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // At least one score should be 1 (the max)
    const maxScore = Math.max(...scores.values());
    expect(maxScore).toBe(1);
  });

  it("handles single-node graph", () => {
    // Single node with a self-referencing edge (unusual but should not crash)
    const graph = makeGraph(["a", "b"], [edge("a", "b")]);
    const scores = computeBetweenness(graph);
    // Two-node graph: neither lies on a path between other distinct nodes
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
  });
});

// ── §3.11 Architectural Fitness Functions ────────────────────────────

function makeLayers(defs: Array<{ name: string; files: string[] }>): ArchitecturalLayer[] {
  return defs.map((d) => ({
    name: d.name,
    files: d.files,
    importedByLayers: 0,
    dependsOn: [],
  }));
}

describe("checkArchitecturalFitness", () => {
  it("detects upward dependency violations", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);

    // types <- services <- components (expected flow)
    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
      { from: "components", to: "services" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/services.ts", "src/types.ts"),       // correct
        edge("src/components.ts", "src/services.ts"),   // correct
        edge("src/types.ts", "src/components.ts"),      // violation: types -> components (upward)
      ],
    );

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    const upward = violations.filter((v) => v.rule === "no-upward-dep");
    expect(upward.length).toBeGreaterThanOrEqual(1);
    expect(upward[0].from).toBe("src/types.ts");
    expect(upward[0].to).toBe("src/components.ts");
    expect(upward[0].severity).toBe("warning");
  });

  it("detects test isolation violations", () => {
    const graph = makeGraph(
      ["src/__tests__/auth.test.ts", "src/__tests__/user.test.ts", "src/auth.ts"],
      [
        edge("src/__tests__/auth.test.ts", "src/__tests__/user.test.ts"),  // violation
        edge("src/__tests__/auth.test.ts", "src/auth.ts"),                  // correct
      ],
    );

    const violations = checkArchitecturalFitness(graph, [], []);
    const testViolations = violations.filter((v) => v.rule === "test-isolation");
    expect(testViolations).toHaveLength(1);
    expect(testViolations[0].from).toBe("src/__tests__/auth.test.ts");
    expect(testViolations[0].to).toBe("src/__tests__/user.test.ts");
  });

  it("allows test files to import from __fixtures__", () => {
    const graph = makeGraph(
      ["src/__tests__/auth.test.ts", "src/__tests__/__fixtures__/mock-user.ts"],
      [
        edge("src/__tests__/auth.test.ts", "src/__tests__/__fixtures__/mock-user.ts"),
      ],
    );

    const violations = checkArchitecturalFitness(graph, [], []);
    const testViolations = violations.filter((v) => v.rule === "test-isolation");
    expect(testViolations).toHaveLength(0);
  });

  it("allows test files to import from test-utils", () => {
    const graph = makeGraph(
      ["src/__tests__/auth.test.ts", "src/test-utils/setup.ts"],
      [
        edge("src/__tests__/auth.test.ts", "src/test-utils/setup.ts"),
      ],
    );

    const violations = checkArchitecturalFitness(graph, [], []);
    const testViolations = violations.filter((v) => v.rule === "test-isolation");
    expect(testViolations).toHaveLength(0);
  });

  it("detects layer skip violations", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "pages", files: ["src/pages.ts"] },
    ]);

    // types <- utils <- services <- pages
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "pages", to: "services" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/pages.ts"],
      [
        edge("src/services.ts", "src/utils.ts"),  // correct, skip=1
        edge("src/pages.ts", "src/types.ts"),      // skip: pages -> types, skipping 2 layers
      ],
    );

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    const skips = violations.filter((v) => v.rule === "layer-skip");
    expect(skips.length).toBeGreaterThanOrEqual(1);
    expect(skips[0].from).toBe("src/pages.ts");
    expect(skips[0].to).toBe("src/types.ts");
    expect(skips[0].message).toContain("skipping");
  });

  it("does not flag adjacent layer imports as skips", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/services.ts"],
      [
        edge("src/services.ts", "src/types.ts"),  // adjacent, no skip
      ],
    );

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    const skips = violations.filter((v) => v.rule === "layer-skip");
    expect(skips).toHaveLength(0);
  });

  it("caps total violations at 20", () => {
    // Create many upward violations
    const typeFiles = Array.from({ length: 25 }, (_, i) => `src/types/t${i}.ts`);
    const layers = makeLayers([
      { name: "types", files: typeFiles },
      { name: "services", files: ["src/services.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
    ];

    // Each types file imports services (upward violation)
    const edges = typeFiles.map((f) => edge(f, "src/services.ts"));
    const graph = makeGraph([...typeFiles, "src/services.ts"], edges);

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    expect(violations.length).toBeLessThanOrEqual(20);
  });

  it("returns empty for fewer than 2 layers on layer rules", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
    ]);

    const graph = makeGraph(["src/types.ts"], []);
    const violations = checkArchitecturalFitness(graph, layers, []);
    // No upward or skip violations with only one layer
    const layerViolations = violations.filter(
      (v) => v.rule === "no-upward-dep" || v.rule === "layer-skip",
    );
    expect(layerViolations).toHaveLength(0);
  });

  it("ignores external edges", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
    ];

    const externalEdge: ImportEdge = {
      from: "src/types.ts", to: "react", isExternal: true,
      specifier: "react", importedNames: ["useState"],
    };

    const graph = makeGraph(
      ["src/types.ts", "src/services.ts"],
      [externalEdge],
    );

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    expect(violations).toHaveLength(0);
  });
});
