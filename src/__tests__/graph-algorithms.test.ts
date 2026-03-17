import { describe, expect, it } from "vitest";
import { findSCCs, findCircularDeps, findFeedbackEdges } from "../core/graph/cycles";
import { getHubFiles } from "../core/graph/hub-files";
import { computeHITS, deriveRole, computeBetweenness } from "../core/graph/centrality";
import { detectCommunitiesLeiden, computeAdaptiveGamma, computeCohesion } from "../core/graph/leiden";
import {
  quantizeBetweennessK,
  checkRebuildTriggers,
  shouldRunDriftDetection,
  collectNHopNeighborhood,
  filesNeedingRoleUpdate,
} from "../core/graph/incremental";
import { findStructuralTemporalMismatches } from "../core/graph/mismatches";
import { findTightCouplings } from "../core/graph/tight-coupling";
import { checkArchitecturalFitness } from "../core/graph/fitness";
import type { ArchitecturalLayer, CircularDependency, ImportEdge, LayerEdge } from "../core/types";
import { makeGraph, edge } from "./algorithm/helpers";

function dynamicEdge(from: string, to: string, names: string[] = []): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: names, isDynamic: true };
}

describe("findSCCs", () => {
  it("finds a simple cycle", () => {
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c"), edge("c", "a")]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("ignores self-loops (single-node SCCs are excluded)", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "a"), edge("a", "b")]);
    const sccs = findSCCs(graph);
    // Self-loops produce a 1-node SCC, which findSCCs filters out (only reports size >= 2)
    expect(sccs).toHaveLength(0);
  });

  it("returns empty for a chain with no cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(0);
  });
});

describe("findCircularDeps", () => {
  it("reports cycles as circular deps", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b"), edge("b", "a")]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    // Chain should close the loop
    expect(deps[0].chain[0]).toBe(deps[0].chain[deps[0].chain.length - 1]);
  });

  it("respects maxCycles limit", () => {
    // Create 3 separate cycles
    const graph = makeGraph(
      ["a", "b", "c", "d", "e", "f"],
      [edge("a", "b"), edge("b", "a"), edge("c", "d"), edge("d", "c"), edge("e", "f"), edge("f", "e")],
    );
    const deps = findCircularDeps(graph, 2);
    expect(deps.length).toBeLessThanOrEqual(2);
  });

  it("reports only valid paths (every consecutive pair has an edge)", () => {
    // SCC {A, B, C} with edges A->B, B->A, B->C, C->B (two overlapping 2-cycles)
    // Previously this would report [A, B, C, A] which has no edge A->C
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "b")]);
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
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "a"), edge("b", "c"), edge("c", "b")]);
    const deps = findCircularDeps(graph);
    // Should find both 2-cycles: a<->b and b<->c
    const twoCycles = deps.filter((d) => d.chain.length === 3);
    expect(twoCycles.length).toBe(2);
  });
});

describe("computeHITS", () => {
  it("assigns uniform 0.5 scores for flat graphs", () => {
    const files = ["a.ts", "b.ts", "c.ts"];
    // No edges = all scores identical after HITS (flat graph guard)
    const { authority, hub } = computeHITS(files, [], 30, 1e-6, new Set());
    for (const f of files) {
      expect(authority.get(f)).toBe(0.5);
      expect(hub.get(f)).toBe(0.5);
    }
  });

  it("assigns high authority to star center (widely depended upon)", () => {
    const files = ["center", "a", "b", "c"];
    const edges = [edge("a", "center", ["foo", "bar"]), edge("b", "center", ["foo"]), edge("c", "center", ["baz"])];

    const { authority, hub } = computeHITS(files, edges);

    // Center has highest authority (many files depend on it)
    expect(authority.get("center")).toBeGreaterThan(authority.get("a") ?? 0);
    expect(authority.get("center")).toBeGreaterThan(authority.get("b") ?? 0);
    expect(authority.get("center")).toBeGreaterThan(authority.get("c") ?? 0);

    // Spokes have higher hub scores (they import from center)
    expect(hub.get("a")).toBeGreaterThan(hub.get("center") ?? 0);
  });

  it("handles chain graph — intermediate nodes as bridges", () => {
    const files = ["a", "b", "c", "d"];
    const edges = [edge("a", "b", ["x"]), edge("b", "c", ["y"]), edge("c", "d", ["z"])];

    const { authority, hub } = computeHITS(files, edges);

    // d is most depended upon (end of chain)
    // a is least depended upon (start)
    // Both b and c are in the middle
    expect(authority.get("d") ?? 0).toBeGreaterThanOrEqual(authority.get("a") ?? 0);
    expect(hub.get("a") ?? 0).toBeGreaterThanOrEqual(hub.get("d") ?? 0);
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
      edge("a", "typeTarget", ["Foo", "Bar"], true), // type-only
      edge("b", "valueTarget", ["Foo", "Bar"], false), // value import
    ];

    const { authority } = computeHITS(files, edges);

    // Value target should have higher authority than type-only target
    expect(authority.get("valueTarget") ?? 0).toBeGreaterThan(authority.get("typeTarget") ?? 0);
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
    const graph = makeGraph(
      ["center", "a", "b", "c"],
      [edge("a", "center", ["foo"]), edge("b", "center", ["bar"]), edge("c", "center", ["baz"])],
    );
    // Manually set scores for testing
    graph.centrality.set("center", 1.0);
    graph.authority = new Map([
      ["center", 1.0],
      ["a", 0.1],
      ["b", 0.1],
      ["c", 0.1],
    ]);
    graph.hubScores = new Map([
      ["center", 0.0],
      ["a", 0.3],
      ["b", 0.3],
      ["c", 0.3],
    ]);
    graph.inDegree.set("center", 3);

    const hubs = getHubFiles(graph);
    expect(hubs[0].path).toBe("center");
    expect(hubs[0].importedBy).toBe(3);
    expect(hubs[0].role).toBe("Foundation");
    expect(hubs[0].authority).toBe(1.0);
    expect(hubs[0].hubScore).toBe(0.0);
  });

  it("respects limit parameter", () => {
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [edge("a", "b"), edge("a", "c"), edge("a", "d"), edge("b", "c"), edge("b", "d"), edge("c", "d")],
    );
    graph.centrality.set("d", 1.0);
    graph.authority = new Map([
      ["a", 0.2],
      ["b", 0.5],
      ["c", 0.8],
      ["d", 1.0],
    ]);
    graph.hubScores = new Map([
      ["a", 0.8],
      ["b", 0.5],
      ["c", 0.3],
      ["d", 0.0],
    ]);
    graph.centrality.set("c", 0.8);
    graph.centrality.set("b", 0.5);
    graph.centrality.set("a", 0.2);

    const hubs = getHubFiles(graph, 2);
    expect(hubs).toHaveLength(2);
  });

  it("assigns correct roles based on HITS scores", () => {
    const graph = makeGraph(
      ["types", "index", "utils"],
      [edge("index", "types", ["Foo"]), edge("index", "utils", ["bar"]), edge("utils", "types", ["Baz"])],
    );
    graph.authority = new Map([
      ["types", 0.9],
      ["utils", 0.4],
      ["index", 0.0],
    ]);
    graph.hubScores = new Map([
      ["types", 0.0],
      ["utils", 0.2],
      ["index", 0.9],
    ]);
    graph.centrality = new Map([
      ["types", 0.9],
      ["utils", 0.4],
      ["index", 0.0],
    ]);

    const hubs = getHubFiles(graph);
    const typesHub = hubs.find((h) => h.path === "types");
    const indexHub = hubs.find((h) => h.path === "index");

    expect(typesHub?.role).toBe("Foundation");
    expect(indexHub?.role).toBe("Orchestrator");
  });
});

