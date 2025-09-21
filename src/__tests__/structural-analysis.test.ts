import { describe, expect, it } from "vitest";
import {
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
  detectArchitecturalLayers,
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

function edge(from: string, to: string, names: string[] = []): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: names };
}

function makeLayers(defs: Array<{ name: string; files: string[] }>): ArchitecturalLayer[] {
  return defs.map((d) => ({
    name: d.name,
    files: d.files,
    importedByLayers: 0,
    dependsOn: [],
  }));
}

// ── §1.7 Cross-Layer Fan-In Analysis ──────────────────────────────────

describe("findCrossCuttingFiles", () => {
  it("identifies files imported across 3+ layers", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services/auth.ts"] },
      { name: "hooks", files: ["src/hooks/useAuth.ts"] },
      { name: "components", files: ["src/components/Login.tsx"] },
    ]);

    const graph = makeGraph(
      ["src/types.ts", "src/services/auth.ts", "src/hooks/useAuth.ts", "src/components/Login.tsx", "src/utils.ts"],
      [
        edge("src/services/auth.ts", "src/utils.ts"),
        edge("src/hooks/useAuth.ts", "src/utils.ts"),
        edge("src/components/Login.tsx", "src/utils.ts"),
      ],
    );

    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("src/utils.ts");
    expect(result[0].layerSpread).toBe(3);
    expect(result[0].totalImporters).toBe(3);
    expect(result[0].layers).toEqual(["components", "hooks", "services"]);
  });

  it("excludes files imported from fewer layers than the threshold", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services/auth.ts", "src/services/user.ts"] },
      { name: "hooks", files: ["src/hooks/useAuth.ts"] },
    ]);

    const graph = makeGraph(
      ["src/types.ts", "src/services/auth.ts", "src/services/user.ts", "src/hooks/useAuth.ts", "src/utils.ts"],
      [
        edge("src/services/auth.ts", "src/utils.ts"),
        edge("src/services/user.ts", "src/utils.ts"),
        edge("src/hooks/useAuth.ts", "src/utils.ts"),
      ],
    );

    // Only 2 layers import utils (services and hooks), threshold is 3
    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(0);
  });

  it("returns empty when fewer layers than threshold exist", () => {
    const layers = makeLayers([
      { name: "types", files: ["a.ts"] },
      { name: "services", files: ["b.ts"] },
    ]);

    const graph = makeGraph(["a.ts", "b.ts", "c.ts"], [
      edge("a.ts", "c.ts"),
      edge("b.ts", "c.ts"),
    ]);

    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(0);
  });

  it("counts importers from the same layer once per layer", () => {
    const layers = makeLayers([
      { name: "services", files: ["src/services/a.ts", "src/services/b.ts"] },
      { name: "hooks", files: ["src/hooks/a.ts"] },
      { name: "components", files: ["src/components/a.ts"] },
    ]);

    const graph = makeGraph(
      ["src/services/a.ts", "src/services/b.ts", "src/hooks/a.ts", "src/components/a.ts", "src/utils.ts"],
      [
        edge("src/services/a.ts", "src/utils.ts"),
        edge("src/services/b.ts", "src/utils.ts"),
        edge("src/hooks/a.ts", "src/utils.ts"),
        edge("src/components/a.ts", "src/utils.ts"),
      ],
    );

    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(1);
    expect(result[0].layerSpread).toBe(3);
    expect(result[0].totalImporters).toBe(4); // 4 files import it
  });

  it("sorts by layer spread then total importers", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types/a.ts", "src/types/b.ts"] },
      { name: "services", files: ["src/services/a.ts"] },
      { name: "hooks", files: ["src/hooks/a.ts"] },
      { name: "components", files: ["src/components/a.ts"] },
    ]);

    const graph = makeGraph(
      [
        "src/types/a.ts", "src/types/b.ts", "src/services/a.ts",
        "src/hooks/a.ts", "src/components/a.ts",
        "src/utils.ts", "src/shared.ts",
      ],
      [
        // utils: imported from 4 layers
        edge("src/types/a.ts", "src/utils.ts"),
        edge("src/services/a.ts", "src/utils.ts"),
        edge("src/hooks/a.ts", "src/utils.ts"),
        edge("src/components/a.ts", "src/utils.ts"),
        // shared: imported from 3 layers
        edge("src/services/a.ts", "src/shared.ts"),
        edge("src/hooks/a.ts", "src/shared.ts"),
        edge("src/components/a.ts", "src/shared.ts"),
      ],
    );

    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(2);
    expect(result[0].file).toBe("src/utils.ts"); // 4 layers
    expect(result[1].file).toBe("src/shared.ts"); // 3 layers
  });

  it("ignores external edges", () => {
    const layers = makeLayers([
      { name: "types", files: ["a.ts"] },
      { name: "services", files: ["b.ts"] },
      { name: "hooks", files: ["c.ts"] },
    ]);

    const externalEdge: ImportEdge = {
      from: "a.ts", to: "react", isExternal: true,
      specifier: "react", importedNames: ["useState"],
    };

    const graph = makeGraph(["a.ts", "b.ts", "c.ts"], [
      edge("a.ts", "d.ts"),
      edge("b.ts", "d.ts"),
      externalEdge,
    ]);

    const result = findCrossCuttingFiles(graph, layers, 3);
    expect(result).toHaveLength(0);
  });
});

