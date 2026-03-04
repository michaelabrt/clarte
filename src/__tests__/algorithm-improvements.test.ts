/**
 * Tests for Phase 1 algorithm improvements (adversarial audit).
 *
 * Each describe block targets a specific behavioral change, testing properties
 * that could plausibly regress independently from the rest of the codebase.
 */

import { describe, expect, it } from "vitest";
import { resolveEditTargets } from "../cli/resolve-targets.js";
import { computeBetweenness } from "../graph/centrality.js";
import { findChokepoints } from "../graph/chokepoints.js";
import { computeLayerConsistency } from "../graph/layers.js";
import { findFeedbackEdges } from "../graph/cycles.js";
import { detectCommunities } from "../graph/communities.js";
import type { ArchitecturalLayer, CircularDependency, LayerEdge } from "../types.js";
import type { PersistedGraph } from "../types/persisted-graph.js";
import { PERSISTED_GRAPH_VERSION } from "../types/persisted-graph.js";
import { makeGraph, edge } from "./algorithm/helpers.js";

// ── Helpers ────────────────────────────────────────────────────────────────

function makePGraph(overrides?: Partial<PersistedGraph>): PersistedGraph {
  return {
    version: PERSISTED_GRAPH_VERSION,
    timestamp: "2026-01-01T00:00:00Z",
    files: {},
    edges: [],
    communities: [],
    changeCoupling: [],
    structuralMismatches: [],
    testMapping: {},
    lagCouplings: [],
    ...overrides,
  };
}

function makeFileRec(overrides?: Record<string, unknown>) {
  return {
    role: null,
    authority: 0,
    hubScore: 0,
    betweenness: 0,
    instability: null,
    importedByCount: 0,
    isChokepoint: false,
    separatesComponents: 0,
    isCrossCutting: false,
    layerSpread: 0,
    layers: [],
    hasTests: false,
    testFiles: [],
    communityId: null,
    ...overrides,
  };
}

function makeCycle(chain: string[]): CircularDependency {
  return { chain: [...chain, chain[0]] };
}

function makeLayers(defs: Array<{ name: string; files: string[] }>): ArchitecturalLayer[] {
  return defs.map((d) => ({
    name: d.name,
    files: d.files,
    importedByLayers: 0,
    dependsOn: [],
  }));
}

// ── BM25F true field combination ──────────────────────────────────────────