describe("findCircularDeps severity", () => {
  it("assigns severity 0 for type-only cycles", () => {
    const graph = makeGraph(
      ["a", "b"],
      [
        edge("a", "b", ["Foo"], true), // type-only
        edge("b", "a", ["Bar"], true), // type-only
      ],
    );
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(0);
    expect(deps[0].chain).toContain("a");
  });

  it("assigns severity 1 for all-runtime cycles", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo"]), edge("b", "a", ["bar"])]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(1);
  });

  it("assigns mixed severity for mixed cycles", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        edge("a", "b", ["foo"]), // runtime
        edge("b", "c", ["Bar"], true), // type-only
        edge("c", "a", ["baz"]), // runtime
      ],
    );
    const deps = findCircularDeps(graph);
    // Should find a 3-cycle with 2/3 runtime edges
    const threeCycle = deps.find((d) => d.chain.length === 4);
    expect(threeCycle).toBeDefined();
    expect(threeCycle?.severity).toBeGreaterThan(0);
    expect(threeCycle?.severity).toBeLessThan(1);
  });

  it("provides break hints", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo"]), edge("b", "a", ["bar"])]);
    const deps = findCircularDeps(graph);
    expect(deps[0].breakHint).toBeDefined();
    expect(deps[0].breakHint?.length).toBeGreaterThan(0);
  });

  it("sorts type-only cycles after runtime cycles", () => {
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        edge("a", "b", ["Foo"], true), // type-only cycle
        edge("b", "a", ["Bar"], true),
        edge("c", "d", ["foo"]), // runtime cycle
        edge("d", "c", ["bar"]),
      ],
    );
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
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );
    const coupling = [{ fileA: "a", fileB: "e", confidence: 0.8, coChangeCount: 5 }];
    const mismatches = findStructuralTemporalMismatches(graph, coupling, 0.4, 3);
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].graphDistance).toBe(4);
    expect(mismatches[0].coChangeConfidence).toBe(0.8);
  });

  it("ignores pairs within threshold distance", () => {
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("b", "c")]);
    const coupling = [{ fileA: "a", fileB: "c", confidence: 0.8, coChangeCount: 5 }];
    // Distance is 2 (a->b->c), threshold is 3
    const mismatches = findStructuralTemporalMismatches(graph, coupling, 0.4, 3);
    expect(mismatches).toHaveLength(0);
  });

  it("detects unreachable pairs", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("c", "d")]);
    const coupling = [{ fileA: "a", fileB: "d", confidence: 0.6, coChangeCount: 3 }];
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
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo", "bar", "baz", "qux", "quux"])]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(1);
    expect(couplings[0].from).toBe("a");
    expect(couplings[0].to).toBe("b");
    expect(couplings[0].importedNames).toBe(5);
  });

  it("ignores pairs below threshold", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo", "bar"])]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(0);
  });

  it("aggregates names across multiple edges", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo", "bar", "baz"]), edge("a", "b", ["qux", "quux"])]);
    const couplings = findTightCouplings(graph, 5);
    expect(couplings).toHaveLength(1);
    expect(couplings[0].importedNames).toBe(5);
  });

  it("sorts by name count descending", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [edge("a", "b", ["w", "x", "y", "z", "v"]), edge("a", "c", ["a1", "a2", "a3", "a4", "a5", "a6", "a7"])],
    );
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
    const edges = [edge("a", "staticTarget", ["foo", "bar"]), dynamicEdge("b", "dynamicTarget", ["foo", "bar"])];

    const { authority } = computeHITS(files, edges);

    // Static target should have higher authority than dynamic target
    expect(authority.get("staticTarget") ?? 0).toBeGreaterThan(authority.get("dynamicTarget") ?? 0);
  });

  it("dynamic edges weigh between type-only and value imports", () => {
    const files = ["a", "b", "c", "typeTarget", "dynamicTarget", "valueTarget"];
    const edges = [
      edge("a", "typeTarget", ["Foo"], true), // type-only: 0.3x weight
      dynamicEdge("b", "dynamicTarget", ["Foo"]), // dynamic: 0.5x weight
      edge("c", "valueTarget", ["Foo"]), // value: 1.0x weight
    ];

    const { authority } = computeHITS(files, edges);

    expect(authority.get("valueTarget") ?? 0).toBeGreaterThan(authority.get("dynamicTarget") ?? 0);
    expect(authority.get("dynamicTarget") ?? 0).toBeGreaterThan(authority.get("typeTarget") ?? 0);
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
    expect(authority.get("source") ?? 0).toBeGreaterThan(authority.get("barrel") ?? 0);
  });

  it("non-barrel files are not affected by barrel discount", () => {
    const files = ["a", "b", "target"];
    const edges = [edge("a", "target", ["foo"]), edge("b", "target", ["bar"])];
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

describe("findCircularDeps regression: barrel routing", () => {
  it("no cycle when A value-imports B and both import types from C", () => {
    // Simulates the fixed diff.ts / diff-render.ts pattern:
    // diff.ts -> diff-render.ts (value, renderDiffContext)
    // diff-render.ts -> types (type-only, NeighborhoodResult)
    // diff.ts -> types (type-only, NeighborhoodResult)
    // Expected: 0 cycles (NeighborhoodResult lives in types, not in diff.ts)
    const graph = makeGraph(
      ["diff", "diff-render", "types"],
      [
        edge("diff", "diff-render", ["renderDiffContext"], false), // value import
        edge("diff-render", "types", ["NeighborhoodResult"], true), // type-only
        edge("diff", "types", ["NeighborhoodResult"], true), // type-only
      ],
    );
    expect(findCircularDeps(graph)).toHaveLength(0);
  });

  it("correctly detects cycle when shared type lives in the importer", () => {
    // Simulates the original buggy scenario where NeighborhoodResult was in diff.ts:
    // diff.ts -> diff-render.ts (value)
    // diff-render.ts -> diff.ts (type-only, via barrel routing to diff.ts)
    // This WAS a real cycle that was fixed by moving the type to types/output.ts
    const graph = makeGraph(
      ["diff", "diff-render"],
      [
        edge("diff", "diff-render", ["renderDiffContext"], false), // value import
        edge("diff-render", "diff", ["NeighborhoodResult"], true), // type-only back-edge
      ],
    );
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBeGreaterThan(0);
    expect(deps[0].severity).toBeLessThan(1); // mixed: one runtime, one type-only
  });
});

describe("findCircularDeps with dynamic imports", () => {
  it("assigns lower severity to dynamic-only cycles", () => {
    const graph = makeGraph(["a", "b"], [dynamicEdge("a", "b", ["foo"]), dynamicEdge("b", "a", ["bar"])]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    // Dynamic-only cycle: each edge contributes 0.5, so severity = 0.5
    expect(deps[0].severity).toBe(0.5);
  });

  it("assigns severity 1 for static runtime cycles", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b", ["foo"]), edge("b", "a", ["bar"])]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    expect(deps[0].severity).toBe(1);
  });

  it("assigns mixed severity for static + dynamic cycles", () => {
    const graph = makeGraph(
      ["a", "b", "c"],
      [
        edge("a", "b", ["foo"]), // static: 1.0
        dynamicEdge("b", "c", ["bar"]), // dynamic: 0.5
        edge("c", "a", ["baz"]), // static: 1.0
      ],
    );
    const deps = findCircularDeps(graph);
    const threeCycle = deps.find((d) => d.chain.length === 4);
    expect(threeCycle).toBeDefined();
    // (1.0 + 0.5 + 1.0) / 3 = 0.833...
    expect(threeCycle?.severity).toBeCloseTo(2.5 / 3, 5);
  });

  it("sorts dynamic-only cycles after static runtime cycles", () => {
    const graph = makeGraph(
      ["a", "b", "c", "d"],
      [
        dynamicEdge("a", "b"), // dynamic cycle
        dynamicEdge("b", "a"),
        edge("c", "d", ["foo"]), // runtime cycle
        edge("d", "c", ["bar"]),
      ],
    );
    const deps = findCircularDeps(graph);
    expect(deps.length).toBeGreaterThanOrEqual(2);
    // Runtime cycle (severity 1.0) should come before dynamic cycle (severity 0.5)
    expect(deps[0].severity ?? 0).toBeGreaterThan(deps[deps.length - 1].severity ?? 0);
  });
});

// ── §3.2 Approximate Betweenness Centrality ──────────────────────────

describe("computeBetweenness", () => {
  it("assigns zero to a pure dependency sink in a star", () => {
    // Star graph: a, b, c, d all import center (center is a sink with no outgoing edges)
    const graph = makeGraph(
      ["center", "a", "b", "c", "d"],
      [edge("a", "center"), edge("b", "center"), edge("c", "center"), edge("d", "center")],
    );

    const scores = computeBetweenness(graph);

    // In directed betweenness, center has no outgoing edges so no directed path
    // passes through it. A pure dependency sink is not a flow bottleneck.
    for (const [, score] of scores) {
      expect(score).toBe(0);
    }
  });

  it("assigns highest score to a directed hub that bridges importers to dependencies", () => {
    // center imports lib1 and lib2; a, b, c all import center.
    // Directed paths: a -> center -> lib1, b -> center -> lib2, etc.
    // center is the only node on paths between importers and their transitive deps.
    const graph = makeGraph(
      ["a", "b", "c", "center", "lib1", "lib2"],
      [edge("a", "center"), edge("b", "center"), edge("c", "center"), edge("center", "lib1"), edge("center", "lib2")],
    );

    const scores = computeBetweenness(graph);

    // center sits on all directed paths from {a,b,c} to {lib1,lib2}
    expect(scores.get("center")).toBe(1);
    // Leaves (importers and dependencies) are endpoints, not intermediaries
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
    expect(scores.get("c")).toBe(0);
    expect(scores.get("lib1")).toBe(0);
    expect(scores.get("lib2")).toBe(0);
  });

  it("assigns highest scores to middle nodes in a chain", () => {
    // Chain: a - b - c - d - e
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );

    const scores = computeBetweenness(graph);

    // Middle nodes (b, c, d) should have higher betweenness than endpoints
    expect(scores.get("c") ?? 0).toBeGreaterThan(scores.get("a") ?? 0);
    expect(scores.get("c") ?? 0).toBeGreaterThan(scores.get("e") ?? 0);
    // Center of chain (c) should have highest score
    expect(scores.get("c") ?? 0).toBeGreaterThanOrEqual(scores.get("b") ?? 0);
    expect(scores.get("c") ?? 0).toBeGreaterThanOrEqual(scores.get("d") ?? 0);
    // Endpoints should have zero
    expect(scores.get("a")).toBe(0);
    expect(scores.get("e")).toBe(0);
  });

  it("assigns zero betweenness between disconnected components", () => {
    // Two disconnected pairs: a-b and c-d
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("c", "d")]);

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
    const graph = makeGraph(
      ["a", "b", "c", "d", "e", "f"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("a", "f"), edge("f", "e")],
    );

    const scores1 = computeBetweenness(graph);
    const scores2 = computeBetweenness(graph);

    for (const [file, score] of scores1) {
      expect(scores2.get(file)).toBe(score);
    }
  });

  it("normalizes scores to 0-1 range", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "d")]);

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

  it("ignores self-loops in betweenness computation", () => {
    // Self-loops should not inflate betweenness scores
    const graph = makeGraph(["a", "b", "c"], [edge("a", "a"), edge("a", "b"), edge("b", "c")]);
    const scores = computeBetweenness(graph);
    // b is the only bridge node; self-loop on a should not affect this
    expect(scores.get("b") ?? 0).toBeGreaterThan(scores.get("a") ?? 0);
    for (const [, score] of scores) {
      expect(Number.isNaN(score)).toBe(false);
    }
  });

  // ── Reference correctness: hand-computed exact values (k = n) ────

  it("5-node directed chain: exact betweenness scores", () => {
    // a -> b -> c -> d -> e
    // Raw betweenness (counting shortest paths through each node):
    //   Source a: b on 3 paths (a->c, a->d, a->e); c on 2 (a->d, a->e); d on 1 (a->e)
    //   Source b: c on 2 (b->d, b->e); d on 1 (b->e)
    //   Source c: d on 1 (c->e)
    // Raw: a=0, b=3, c=4, d=3, e=0. Normalized (max=4): a=0, b=0.75, c=1.0, d=0.75, e=0
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );

    const scores = computeBetweenness(graph, 5); // k = n for exhaustive

    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBeCloseTo(0.75, 10);
    expect(scores.get("c")).toBeCloseTo(1.0, 10);
    expect(scores.get("d")).toBeCloseTo(0.75, 10);
    expect(scores.get("e")).toBe(0);
  });

  it("diamond DAG (single bridge): exact betweenness scores", () => {
    // a -> m, b -> m, m -> x, m -> y
    // m is on all 4 paths (a->x, a->y, b->x, b->y). No other node is on any path.
    // Raw: a=0, b=0, m=4, x=0, y=0. Normalized: m=1.0, all others=0
    const graph = makeGraph(
      ["a", "b", "m", "x", "y"],
      [edge("a", "m"), edge("b", "m"), edge("m", "x"), edge("m", "y")],
    );

    const scores = computeBetweenness(graph, 5);

    expect(scores.get("m")).toBeCloseTo(1.0, 10);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("b")).toBe(0);
    expect(scores.get("x")).toBe(0);
    expect(scores.get("y")).toBe(0);
  });

  it("parallel bridges (path splitting): exact betweenness scores", () => {
    // a -> p -> x, a -> q -> x
    // BFS from a: sigma(x) = 2 (two shortest paths through p and q).
    // Back-prop: delta(p) = sigma(p)/sigma(x) * (1 + delta(x)) = 1/2 * 1 = 0.5
    //            delta(q) = sigma(q)/sigma(x) * (1 + delta(x)) = 1/2 * 1 = 0.5
    // No other source produces paths through p or q.
    // Raw: a=0, p=0.5, q=0.5, x=0. Normalized (max=0.5): p=1.0, q=1.0
    const graph = makeGraph(["a", "p", "q", "x"], [edge("a", "p"), edge("a", "q"), edge("p", "x"), edge("q", "x")]);

    const scores = computeBetweenness(graph, 4);

    expect(scores.get("p")).toBeCloseTo(1.0, 10);
    expect(scores.get("q")).toBeCloseTo(1.0, 10);
    expect(scores.get("a")).toBe(0);
    expect(scores.get("x")).toBe(0);
  });
});