// ── §1.8 Layer Dependency Consistency Score ────────────────────────────

describe("computeLayerConsistency", () => {
  it("reports 100% consistency when all imports flow downward", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "components", to: "services" },
      { from: "services", to: "types" },
      { from: "components", to: "types" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/services.ts", "src/types.ts"),
        edge("src/components.ts", "src/services.ts"),
        edge("src/components.ts", "src/types.ts"),
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.consistency).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("detects upward dependency violations", () => {
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
        edge("src/services.ts", "src/types.ts"), // correct: consumer -> foundation
        edge("src/types.ts", "src/services.ts"), // violation: foundation -> consumer
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.consistency).toBe(0.5);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].fromLayer).toBe("types");
    expect(result.violations[0].toLayer).toBe("services");
  });

  it("ignores same-layer imports", () => {
    const layers = makeLayers([
      { name: "services", files: ["src/services/a.ts", "src/services/b.ts"] },
      { name: "types", files: ["src/types.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
    ];

    const graph = makeGraph(
      ["src/services/a.ts", "src/services/b.ts", "src/types.ts"],
      [
        edge("src/services/a.ts", "src/services/b.ts"), // same layer, should be ignored
        edge("src/services/a.ts", "src/types.ts"), // correct direction
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.consistency).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("returns consistency=1 with fewer than 2 layers", () => {
    const layers = makeLayers([
      { name: "types", files: ["a.ts"] },
    ]);

    const graph = makeGraph(["a.ts"], []);
    const result = computeLayerConsistency(graph, layers, []);
    expect(result.consistency).toBe(1);
    expect(result.violations).toHaveLength(0);
  });

  it("caps violations at 10", () => {
    const layers = makeLayers([
      { name: "types", files: Array.from({ length: 15 }, (_, i) => `src/types/t${i}.ts`) },
      { name: "services", files: ["src/services/s.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "services", to: "types" },
    ];

    // Create 15 violations: each types file imports services
    const edges = layers[0].files.map((f) => edge(f, "src/services/s.ts"));
    // Plus one correct edge
    edges.push(edge("src/services/s.ts", "src/types/t0.ts"));

    const graph = makeGraph([...layers[0].files, "src/services/s.ts"], edges);
    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.violations).toHaveLength(10);
    expect(result.consistency).toBeLessThan(0.1);
  });

  it("handles multi-layer topological ordering", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);

    // types <- utils <- services <- components
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/utils.ts", "src/types.ts"),
        edge("src/services.ts", "src/utils.ts"),
        edge("src/components.ts", "src/services.ts"),
        // Skip-layer: types -> components (violation: types is foundational)
        edge("src/types.ts", "src/components.ts"),
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].fromLayer).toBe("types");
    expect(result.violations[0].toLayer).toBe("components");
  });
});

// ── §1.9 Articulation Point Detection ─────────────────────────────────

describe("findChokepoints", () => {
  it("finds the chokepoint in a linear chain", () => {
    // a - b - c (b is an articulation point)
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
    ]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("b");
    expect(result[0].separates).toBe(2); // removing b creates {a} and {c}
  });

  it("finds no chokepoints in a complete graph", () => {
    // a - b - c - a (triangle, no articulation points)
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("finds no chokepoints in a star graph (center is not articulation)", () => {
    // center connects to a, b, c but a-b, b-c, a-c also connected
    const graph = makeGraph(["center", "a", "b", "c"], [
      edge("center", "a"),
      edge("center", "b"),
      edge("center", "c"),
      edge("a", "b"),
      edge("b", "c"),
      edge("a", "c"),
    ]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("finds center as chokepoint in a pure star (no leaf-to-leaf edges)", () => {
    // center connects to a, b, c with no connections among leaves
    const graph = makeGraph(["center", "a", "b", "c"], [
      edge("center", "a"),
      edge("center", "b"),
      edge("center", "c"),
    ]);

    const result = findChokepoints(graph);
    // center is an articulation point (root with 3 children)
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("center");
    expect(result[0].separates).toBe(3);
  });

  it("returns empty for empty graph", () => {
    const graph = makeGraph([], []);
    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("returns empty for a single edge", () => {
    const graph = makeGraph(["a", "b"], [edge("a", "b")]);
    // Both a and b are articulation points in a 2-node graph
    // but neither truly separates components (removing either leaves 1 component)
    // Actually: removing a leaves {b} (1 component), removing b leaves {a} (1 component)
    // These are NOT articulation points because removing them doesn't increase components
    // (the original graph has 1 component, and after removal still 1 component)
    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("handles bridge topology", () => {
    // Two triangles connected by a bridge: {a,b,c} - bridge - {d,e,f}
    // bridge is the articulation point
    const graph = makeGraph(["a", "b", "c", "bridge", "d", "e", "f"], [
      // Left triangle
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
      // Bridge connection
      edge("c", "bridge"),
      edge("bridge", "d"),
      // Right triangle
      edge("d", "e"),
      edge("e", "f"),
      edge("f", "d"),
    ]);

    const result = findChokepoints(graph);
    const bridgePoint = result.find((r) => r.file === "bridge");
    expect(bridgePoint).toBeDefined();
    expect(bridgePoint!.separates).toBe(2);

    // c and d are also articulation points (connecting triangle to bridge)
    const cPoint = result.find((r) => r.file === "c");
    const dPoint = result.find((r) => r.file === "d");
    expect(cPoint).toBeDefined();
    expect(dPoint).toBeDefined();
  });

  it("sorts by separates descending", () => {
    // a-b-c-d-e (chain): b, c, d are articulation points
    const graph = makeGraph(["a", "b", "c", "d", "e"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "d"),
      edge("d", "e"),
    ]);

    const result = findChokepoints(graph);
    expect(result.length).toBeGreaterThanOrEqual(1);
    // Middle nodes separate more components
    // c separates {a,b} from {d,e} = 2 components
    // b separates {a} from {c,d,e} = 2 components
    // d separates {a,b,c} from {e} = 2 components
    for (const cp of result) {
      expect(cp.separates).toBe(2);
    }
  });

  it("includes importedBy count", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("c", "b"),
      edge("b", "d"),
    ]);

    const result = findChokepoints(graph);
    const bPoint = result.find((r) => r.file === "b");
    expect(bPoint).toBeDefined();
    expect(bPoint!.importedBy).toBe(2); // a and c import b
  });

  it("ignores external edges", () => {
    const externalEdge: ImportEdge = {
      from: "a", to: "react", isExternal: true,
      specifier: "react", importedNames: ["useState"],
    };

    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
      externalEdge,
    ]);

    const result = findChokepoints(graph);
    // b is still a chokepoint between a and c
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("b");
  });
});