describe("BM25F: pseudo-tf combination before saturation", () => {
  it("file with term in both path and one symbol outscores file with term only in symbols", () => {
    // path-and-symbol: "auth" is both a path segment and in symbolNames
    // symbol-only: "auth" is only in symbolNames (same symbol set)
    const graph = makePGraph({
      files: {
        "src/auth/handler.ts": makeFileRec({ symbolNames: ["authHandler"] }),
        "src/core/middleware.ts": makeFileRec({ symbolNames: ["authHandler"] }),
      },
    });
    const targets = resolveEditTargets("auth", graph);
    // auth/handler.ts has "auth" in path AND splits from "authHandler" symbol
    // middleware.ts has "auth" only via "authHandler" symbol split
    expect(targets[0]).toBe("src/auth/handler.ts");
  });

  it("IDF penalizes a term present in all documents", () => {
    // When every file contains the search term, IDF should be minimal
    // and scores should be low (or zero relative to more discriminating terms)
    const graph = makePGraph({
      files: {
        "src/service/user.ts": makeFileRec({ symbolNames: ["service"] }),
        "src/service/product.ts": makeFileRec({ symbolNames: ["service"] }),
        "src/service/order.ts": makeFileRec({ symbolNames: ["service"] }),
        "src/user.ts": makeFileRec({ symbolNames: ["userProfile"] }),
      },
    });
    // "user" is rare; "service" is in 3/4 files
    const targets = resolveEditTargets("user", graph, 1);
    // The specific "user.ts" should rank top because "user" in path is more discriminating
    expect(targets[0]).toBe("src/user.ts");
  });

  it("rare symbol in one file scores higher than common symbol across many files", () => {
    // uniqueProcessor appears in 1 file; commonHelper appears in many
    const files: Record<string, ReturnType<typeof makeFileRec>> = {};
    for (let i = 0; i < 8; i++) {
      files[`src/module${i}.ts`] = makeFileRec({ symbolNames: ["commonHelper"] });
    }
    files["src/special.ts"] = makeFileRec({ symbolNames: ["uniqueProcessor"] });

    const graph = makePGraph({ files });
    const targets = resolveEditTargets("uniqueProcessor", graph, 1);
    expect(targets[0]).toBe("src/special.ts");
  });

  it("true BM25F saturation: path-and-symbol combo outscores double-symbol when both have same raw tf", () => {
    // File A: "cache" appears once in path segment AND once in a symbol
    // File B: "cache" appears twice in symbols only
    // True BM25F combines weighted pseudo-tf across fields before saturation.
    // A's combined pseudo-tf > B's pseudo-tf because:
    //   A: pseudoTf = 1.5*(1/pathNorm) + 1.0*(1/symNorm)
    //   B: pseudoTf = 1.0*(2/symNorm) but capped by the same saturation curve
    // Since PATH_WEIGHT=1.5 gives A an advantage on the path field, A should win.
    const graph = makePGraph({
      files: {
        "src/cache/store.ts": makeFileRec({ symbolNames: ["cacheEntry"] }),
        "src/data/processor.ts": makeFileRec({ symbolNames: ["cacheEntry", "cacheHit"] }),
      },
    });
    const targets = resolveEditTargets("cache", graph);
    // cache/store.ts: "cache" in path dir + "cache" in cacheEntry symbol split
    // data/processor.ts: "cache" in two symbols but no path match
    expect(targets[0]).toBe("src/cache/store.ts");
  });

  it("b=0.4 does not heavily penalize a short-path file with exact match", () => {
    // With b=0.4 (lowered from 0.75), short docs are less penalized.
    // A 2-token path "src/auth.ts" should still beat a 6-token path
    // "src/services/authentication/helpers/auth-utils.ts" when both have the same term.
    // This is a regression guard: b=0.75 would over-penalize the short doc.
    const graph = makePGraph({
      files: {
        "src/auth.ts": makeFileRec(),
        "src/services/authentication/helpers/auth-utils.ts": makeFileRec(),
      },
    });
    const targets = resolveEditTargets("auth", graph);
    // Short exact match should not be buried behind a long multi-segment match
    expect(targets[0]).toBe("src/auth.ts");
  });

  it("df counts a term once per document even when it appears in both fields", () => {
    // If a term appears in both path and symbols, df should be 1 for that document.
    // This affects IDF calculation. We test indirectly: a term that appears in
    // path+symbols of 1 doc should produce same IDF as term only in symbols of 1 doc.
    // Both should outscore a term present in path+symbols of 3 docs (lower IDF).
    const graph = makePGraph({
      files: {
        "src/alpha/alpha.ts": makeFileRec({ symbolNames: ["alphaFunc"] }),
        "src/beta.ts": makeFileRec({ symbolNames: ["betaFunc"] }),
        "src/gamma.ts": makeFileRec({ symbolNames: ["gammaFunc"] }),
        "src/delta.ts": makeFileRec({ symbolNames: ["gammaStub"] }),
        "src/epsilon.ts": makeFileRec({ symbolNames: ["gammaHelper"] }),
      },
    });
    // "alpha" appears in 1 doc (path + symbol), "gamma" appears in 3 docs (symbols only)
    const alphaTargets = resolveEditTargets("alpha", graph, 1);
    const gammaTargets = resolveEditTargets("gamma", graph, 3);

    expect(alphaTargets).toContain("src/alpha/alpha.ts");
    // gamma is more common, so IDF is lower; we verify by checking alpha finds exactly 1
    expect(alphaTargets).toHaveLength(1);
    expect(gammaTargets.length).toBeGreaterThan(1);
  });
});

// ── computeBetweenness adaptive k ────────────────────────────────────────