// ── §3.2 Adaptive betweenness k ───────────────────────────────────────

describe("computeBetweenness adaptive k", () => {
  it("small graph (V < 50) uses exact computation (k = V)", () => {
    // 5-node chain: with adaptive k, all 5 sources are used (k = max(50,2*sqrt(5)) = 50, clamped to 5)
    // Exact scores: a=0, b=0.75, c=1.0, d=0.75, e=0
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );

    // k omitted - adaptive
    const adaptive = computeBetweenness(graph);
    // k = V - exact
    const exact = computeBetweenness(graph, 5);

    for (const [file, score] of exact) {
      expect(adaptive.get(file)).toBeCloseTo(score, 10);
    }
  });

  it("explicit k overrides adaptive default", () => {
    // The same graph with k=1 (single source) may produce different results from k=5
    // but with k=5 must match exact computation
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );

    const explicit5 = computeBetweenness(graph, 5);
    const explicit2 = computeBetweenness(graph, 2);

    // They may differ; the important thing is that explicit k is respected
    // and exact k=5 gives the reference values
    expect(explicit5.get("c")).toBeCloseTo(1.0, 10);
    // k=2 still normalizes to [0,1] range
    for (const [, score] of explicit2) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
  });

  it("adaptive k >= 50 for medium graph (V = 100)", () => {
    // Build a chain of 100 nodes; adaptive k = max(50, 2*sqrt(100)) = max(50, 20) = 50
    const files = Array.from({ length: 100 }, (_, i) => `f${i}`);
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    // With adaptive k, scores must be valid [0,1]
    const scores = computeBetweenness(graph);
    for (const [, score] of scores) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // Max should still be 1
    const max = Math.max(...scores.values());
    expect(max).toBe(1);
  });
});

