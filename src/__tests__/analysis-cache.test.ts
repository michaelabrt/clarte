import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, afterEach } from "vitest";
import { makeImportGraph } from "./helpers/factories";
import {
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  ANALYSIS_CACHE_VERSION,
  type AnalysisCacheData,
} from "../core/graph/analysis-cache";

const TMP = path.join(path.dirname(fileURLToPath(import.meta.url)), ".tmp-analysis-cache-test");

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

// ── Minimal valid cache data ───────────────────────────────────────────

function makeCacheData(overrides?: Partial<AnalysisCacheData>): AnalysisCacheData {
  return {
    version: ANALYSIS_CACHE_VERSION,
    cacheKey: "test-key",
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    instabilities: [],
    communities: [],
    deadFiles: [],
    crossCuttingFiles: [],
    chokepoints: [],
    tightCouplings: [],
    graphTopology: {
      componentCount: 1,
      componentSizes: [5],
      approximateDiameter: 2,
      reachability: 1,
      isFragmented: false,
    },
    ...overrides,
  };
}

// ── computeAnalysisCacheKey ────────────────────────────────────────────

describe("computeAnalysisCacheKey", () => {
  it("returns the same hash for the same graph (determinism)", () => {
    const graph = makeImportGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
    ]);
    const key1 = computeAnalysisCacheKey(graph);
    const key2 = computeAnalysisCacheKey(graph);
    expect(key1).toBe(key2);
  });

  it("returns different hash when an internal edge is added", () => {
    const graph1 = makeImportGraph([{ from: "a.ts", to: "b.ts" }]);
    const graph2 = makeImportGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
    ]);
    expect(computeAnalysisCacheKey(graph1)).not.toBe(computeAnalysisCacheKey(graph2));
  });

  it("returns different hash when an internal edge is removed", () => {
    const graph1 = makeImportGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
    ]);
    const graph2 = makeImportGraph([{ from: "a.ts", to: "b.ts" }]);
    expect(computeAnalysisCacheKey(graph1)).not.toBe(computeAnalysisCacheKey(graph2));
  });

  it("returns different hash when external edge count changes", () => {
    const graph1 = makeImportGraph([{ from: "a.ts", to: "b.ts" }]);
    const graph2 = makeImportGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "a.ts", to: "react", isExternal: true, specifier: "react", importedNames: [] },
    ]);
    expect(computeAnalysisCacheKey(graph1)).not.toBe(computeAnalysisCacheKey(graph2));
  });

  it("returns different hash when layersConfig changes", () => {
    const graph = makeImportGraph([{ from: "a.ts", to: "b.ts" }]);
    const config1 = [{ name: "types", pattern: "src/types/**" }];
    const config2 = [{ name: "services", pattern: "src/services/**" }];
    expect(computeAnalysisCacheKey(graph, config1)).not.toBe(computeAnalysisCacheKey(graph, config2));
  });

  it("returns different hash when layersConfig is present vs absent", () => {
    const graph = makeImportGraph([{ from: "a.ts", to: "b.ts" }]);
    const withConfig = computeAnalysisCacheKey(graph, [{ name: "types", pattern: "src/types/**" }]);
    const withoutConfig = computeAnalysisCacheKey(graph);
    expect(withConfig).not.toBe(withoutConfig);
  });

  it("returns the same hash regardless of edge insertion order", () => {
    const edges1 = [
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
      { from: "c.ts", to: "d.ts" },
    ];
    const edges2 = [
      { from: "c.ts", to: "d.ts" },
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
    ];
    expect(computeAnalysisCacheKey(makeImportGraph(edges1))).toBe(computeAnalysisCacheKey(makeImportGraph(edges2)));
  });

  it("returns a 64-char hex SHA-256 string", () => {
    const key = computeAnalysisCacheKey(makeImportGraph([]));
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── loadAnalysisCache ─────────────────────────────────────────────────

describe("loadAnalysisCache", () => {
  it("returns null when no database exists", async () => {
    expect(await loadAnalysisCache(TMP)).toBeNull();
  });

  it("returns null for wrong version number", async () => {
    // Save with wrong version via the store directly
    const { openGraphStore } = await import("../storage/loader.js");
    const store = await openGraphStore(TMP);
    try {
      store.setMeta("analysis_cache_key", "some-key");
      store.setMeta("analysis_cache_data", JSON.stringify({ ...makeCacheData(), version: ANALYSIS_CACHE_VERSION - 1 }));
    } finally {
      store.close();
    }
    expect(await loadAnalysisCache(TMP)).toBeNull();
  });

  it("returns parsed data for correct version via save+load", async () => {
    const data = makeCacheData({ cacheKey: "test-abc" });
    await saveAnalysisCache(TMP, data);
    const loaded = await loadAnalysisCache(TMP);
    expect(loaded).not.toBeNull();
    expect(loaded?.cacheKey).toBe("test-abc");
    expect(loaded?.version).toBe(ANALYSIS_CACHE_VERSION);
  });
});

// ── saveAnalysisCache ─────────────────────────────────────────────────

describe("saveAnalysisCache", () => {
  it("creates the .clarte directory if it does not exist", async () => {
    const data = makeCacheData({ cacheKey: "new-key" });
    await saveAnalysisCache(TMP, data);
    const loaded = await loadAnalysisCache(TMP);
    expect(loaded?.cacheKey).toBe("new-key");
  });

  it("round-trips data correctly (save then load)", async () => {
    const data = makeCacheData({
      cacheKey: "round-trip-key",
      deadFiles: ["src/unused.ts", "src/dead.ts"],
    });
    await saveAnalysisCache(TMP, data);
    const loaded = await loadAnalysisCache(TMP);
    expect(loaded).not.toBeNull();
    expect(loaded?.cacheKey).toBe("round-trip-key");
    expect(loaded?.deadFiles).toEqual(["src/unused.ts", "src/dead.ts"]);
    expect(loaded?.version).toBe(ANALYSIS_CACHE_VERSION);
  });
});