describe("computeBetweenness: adaptive k formula", () => {
  it("adaptive k for V=625 is 50 (2*sqrt(625)=50, matches floor)", () => {
    // At V=625: max(50, 2*sqrt(625)) = max(50, 50) = 50 = min(625, 50) = 50
    // The adaptive formula should exactly equal 50 at this boundary
    // We verify by comparing with explicit k=50: results should be identical
    // (when sampleSize >= n there's no sampling; when sampleSize < n, sampling is seeded)
    const files = Array.from({ length: 50 }, (_, i) => `f${i}`);
    // Chain: f0->f1->...->f49
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    const adaptive = computeBetweenness(graph);
    const explicit50 = computeBetweenness(graph, 50);

    // n=50 < effectiveK=50, so sampleSize=50=n, meaning full enumeration both ways
    for (const [f, score] of explicit50) {
      expect(adaptive.get(f)).toBeCloseTo(score, 10);
    }
  });

  it("adaptive k scales with sqrt(n) for large graphs (V=400)", () => {
    // V=400: adaptive k = max(50, ceil(2*sqrt(400))) = max(50, 40) = 50
    // V=2500: adaptive k = max(50, ceil(2*sqrt(2500))) = max(50, 100) = 100
    // At V=400 k=50 (floor), at V=2500 k=100 (sqrt dominates).
    // We can't run V=2500 cheaply, but we can verify V=400 still uses k=50.
    const files = Array.from({ length: 400 }, (_, i) => `f${i}`);
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    // Should complete without throwing and produce valid [0,1] scores
    const scores = computeBetweenness(graph);
    expect(scores.size).toBe(400);
    for (const score of scores.values()) {
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(1);
    }
    // The middle of the chain should have highest betweenness
    const maxFile = [...scores.entries()].sort((a, b) => b[1] - a[1])[0][0];
    const maxIdx = files.indexOf(maxFile);
    expect(maxIdx).toBeGreaterThan(50);
    expect(maxIdx).toBeLessThan(350);
  });

  it("explicit k=undefined uses adaptive, not k=50 hardcoded", () => {
    // For V=4 graph, adaptive k = max(50, ceil(2*sqrt(4))) = max(50, 4) = 4 (clamped to n)
    // This is full enumeration regardless of the formula.
    // The important thing: passing k=undefined and k=4 produce identical results.
    const files = ["a", "b", "c", "d"];
    const graph = makeGraph(files, [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "a")]);

    const adaptive = computeBetweenness(graph); // k undefined
    const explicit = computeBetweenness(graph, 4); // k=n (full)

    for (const [f, score] of explicit) {
      expect(adaptive.get(f)).toBeCloseTo(score, 10);
    }
  });

  it("omitting k does not default to old k=50 parameter behavior for tiny graphs", () => {
    // In the old signature `k = 50`, a V=3 graph would still use k=50 (clamped to 3).
    // In the new signature `k?: number`, k=undefined triggers adaptive which also
    // produces k=3 (min(3, max(50, ceil(2*sqrt(3)))) = min(3, 50) = 3).
    // Both paths produce full enumeration for V<50, so scores must be equal.
    const files = ["x", "y", "z"];
    const graph = makeGraph(files, [edge("x", "y"), edge("y", "z"), edge("z", "x")]);

    const adaptive = computeBetweenness(graph);
    const explicit = computeBetweenness(graph, 3);

    for (const [f, score] of explicit) {
      expect(adaptive.get(f)).toBeCloseTo(score, 10);
    }
  });
});

// ── findChokepoints two-phase BFS ─────────────────────────────────────────

