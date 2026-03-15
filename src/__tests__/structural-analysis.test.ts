import { describe, expect, it } from "vitest";
import { findCrossCuttingFiles } from "../core/graph/cross-cutting.js";
import { computeLayerConsistency, detectArchitecturalLayers } from "../core/graph/layers.js";
import { findChokepoints } from "../core/graph/chokepoints.js";
import type { ArchitecturalLayer, ImportEdge, LayerEdge } from "../core/types.js";
import { makeGraph, edge } from "./algorithm/helpers.js";

function makeLayers(defs: Array<{ name: string; files: string[] }>): ArchitecturalLayer[] {
  return defs.map((d) => ({
    name: d.name,
    files: d.files,
    importedByLayers: 0,
    dependsOn: [],
  }));
}

// ── §1.12 User-Configurable Layer Patterns ─────────────────────────────

describe("detectArchitecturalLayers with custom patterns", () => {
  it("uses custom patterns to classify files", () => {
    const files = ["src/domain/user.ts", "src/infra/db.ts", "src/app/handler.ts"];
    const graph = makeGraph(files, [
      edge("src/app/handler.ts", "src/domain/user.ts"),
      edge("src/infra/db.ts", "src/domain/user.ts"),
    ]);

    const customLayers = [
      { name: "domain", pattern: "(?:^|/)domain/" },
      { name: "infra", pattern: "(?:^|/)infra/" },
      { name: "app", pattern: "(?:^|/)app/" },
    ];

    const { layers } = detectArchitecturalLayers(graph, customLayers);
    const names = layers.map((l) => l.name);
    expect(names).toContain("domain");
    expect(names).toContain("infra");
    expect(names).toContain("app");

    const domain = layers.find((l) => l.name === "domain");
    expect(domain).toBeDefined();
    expect(domain?.files).toEqual(["src/domain/user.ts"]);
    expect(domain.importedByLayers).toBe(2); // app and infra import domain
  });

  it("custom patterns take priority over built-in patterns", () => {
    // "app" matches built-in "pages" pattern, but custom "application" should win
    const files = ["src/app/index.ts", "src/types/model.ts"];
    const graph = makeGraph(files, [edge("src/app/index.ts", "src/types/model.ts")]);

    const customLayers = [{ name: "application", pattern: "(?:^|/)app/" }];

    const { layers } = detectArchitecturalLayers(graph, customLayers);
    const names = layers.map((l) => l.name);
    expect(names).toContain("application");
    // The built-in "pages" pattern also matches app/, but custom should win
    expect(names).not.toContain("pages");
    // Built-in "types" pattern still works for non-overridden paths
    expect(names).toContain("types");
  });

  it("falls back to built-in patterns when no custom layers provided", () => {
    const files = ["src/types/model.ts", "src/components/Button.tsx"];
    const graph = makeGraph(files, [edge("src/components/Button.tsx", "src/types/model.ts")]);

    const { layers } = detectArchitecturalLayers(graph);
    const names = layers.map((l) => l.name);
    expect(names).toContain("types");
    expect(names).toContain("components");
  });

  it("computes layer edges correctly with custom patterns", () => {
    const files = ["src/domain/user.ts", "src/infra/db.ts"];
    const graph = makeGraph(files, [edge("src/infra/db.ts", "src/domain/user.ts")]);

    const customLayers = [
      { name: "domain", pattern: "(?:^|/)domain/" },
      { name: "infra", pattern: "(?:^|/)infra/" },
    ];

    const { layerEdges } = detectArchitecturalLayers(graph, customLayers);
    expect(layerEdges).toHaveLength(1);
    expect(layerEdges[0]).toEqual({ from: "infra", to: "domain" });
  });

  it("custom patterns with empty array behave like no custom layers", () => {
    const files = ["src/hooks/useAuth.ts", "src/types/model.ts"];
    const graph = makeGraph(files, [edge("src/hooks/useAuth.ts", "src/types/model.ts")]);

    const { layers } = detectArchitecturalLayers(graph, []);
    const names = layers.map((l) => l.name);
    expect(names).toContain("hooks");
    expect(names).toContain("types");
  });
});

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

    const graph = makeGraph(["a.ts", "b.ts", "c.ts"], [edge("a.ts", "c.ts"), edge("b.ts", "c.ts")]);

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
        "src/types/a.ts",
        "src/types/b.ts",
        "src/services/a.ts",
        "src/hooks/a.ts",
        "src/components/a.ts",
        "src/utils.ts",
        "src/shared.ts",
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
      from: "a.ts",
      to: "react",
      isExternal: true,
      specifier: "react",
      importedNames: ["useState"],
    };

    const graph = makeGraph(["a.ts", "b.ts", "c.ts"], [edge("a.ts", "d.ts"), edge("b.ts", "d.ts"), externalEdge]);

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

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

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

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

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
    const layers = makeLayers([{ name: "types", files: ["a.ts"] }]);

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

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

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