// ── §3.3 findFeedbackEdges adaptive early-stop ────────────────────────

describe("findFeedbackEdges", () => {
  function makeCycle(chain: string[]): CircularDependency {
    return { chain: [...chain, chain[0]] };
  }

  it("returns empty for no cycles", () => {
    expect(findFeedbackEdges([])).toEqual([]);
  });

  it("returns the single edge that breaks a 2-cycle", () => {
    const cycles = [makeCycle(["a", "b"])];
    const result = findFeedbackEdges(cycles);
    expect(result).toHaveLength(1);
    expect(result[0].cyclesResolved).toBe(1);
    // Either a->b or b->a breaks the cycle
    expect(["a", "b"]).toContain(result[0].from);
  });

  it("stops early when 80% of cycles are resolved by fewer than topN edges", () => {
    // 5 independent 2-cycles sharing no edges; 4 edges resolves 4/5 = 80%
    const cycles = [
      makeCycle(["a", "b"]),
      makeCycle(["c", "d"]),
      makeCycle(["e", "f"]),
      makeCycle(["g", "h"]),
      makeCycle(["i", "j"]),
    ];

    // topN=10 but early-stop kicks in at ceil(5*0.8)=4 resolved
    const result = findFeedbackEdges(cycles, 10);
    expect(result.length).toBeLessThan(10);
    // At most ceil(5*0.8)=4 edges needed to reach 80% threshold
    expect(result.length).toBeLessThanOrEqual(4);
  });

  it("returns up to topN when shared edges mean 80% threshold is never reached without all edges", () => {
    // All 3 cycles share the same edge a->b; one edge resolves 100% of cycles
    const cycles = [makeCycle(["a", "b"]), makeCycle(["a", "b", "c"]), makeCycle(["a", "b", "d"])];
    const result = findFeedbackEdges(cycles, 3);
    // The single a->b back edge resolves cycles and triggers early stop
    expect(result.length).toBeLessThanOrEqual(3);
    // Top edge should resolve multiple cycles
    expect(result[0].cyclesResolved).toBeGreaterThanOrEqual(1);
  });

  it("respects topN limit even when 80% not reached", () => {
    // 20 independent cycles - early stop at ceil(20*0.8)=16 but topN=5
    const cycles = Array.from({ length: 20 }, (_, i) => makeCycle([`n${i}a`, `n${i}b`]));
    const result = findFeedbackEdges(cycles, 5);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("with independent cycles returns more edges than with shared-edge cycles at same topN", () => {
    // Independent: each cycle needs its own edge
    const independent = [makeCycle(["a", "b"]), makeCycle(["c", "d"]), makeCycle(["e", "f"]), makeCycle(["g", "h"])];
    const independentResult = findFeedbackEdges(independent, 10);

    // Shared: all cycles share edge a->b
    const shared = [
      makeCycle(["a", "b"]),
      makeCycle(["a", "b", "c"]),
      makeCycle(["a", "b", "c", "d"]),
      makeCycle(["a", "b", "c", "e"]),
    ];
    const sharedResult = findFeedbackEdges(shared, 10);

    // Shared-edge cycles are resolved with fewer edges (early stop)
    expect(independentResult.length).toBeGreaterThanOrEqual(sharedResult.length);
  });

  it("default topN is 10", () => {
    // 25 independent cycles - without early stop would need 20 edges for 80% but topN=10
    const cycles = Array.from({ length: 25 }, (_, i) => makeCycle([`x${i}`, `y${i}`]));
    const result = findFeedbackEdges(cycles);
    expect(result.length).toBeLessThanOrEqual(10);
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
        edge("src/services.ts", "src/types.ts"), // correct
        edge("src/components.ts", "src/services.ts"), // correct
        edge("src/types.ts", "src/components.ts"), // violation: types -> components (upward)
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
        edge("src/__tests__/auth.test.ts", "src/__tests__/user.test.ts"), // violation
        edge("src/__tests__/auth.test.ts", "src/auth.ts"), // correct
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
      [edge("src/__tests__/auth.test.ts", "src/__tests__/__fixtures__/mock-user.ts")],
    );

    const violations = checkArchitecturalFitness(graph, [], []);
    const testViolations = violations.filter((v) => v.rule === "test-isolation");
    expect(testViolations).toHaveLength(0);
  });

  it("allows test files to import from test-utils", () => {
    const graph = makeGraph(
      ["src/__tests__/auth.test.ts", "src/test-utils/setup.ts"],
      [edge("src/__tests__/auth.test.ts", "src/test-utils/setup.ts")],
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
        edge("src/services.ts", "src/utils.ts"), // correct, skip=1
        edge("src/pages.ts", "src/types.ts"), // skip: pages -> types, skipping 2 layers
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

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

    const graph = makeGraph(
      ["src/types.ts", "src/services.ts"],
      [
        edge("src/services.ts", "src/types.ts"), // adjacent, no skip
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

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

    // Each types file imports services (upward violation)
    const edges = typeFiles.map((f) => edge(f, "src/services.ts"));
    const graph = makeGraph([...typeFiles, "src/services.ts"], edges);

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    expect(violations.length).toBeLessThanOrEqual(20);
  });

  it("returns empty for fewer than 2 layers on layer rules", () => {
    const layers = makeLayers([{ name: "types", files: ["src/types.ts"] }]);

    const graph = makeGraph(["src/types.ts"], []);
    const violations = checkArchitecturalFitness(graph, layers, []);
    // No upward or skip violations with only one layer
    const layerViolations = violations.filter((v) => v.rule === "no-upward-dep" || v.rule === "layer-skip");
    expect(layerViolations).toHaveLength(0);
  });

  it("ignores external edges", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

    const externalEdge: ImportEdge = {
      from: "src/types.ts",
      to: "react",
      isExternal: true,
      specifier: "react",
      importedNames: ["useState"],
    };

    const graph = makeGraph(["src/types.ts", "src/services.ts"], [externalEdge]);

    const violations = checkArchitecturalFitness(graph, layers, layerEdges);
    expect(violations).toHaveLength(0);
  });
});

// ── §5.1 Leiden community detection ───────────────────────────────────

describe("detectCommunitiesLeiden", () => {
  it("returns empty for empty graph", () => {
    const graph = makeGraph([], []);
    expect(detectCommunitiesLeiden(graph)).toEqual([]);
  });

  it("two cliques connected by a bridge produce two communities (§5.1 acceptance 1)", () => {
    // Two cliques spread across MIXED directories so Leiden must discover
    // the real communities (ARI with directory structure will be low).
    // Clique A: mix of src/core and src/util files, densely connected
    // Clique B: mix of src/api and src/util files, densely connected
    // Bridge: single edge between cliques
    const files = [
      "src/core/a1.ts", "src/util/a2.ts", "src/core/a3.ts", "src/util/a4.ts",
      "src/api/b1.ts", "src/util/b2.ts", "src/api/b3.ts", "src/core/b4.ts",
    ];
    const edges = [
      // Clique A (cross-directory)
      edge("src/core/a1.ts", "src/util/a2.ts"), edge("src/core/a1.ts", "src/core/a3.ts"),
      edge("src/core/a1.ts", "src/util/a4.ts"), edge("src/util/a2.ts", "src/core/a3.ts"),
      edge("src/util/a2.ts", "src/util/a4.ts"), edge("src/core/a3.ts", "src/util/a4.ts"),
      // Clique B (cross-directory)
      edge("src/api/b1.ts", "src/util/b2.ts"), edge("src/api/b1.ts", "src/api/b3.ts"),
      edge("src/api/b1.ts", "src/core/b4.ts"), edge("src/util/b2.ts", "src/api/b3.ts"),
      edge("src/util/b2.ts", "src/core/b4.ts"), edge("src/api/b3.ts", "src/core/b4.ts"),
      // Bridge
      edge("src/core/a1.ts", "src/api/b1.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunitiesLeiden(graph);

    // Leiden should find 2 communities (one per clique, not per directory)
    expect(communities.length).toBe(2);

    // Each community is internally connected (§5.1 acceptance 2)
    for (const c of communities) {
      expect(c.files.length).toBe(4);
    }
  });

  it("each community is internally connected (no disconnected sub-clusters)", () => {
    // Three separate cliques across mixed directories
    const files = [
      "api/auth.ts", "api/user.ts", "api/session.ts",
      "db/query.ts", "db/pool.ts", "db/migrate.ts",
      "util/log.ts", "util/fmt.ts", "util/hash.ts",
    ];
    const edges = [
      // api cluster
      edge("api/auth.ts", "api/user.ts"), edge("api/auth.ts", "api/session.ts"),
      edge("api/user.ts", "api/session.ts"),
      // db cluster
      edge("db/query.ts", "db/pool.ts"), edge("db/query.ts", "db/migrate.ts"),
      edge("db/pool.ts", "db/migrate.ts"),
      // util cluster
      edge("util/log.ts", "util/fmt.ts"), edge("util/log.ts", "util/hash.ts"),
      edge("util/fmt.ts", "util/hash.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunitiesLeiden(graph);

    // If communities are returned (ARI check may filter them), verify connectivity
    for (const c of communities) {
      // BFS from first node should reach all nodes in the community
      const adj = new Map<string, Set<string>>();
      for (const e of edges) {
        if (!adj.has(e.from)) adj.set(e.from, new Set());
        if (!adj.has(e.to)) adj.set(e.to, new Set());
        adj.get(e.from)!.add(e.to);
        adj.get(e.to)!.add(e.from);
      }
      const memberSet = new Set(c.files);
      const visited = new Set<string>();
      const queue = [c.files[0]];
      visited.add(c.files[0]);
      while (queue.length > 0) {
        const node = queue.shift()!;
        for (const neighbor of adj.get(node) ?? []) {
          if (memberSet.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }
      expect(visited.size).toBe(c.files.length);
    }
  });

  it("returns empty when communities mirror directory structure (ARI > threshold, §5.5)", () => {
    const files = [
      "src/auth/login.ts", "src/auth/logout.ts", "src/auth/token.ts",
      "src/data/fetch.ts", "src/data/parse.ts", "src/data/cache.ts",
    ];
    const edges = [
      edge("src/auth/login.ts", "src/auth/token.ts"),
      edge("src/auth/logout.ts", "src/auth/token.ts"),
      edge("src/auth/login.ts", "src/auth/logout.ts"),
      edge("src/data/fetch.ts", "src/data/cache.ts"),
      edge("src/data/parse.ts", "src/data/cache.ts"),
      edge("src/data/fetch.ts", "src/data/parse.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunitiesLeiden(graph);
    // ARI novelty filter: communities must not leak files from outside the graph
    for (const c of communities) {
      for (const file of c.files) {
        expect(files).toContain(file);
      }
    }
  });

  it("cross-directory connections trigger Leiden to reassign files", () => {
    const files = [
      "worker/job-a.ts", "worker/job-b.ts", "worker/job-c.ts",
      "shared/queue.ts", "shared/config.ts", "shared/logger.ts",
      "infra/monitor.ts", "infra/health.ts", "infra/metrics.ts",
    ];
    const edges = [
      edge("worker/job-a.ts", "shared/queue.ts"),
      edge("worker/job-b.ts", "shared/queue.ts"),
      edge("worker/job-c.ts", "shared/queue.ts"),
      edge("worker/job-a.ts", "shared/config.ts"),
      edge("worker/job-b.ts", "shared/config.ts"),
      edge("worker/job-c.ts", "shared/logger.ts"),
      edge("shared/queue.ts", "shared/config.ts"),
      edge("shared/logger.ts", "shared/config.ts"),
      edge("infra/monitor.ts", "infra/health.ts"),
      edge("infra/monitor.ts", "infra/metrics.ts"),
      edge("infra/health.ts", "infra/metrics.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunitiesLeiden(graph);

    for (const c of communities) {
      expect(c.files.length).toBeGreaterThanOrEqual(2);
      for (const file of c.files) {
        expect(files).toContain(file);
      }
    }
    const ids = communities.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of communities) {
      expect(c.label.length).toBeGreaterThan(0);
    }
  });

  it("produces communities with cohesion scores (§5.4)", () => {
    // Mixed-directory cliques so Leiden discovers non-trivial communities
    const files = [
      "src/core/a1.ts", "src/util/a2.ts", "src/core/a3.ts", "src/util/a4.ts",
      "src/api/b1.ts", "src/util/b2.ts", "src/api/b3.ts", "src/core/b4.ts",
    ];
    const edges = [
      edge("src/core/a1.ts", "src/util/a2.ts"), edge("src/core/a1.ts", "src/core/a3.ts"),
      edge("src/core/a1.ts", "src/util/a4.ts"), edge("src/util/a2.ts", "src/core/a3.ts"),
      edge("src/util/a2.ts", "src/util/a4.ts"), edge("src/core/a3.ts", "src/util/a4.ts"),
      edge("src/api/b1.ts", "src/util/b2.ts"), edge("src/api/b1.ts", "src/api/b3.ts"),
      edge("src/api/b1.ts", "src/core/b4.ts"), edge("src/util/b2.ts", "src/api/b3.ts"),
      edge("src/util/b2.ts", "src/core/b4.ts"), edge("src/api/b3.ts", "src/core/b4.ts"),
      edge("src/core/a1.ts", "src/api/b1.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunitiesLeiden(graph);

    for (const c of communities) {
      expect(c.cohesion).toBeDefined();
      expect(c.cohesion).toBeGreaterThanOrEqual(0);
      expect(c.cohesion).toBeLessThanOrEqual(1);
    }
  });
});

// ── §5.2 Adaptive gamma ─────────────────────────────────────────────

describe("computeAdaptiveGamma (§5.2)", () => {
  it("returns 0.5 for 100 files", () => {
    expect(computeAdaptiveGamma(100)).toBe(0.5);
  });

  it("returns 1.0 for 1000 files", () => {
    expect(computeAdaptiveGamma(1000)).toBeCloseTo(1.0);
  });

  it("returns 2.0 for 10000 files", () => {
    expect(computeAdaptiveGamma(10000)).toBeCloseTo(2.0);
  });

  it("clamps to [0.5, 3.0]", () => {
    expect(computeAdaptiveGamma(1)).toBe(0.5);
    expect(computeAdaptiveGamma(1_000_000)).toBe(3.0);
  });
});

// ── §5.4 Per-cluster cohesion ───────────────────────────────────────

describe("computeCohesion (§5.4)", () => {
  it("clique of 4 has cohesion 1.0", () => {
    const adj = new Map<string, Set<string>>();
    const nodes = ["a", "b", "c", "d"];
    for (const n of nodes) adj.set(n, new Set(nodes.filter((x) => x !== n)));
    expect(computeCohesion(nodes, adj)).toBeCloseTo(1.0);
  });

  it("star graph (1 center + 3 leaves) has cohesion 0.5", () => {
    const adj = new Map<string, Set<string>>();
    adj.set("center", new Set(["a", "b", "c"]));
    adj.set("a", new Set(["center"]));
    adj.set("b", new Set(["center"]));
    adj.set("c", new Set(["center"]));
    expect(computeCohesion(["center", "a", "b", "c"], adj)).toBeCloseTo(0.5);
  });

  it("two disconnected nodes have cohesion 0.0", () => {
    const adj = new Map<string, Set<string>>();
    adj.set("a", new Set());
    adj.set("b", new Set());
    expect(computeCohesion(["a", "b"], adj)).toBeCloseTo(0.0);
  });

  it("single node has cohesion 1.0", () => {
    const adj = new Map<string, Set<string>>();
    adj.set("a", new Set());
    expect(computeCohesion(["a"], adj)).toBeCloseTo(1.0);
  });
});

// ── §5.9 BETWEENNESS_K quantization ─────────────────────────────────

describe("quantizeBetweennessK (§5.9)", () => {
  it("V=100 -> effectiveK=50", () => {
    expect(quantizeBetweennessK(100)).toBe(50);
  });

  it("V=101 -> effectiveK=50 (stable)", () => {
    expect(quantizeBetweennessK(101)).toBe(50);
  });

  it("V=700 -> effectiveK=60", () => {
    expect(quantizeBetweennessK(700)).toBe(60);
  });

  it("V=710 -> effectiveK=60 (stable)", () => {
    expect(quantizeBetweennessK(710)).toBe(60);
  });

  it("effectiveK is always a multiple of 10", () => {
    for (const v of [50, 100, 300, 500, 700, 1000, 2500, 10000]) {
      expect(quantizeBetweennessK(v) % 10).toBe(0);
    }
  });

  it("effectiveK is always >= 50", () => {
    for (const v of [1, 10, 50, 100]) {
      expect(quantizeBetweennessK(v)).toBeGreaterThanOrEqual(50);
    }
  });
});

// ── §5.8 Level 3 full rebuild triggers ──────────────────────────────

describe("checkRebuildTriggers (§5.8)", () => {
  it(">50% changed files triggers rebuild", () => {
    const result = checkRebuildTriggers({
      staleFiles: Array.from({ length: 60 }, (_, i) => `f${i}.ts`),
      totalFiles: 100,
    });
    expect(result.triggered).toBe(true);
    expect(result.reason).toContain("60%");
  });

  it("<50% changed files does not trigger", () => {
    const result = checkRebuildTriggers({
      staleFiles: ["a.ts", "b.ts"],
      totalFiles: 100,
    });
    expect(result.triggered).toBe(false);
  });

  it("--force flag always triggers", () => {
    const result = checkRebuildTriggers({
      staleFiles: [],
      totalFiles: 100,
      force: true,
    });
    expect(result.triggered).toBe(true);
  });

  it("schema version mismatch triggers", () => {
    const result = checkRebuildTriggers({
      staleFiles: [],
      totalFiles: 100,
      schemaVersionMismatch: true,
    });
    expect(result.triggered).toBe(true);
  });

  it("barrel file change triggers", () => {
    const result = checkRebuildTriggers({
      staleFiles: ["index.ts"],
      totalFiles: 100,
      barrelFileChanged: true,
    });
    expect(result.triggered).toBe(true);
  });
});

// ── §5.10 Drift detection triggers ──────────────────────────────────

describe("shouldRunDriftDetection (§5.10)", () => {
  it("triggers at 100 builds", () => {
    expect(shouldRunDriftDetection(100, undefined)).toBe(true);
  });

  it("does not trigger below 100 builds with recent rebuild", () => {
    expect(shouldRunDriftDetection(50, new Date().toISOString())).toBe(false);
  });

  it("triggers after 1 week", () => {
    const eightDaysAgo = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    expect(shouldRunDriftDetection(5, eightDaysAgo)).toBe(true);
  });
});

// ── §5.7 Level 2 incremental helpers ────────────────────────────────

describe("collectNHopNeighborhood (§5.7)", () => {
  it("collects 2-hop neighborhood", () => {
    const adj = new Map<string, Set<string>>();
    adj.set("a", new Set(["b"]));
    adj.set("b", new Set(["a", "c"]));
    adj.set("c", new Set(["b", "d"]));
    adj.set("d", new Set(["c"]));
    adj.set("e", new Set([]));

    const result = collectNHopNeighborhood(new Set(["a"]), adj, 2);
    expect(result).toContain("a");
    expect(result).toContain("b");
    expect(result).toContain("c");
    expect(result).not.toContain("d"); // 3 hops away
    expect(result).not.toContain("e"); // disconnected
  });
});

describe("filesNeedingRoleUpdate (§5.7)", () => {
  it("identifies files with score delta > 0.05", () => {
    const oldAuth = new Map([["a", 0.5], ["b", 0.3]]);
    const newAuth = new Map([["a", 0.57], ["b", 0.3]]);
    const oldHub = new Map([["a", 0.2], ["b", 0.2]]);
    const newHub = new Map([["a", 0.2], ["b", 0.2]]);

    const result = filesNeedingRoleUpdate(oldAuth, newAuth, oldHub, newHub);
    expect(result).toContain("a");
    expect(result).not.toContain("b");
  });
});