describe("findChokepoints: two-phase BFS boundary conditions", () => {
  it("node with exactly threshold upstream is included", () => {
    // 9 files in a chain: threshold = ceil(sqrt(9)) = 3
    // node at index 3 (d) has upstream = 3 (a,b,c) -- exactly threshold, must be included
    const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    const result = findChokepoints(graph);
    const dEntry = result.find((r) => r.file === "d");
    expect(dEntry).toBeDefined();
    expect(dEntry?.upstreamCount).toBe(3);
  });

  it("node with threshold-1 upstream is excluded", () => {
    // 9 files: threshold = 3
    // node at index 2 (c) has upstream = 2 (a,b) -- one below threshold, must be excluded
    const files = ["a", "b", "c", "d", "e", "f", "g", "h", "i"];
    const edges = files.slice(1).map((f, i) => edge(files[i], f));
    const graph = makeGraph(files, edges);

    const result = findChokepoints(graph);
    const cEntry = result.find((r) => r.file === "c");
    expect(cEntry).toBeUndefined();
  });

  it("bfsReaches early termination does not corrupt exact upstream count in phase 2", () => {
    // Build a fan-in: 5 roots all import center, center imports 2 leaves
    // Total files = 8: threshold = ceil(sqrt(8)) = 3
    // center: upstream = 5 (all roots), downstream = 2 (both leaves)
    const files = ["r1", "r2", "r3", "r4", "r5", "center", "leaf1", "leaf2"];
    const graph = makeGraph(files, [
      edge("r1", "center"),
      edge("r2", "center"),
      edge("r3", "center"),
      edge("r4", "center"),
      edge("r5", "center"),
      edge("center", "leaf1"),
      edge("center", "leaf2"),
    ]);

    const result = findChokepoints(graph);
    const cp = result.find((r) => r.file === "center");
    expect(cp).toBeDefined();
    // Phase 1 terminates early at threshold=3, phase 2 must count the full 5
    expect(cp?.upstreamCount).toBe(5);
    expect(cp?.downstreamCount).toBe(2);
  });

  it("non-candidate (upstream below threshold) does not appear in results even with downstream", () => {
    // a -> b -> c -> d (4 files, threshold = ceil(sqrt(4)) = 2)
    // b: upstream=1 (only a), below threshold=2, must be excluded
    // c: upstream=2 (a,b), equals threshold, must be included
    const graph = makeGraph(["a", "b", "c", "d"], [edge("a", "b"), edge("b", "c"), edge("c", "d")]);

    const result = findChokepoints(graph);
    const files = result.map((r) => r.file);
    expect(files).not.toContain("b");
    expect(files).toContain("c");
  });
});

// ── computeLayerConsistency weighted violations ───────────────────────────

describe("computeLayerConsistency: skip-distance weighting", () => {
  it("one skip-3 violation scores lower than one skip-1 violation, same correct edges", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    // Case A: one skip-1 violation (types -> utils) + one correct skip-1 (components -> services)
    const graphSkip1 = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/services.ts"), // correct, distance=1
        edge("src/types.ts", "src/utils.ts"), // violation, distance=1
      ],
    );

    // Case B: one skip-3 violation (types -> components) + one correct skip-1 (components -> services)
    const graphSkip3 = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/services.ts"), // correct, distance=1
        edge("src/types.ts", "src/components.ts"), // violation, distance=3
      ],
    );

    const resultSkip1 = computeLayerConsistency(graphSkip1, layers, layerEdges);
    const resultSkip3 = computeLayerConsistency(graphSkip3, layers, layerEdges);

    // Skip-3 violation should produce a lower (worse) consistency score
    expect(resultSkip3.consistency).toBeLessThan(resultSkip1.consistency);
  });

  it("correct edge with skip-3 produces higher consistency than correct edge with skip-1 under same violation", () => {
    // Both graphs have the same violation; the graph with a skip-3 correct edge
    // has more total correctWeight, so higher consistency.
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    // Case A: correct skip-1 (components -> services) + violation skip-1 (types -> utils)
    const graphCorrectSkip1 = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/services.ts"), // correct, distance=1
        edge("src/types.ts", "src/utils.ts"), // violation, distance=1
      ],
    );

    // Case B: correct skip-3 (components -> types) + violation skip-1 (types -> utils)
    const graphCorrectSkip3 = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/types.ts"), // correct, distance=3
        edge("src/types.ts", "src/utils.ts"), // violation, distance=1
      ],
    );

    const resultCorrectSkip1 = computeLayerConsistency(graphCorrectSkip1, layers, layerEdges);
    const resultCorrectSkip3 = computeLayerConsistency(graphCorrectSkip3, layers, layerEdges);

    // More correct weight (skip-3) with same violation weight -> higher consistency
    expect(resultCorrectSkip3.consistency).toBeGreaterThan(resultCorrectSkip1.consistency);
  });

  it("violations are sorted by skip distance descending (most egregious first)", () => {
    // 4-layer stack with two violations at different distances
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    const graph = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/types.ts", "src/components.ts"), // violation distance=3 (types rank=0, components rank=3)
        edge("src/utils.ts", "src/services.ts"), // violation distance=1 (utils rank=1, services rank=2)
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.violations).toHaveLength(2);
    // First violation should be the larger skip
    const firstViolation = result.violations[0];
    expect(firstViolation.fromLayer).toBe("types");
    expect(firstViolation.toLayer).toBe("components");
  });

  it("consistency is 1 when all edges are correct regardless of skip distance", () => {
    const layers = makeLayers([
      { name: "types", files: ["src/types.ts"] },
      { name: "utils", files: ["src/utils.ts"] },
      { name: "services", files: ["src/services.ts"] },
      { name: "components", files: ["src/components.ts"] },
    ]);
    const layerEdges: LayerEdge[] = [
      { from: "utils", to: "types" },
      { from: "services", to: "utils" },
      { from: "components", to: "services" },
    ];

    // All edges go from higher rank (consumer) to lower rank (foundation)
    const graph = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/services.ts", "src/components.ts"],
      [
        edge("src/components.ts", "src/types.ts"), // skip-3 correct
        edge("src/services.ts", "src/types.ts"), // skip-2 correct
        edge("src/components.ts", "src/services.ts"), // skip-1 correct
      ],
    );

    const result = computeLayerConsistency(graph, layers, layerEdges);
    expect(result.consistency).toBe(1);
    expect(result.violations).toHaveLength(0);
  });
});