// ── §2.53 Directed Reachability Chokepoints ────────────────────────────

describe("findChokepoints", () => {
  it("finds chokepoints in a directed chain", () => {
    // a→b→c→d→e (5 nodes, threshold=ceil(sqrt(5))=3)
    // d: upstream=3 (a,b,c), qualifies
    // c: upstream=2, below threshold
    // b: upstream=1, below threshold
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")],
    );

    const result = findChokepoints(graph);
    expect(result).toHaveLength(1);

    // d: upstream=3 (a,b,c reach it), downstream=1 (e)
    expect(result[0].file).toBe("d");
    expect(result[0].upstreamCount).toBe(3);
    expect(result[0].downstreamCount).toBe(1);
  });

  it("finds fan-in chokepoint", () => {
    // a→c, b→c, c→d (4 nodes, threshold=ceil(sqrt(4))=2)
    // c has upstream=2, downstream=1. Qualifies.
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "c"), edge("b", "c"), edge("c", "d")]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("c");
    expect(result[0].upstreamCount).toBe(2);
    expect(result[0].downstreamCount).toBe(1);
  });

  it("excludes pure sinks (no downstream)", () => {
    // a→b, c→b: b has upstream=2 but downstream=0. Not bridging anything.
    const graph = makeGraph(["a", "b", "c"], [edge("a", "b"), edge("c", "b")]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("handles cycle nodes", () => {
    // a→b→c→a, d→a: cycle members have high reachability via the cycle
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "a"), edge("d", "a")]);

    // a: upstream=3 (b,c,d reach it via cycle/direct), downstream=2 (b,c)
    // b: upstream=3 (a,c,d reach it via cycle), downstream=2 (c,a)
    // c: upstream=3 (a,b,d reach it via cycle), downstream=2 (a,b)
    const result = findChokepoints(graph);
    expect(result.length).toBe(3);
    for (const cp of result) {
      expect(cp.upstreamCount).toBe(3);
      expect(cp.downstreamCount).toBe(2);
    }
  });

  it("returns empty for empty graph", () => {
    const graph = makeGraph([], []);
    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("returns empty for a single edge", () => {
    // a→b: b has upstream=1 (only a), below threshold
    const graph = makeGraph(["a", "b"], [edge("a", "b")]);
    const result = findChokepoints(graph);
    expect(result).toHaveLength(0);
  });

  it("sorts by upstream * downstream product (Henry-Kafura scoring)", () => {
    // a→b→c→d→e, f→d, g→c (7 nodes, threshold=ceil(sqrt(7))=3)
    // d: upstream=5, downstream=1, product=5
    // c: upstream=3, downstream=2, product=6
    // c ranks first because 3*2=6 > 5*1=5 (better bridging score)
    const graph = makeGraph(
      ["a", "b", "c", "d", "e", "f", "g"],
      [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e"), edge("f", "d"), edge("g", "c")],
    );

    const result = findChokepoints(graph);
    expect(result.length).toBe(2);
    expect(result[0].file).toBe("c");
    expect(result[0].upstreamCount).toBe(3);
    expect(result[0].downstreamCount).toBe(2);
    expect(result[1].file).toBe("d");
    expect(result[1].upstreamCount).toBe(5);
    expect(result[1].downstreamCount).toBe(1);
  });

  it("includes importedBy count", () => {
    // a→b, c→b, b→d: b has importedBy=2
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("c", "b"), edge("b", "d")]);

    const result = findChokepoints(graph);
    const bPoint = result.find((r) => r.file === "b");
    expect(bPoint).toBeDefined();
    expect(bPoint?.importedBy).toBe(2);
    expect(bPoint?.upstreamCount).toBe(2);
    expect(bPoint?.downstreamCount).toBe(1);
  });

  it("ignores external edges", () => {
    const externalEdge: ImportEdge = {
      from: "a",
      to: "react",
      isExternal: true,
      specifier: "react",
      importedNames: ["useState"],
    };

    // a→b, c→b, b→d + external a→react
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("c", "b"), edge("b", "d"), externalEdge]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(1);
    expect(result[0].file).toBe("b");
  });

  it("backward compat: separates equals upstreamCount", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "c"), edge("b", "c"), edge("c", "d")]);

    const result = findChokepoints(graph);
    expect(result).toHaveLength(1);
    expect(result[0].upstreamCount).toBeGreaterThan(0);
  });

  it("two-phase BFS: low-upstream files are filtered without changing results", () => {
    // A star graph where leaves have low upstream - they must be filtered before exact BFS
    // Center c has upstream=4, threshold=ceil(sqrt(5))=3, so c qualifies
    // Leaves a, b, d, e have upstream=0, below threshold
    const graph = makeGraph(
      ["a", "b", "c", "d", "e"],
      [edge("a", "c"), edge("b", "c"), edge("c", "d"), edge("c", "e")],
    );

    const result = findChokepoints(graph);
    // Only c qualifies: upstream=2 (a,b), threshold=ceil(sqrt(5))=3, so c does NOT qualify
    // Wait: sqrt(5)=2.23, ceil=3. c upstream=2 < 3. This is zero results.
    // Let's verify the exact behavior via the threshold formula.
    // threshold = max(2, ceil(sqrt(5))) = 3. c upstream=2. c does NOT qualify.
    expect(result).toHaveLength(0);
  });

  it("two-phase BFS does not inflate upstream counts vs single-pass", () => {
    // 9-node chain: a->b->c->d->e->f->g->h->i
    // threshold=ceil(sqrt(9))=3
    // f upstream=5(a,b,c,d,e) >= 3 - qualifies
    // g upstream=6(a,b,c,d,e,f) >= 3 - qualifies
    // h upstream=7(a,b,c,d,e,f,g) >= 3 - qualifies
    const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    const result = findChokepoints(graph);
    // All qualifying nodes must have exact upstream counts (not inflated by BFS)
    for (const cp of result) {
      const idx = files.indexOf(cp.file);
      // upstream = number of nodes that can reach this file = idx (all predecessors)
      expect(cp.upstreamCount).toBe(idx);
      // downstream = number of nodes reachable from this file = files.length - idx - 1
      expect(cp.downstreamCount).toBe(files.length - idx - 1);
    }
  });
});