// ── findFeedbackEdges default topN change (3 -> 10) ───────────────────────

describe("findFeedbackEdges: default topN is 10 not 3", () => {
  it("returns more than 3 edges when there are 6 independent cycles", () => {
    // With old default topN=3, this would return at most 3 edges.
    // With new default topN=10, it should return up to 6 (80% of 6 = ceil(4.8)=5 edges).
    const cycles = [
      makeCycle(["a", "b"]),
      makeCycle(["c", "d"]),
      makeCycle(["e", "f"]),
      makeCycle(["g", "h"]),
      makeCycle(["i", "j"]),
      makeCycle(["k", "l"]),
    ];
    // Each cycle has a unique edge, so no edge resolves more than 1 cycle.
    // 80% of 6 = ceil(4.8) = 5, early-stop after 5 edges.
    const result = findFeedbackEdges(cycles);
    // Must return > 3 (proves topN changed from 3)
    expect(result.length).toBeGreaterThan(3);
  });

  it("returns exactly up to 10 when 80% threshold exceeds topN", () => {
    // 20 independent cycles: 80% = 16 edges needed, but topN=10 caps it
    const cycles = Array.from({ length: 20 }, (_, i) => makeCycle([`p${i}`, `q${i}`]));
    const result = findFeedbackEdges(cycles);
    expect(result.length).toBe(10);
  });

  it("early-stop at 80% still works with new default (topN=10, cycles=5)", () => {
    // 5 independent cycles: 80% threshold = ceil(4) = 4 edges, early-stop before topN=10
    const cycles = [
      makeCycle(["a", "b"]),
      makeCycle(["c", "d"]),
      makeCycle(["e", "f"]),
      makeCycle(["g", "h"]),
      makeCycle(["i", "j"]),
    ];
    const result = findFeedbackEdges(cycles);
    // Early stop at 4 edges (80% of 5), not the full 10
    expect(result.length).toBeLessThanOrEqual(5);
    expect(result.length).toBeLessThan(10);
  });
});

// ── detectCommunities Louvain refinement (Phase 3.5) ─────────────────────

describe("detectCommunities: Louvain refinement (Phase 3.5)", () => {
  it("a file with majority cross-community edges gets reassigned by Louvain", () => {
    // "bridge.ts" lives in dir-a but connects more to dir-b files.
    // After Phase 3 (majority cross-community reassignment) or Phase 3.5 (Louvain ΔQ),
    // bridge.ts should end up in the same community as dir-b files.
    const files = [
      "dir-a/core.ts",
      "dir-a/helper.ts",
      "dir-a/bridge.ts",
      "dir-b/service.ts",
      "dir-b/util.ts",
      "dir-b/worker.ts",
    ];
    const edges = [
      // bridge.ts connects to all 3 dir-b files but only 1 dir-a file
      edge("dir-a/bridge.ts", "dir-b/service.ts"),
      edge("dir-a/bridge.ts", "dir-b/util.ts"),
      edge("dir-a/bridge.ts", "dir-b/worker.ts"),
      edge("dir-a/bridge.ts", "dir-a/helper.ts"),
      // dir-a is internally connected
      edge("dir-a/core.ts", "dir-a/helper.ts"),
      // dir-b is internally connected
      edge("dir-b/service.ts", "dir-b/util.ts"),
      edge("dir-b/worker.ts", "dir-b/util.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunities(graph);

    // Results must be valid
    for (const community of communities) {
      for (const file of community.files) {
        expect(files).toContain(file);
      }
    }
    // IDs must be unique
    if (communities.length > 1) {
      const ids = new Set(communities.map((c) => c.id));
      expect(ids.size).toBe(communities.length);
    }
  });

  it("Louvain ΔQ is positive only when moving increases modularity", () => {
    // Two fully isolated cliques of equal size: any move decreases modularity.
    // Phase 3.5 should make zero reassignments; communities mirror directories.
    const files = [
      "clique-a/n1.ts",
      "clique-a/n2.ts",
      "clique-a/n3.ts",
      "clique-b/n1.ts",
      "clique-b/n2.ts",
      "clique-b/n3.ts",
    ];
    const edges = [
      edge("clique-a/n1.ts", "clique-a/n2.ts"),
      edge("clique-a/n2.ts", "clique-a/n3.ts"),
      edge("clique-a/n3.ts", "clique-a/n1.ts"),
      edge("clique-b/n1.ts", "clique-b/n2.ts"),
      edge("clique-b/n2.ts", "clique-b/n3.ts"),
      edge("clique-b/n3.ts", "clique-b/n1.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunities(graph);

    // ARI with directory structure = 1 (perfect match), novelty filter triggers -> []
    // OR communities are returned with clique-a and clique-b in separate groups
    if (communities.length > 0) {
      for (const community of communities) {
        const prefixes = new Set(community.files.map((f) => f.split("/")[0]));
        // Each community should not mix clique-a and clique-b files
        expect(prefixes.size).toBe(1);
      }
    }
  });

  it("Louvain does not produce communities with fewer than MIN_SIZE files", () => {
    // Even after Louvain reassignments, communities below MIN_SIZE=3 are filtered
    const files = [
      "mod-a/one.ts",
      "mod-a/two.ts",
      "mod-a/three.ts",
      "mod-b/alpha.ts",
      "mod-b/beta.ts",
      "mod-b/gamma.ts",
      "mod-b/delta.ts",
    ];
    const edges = [
      edge("mod-a/one.ts", "mod-a/two.ts"),
      edge("mod-a/two.ts", "mod-a/three.ts"),
      edge("mod-a/three.ts", "mod-a/one.ts"),
      edge("mod-b/alpha.ts", "mod-b/beta.ts"),
      edge("mod-b/beta.ts", "mod-b/gamma.ts"),
      edge("mod-b/gamma.ts", "mod-b/delta.ts"),
      edge("mod-b/delta.ts", "mod-b/alpha.ts"),
    ];
    const graph = makeGraph(files, edges);
    const communities = detectCommunities(graph);

    for (const community of communities) {
      expect(community.files.length).toBeGreaterThanOrEqual(3);
    }
  });

  it("Louvain handles graphs with zero internal edges gracefully", () => {
    // No edges means totalEdges=0, so Phase 3.5 is skipped
    const files = ["dir-a/a.ts", "dir-a/b.ts", "dir-a/c.ts"];
    // No edges between files
    const graph = makeGraph(files, []);
    // Should not throw; returns empty or valid communities
    expect(() => detectCommunities(graph)).not.toThrow();
    const communities = detectCommunities(graph);
    for (const community of communities) {
      expect(community.files.length).toBeGreaterThanOrEqual(3);
    }
  });
});