// ── Weighted layer violations ─────────────────────────────────────────

describe("computeLayerConsistency weighted violations", () => {
  it("3-layer-skip violation produces lower consistency than 1-layer-skip violation", () => {
    // Setup: 4 layers types(0) -> utils(1) -> services(2) -> components(3)
    const layers4 = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);

    const layerEdges4: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    // Case A: one 1-layer-skip violation (types -> utils, skip=1) + one correct edge
    const graphSmallSkip = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/services.ts"), // correct, distance=1
        edge("src/types.ts", "src/utils.ts"), // violation, distance=1
      ],
    );

    // Case B: one 3-layer-skip violation (types -> components, skip=3) + one correct edge
    const graphLargeSkip = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/services.ts"), // correct, distance=1
        edge("src/types.ts", "src/components.ts"), // violation, distance=3
      ],
    );

    const resultSmall = computeLayerConsistency(graphSmallSkip, layers4, layerEdges4);
    const resultLarge = computeLayerConsistency(graphLargeSkip, layers4, layerEdges4);

    // Larger skip = lower consistency score
    expect(resultLarge.consistency).toBeLessThan(resultSmall.consistency);
  });

  it("two violations at equal distance produce same result as unweighted count", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types/a.ts", "src/types/b.ts"] },
      { name: "services", files: ["src/services/a.ts", "src/services/b.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [{ from: "services", to: "types" }];

    // Two violations: each types file imports a services file (distance=1 each)
    const graph = makeGraph(
      ["src/types/a.ts", "src/types/b.ts", "src/services/a.ts", "src/services/b.ts"],
      [
        edge("src/services/a.ts", "src/types/a.ts"), // correct
        edge("src/services/b.ts", "src/types/b.ts"), // correct
        edge("src/types/a.ts", "src/services/a.ts"), // violation distance=1
        edge("src/types/b.ts", "src/services/b.ts"), // violation distance=1
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    // 2 correct (weight=2) vs 2 violations (weight=2): consistency = 2/4 = 0.5
    expect(result.consistency).toBe(0.5);
    expect(result.violations).toHaveLength(2);
  });

  it("correct edge with larger distance contributes more to consistency", () => {
    // 3 layers: A(0) -> B(1) -> C(2)
    const layers = makeLayers([
      { name: "layerA", files: ["src/a.ts"] },
      { name: "layerB", files: ["src/b.ts"] },
      { name: "layerC", files: ["src/c.ts"] },
    ]);

    const layerEdges: LayerEdge[] = [
      { from: "layerB", to: "layerA" },
      { from: "layerC", to: "layerB" },
    ];

    // Only one correct edge: C -> A, skipping B (distance=2)
    // One violation: A -> C (distance=2)
    const graph = makeGraph(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      [
        edge("src/c.ts", "src/a.ts"), // correct, skip=2
        edge("src/a.ts", "src/c.ts"), // violation, skip=2
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    // 1 correct (weight=2) vs 1 violation (weight=2): consistency = 0.5
    expect(result.consistency).toBe(0.5);
  });
});
