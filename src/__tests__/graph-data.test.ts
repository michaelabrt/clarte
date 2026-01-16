import { describe, it, expect } from "vitest";
import { normalizePath, buildReverseAdjacency, findTransitiveTests, getFileGraphData } from "../graph/data.js";
import type { PersistedGraph, FileRecord, EdgeRecord } from "../graph/types.js";

// ── Factories ────────────────────────────────────────────────────────

function makeGraph(overrides: Partial<PersistedGraph> = {}): PersistedGraph {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
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

function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    role: "Leaf",
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

function makeEdge(from: string, to: string): EdgeRecord {
  return { from, to, importedNames: [] };
}

// ── normalizePath ────────────────────────────────────────────────────

describe("normalizePath", () => {
  it("strips leading ./", () => {
    expect(normalizePath("./src/utils.ts")).toBe("src/utils.ts");
  });

  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("src\\utils\\helpers.ts")).toBe("src/utils/helpers.ts");
  });

  it("strips ./ before converting backslashes (order matters)", () => {
    // normalizePath strips ^./ first, then converts backslashes
    // So ".\\src" has no leading "./" to strip, only backslash conversion
    expect(normalizePath(".\\src\\utils.ts")).toBe("./src/utils.ts");
    // But "./src\\utils.ts" strips ./ then converts backslashes
    expect(normalizePath("./src\\utils.ts")).toBe("src/utils.ts");
  });

  it("returns unchanged path when no normalization needed", () => {
    expect(normalizePath("src/utils.ts")).toBe("src/utils.ts");
  });

  it("handles empty string", () => {
    expect(normalizePath("")).toBe("");
  });

  it("does not strip nested ./", () => {
    expect(normalizePath("src/./utils.ts")).toBe("src/./utils.ts");
  });
});

// ── buildReverseAdjacency ────────────────────────────────────────────

describe("buildReverseAdjacency", () => {
  it("returns empty map for graph with no edges", () => {
    const rev = buildReverseAdjacency(makeGraph());
    expect(rev.size).toBe(0);
  });

  it("inverts edges correctly", () => {
    const graph = makeGraph({
      edges: [makeEdge("a.ts", "b.ts"), makeEdge("c.ts", "b.ts")],
    });
    const rev = buildReverseAdjacency(graph);
    expect(rev.get("b.ts")).toEqual(["a.ts", "c.ts"]);
  });

  it("handles multiple targets from same source", () => {
    const graph = makeGraph({
      edges: [makeEdge("a.ts", "b.ts"), makeEdge("a.ts", "c.ts")],
    });
    const rev = buildReverseAdjacency(graph);
    expect(rev.get("b.ts")).toEqual(["a.ts"]);
    expect(rev.get("c.ts")).toEqual(["a.ts"]);
  });

  it("includes duplicate edges", () => {
    const graph = makeGraph({
      edges: [makeEdge("a.ts", "b.ts"), makeEdge("a.ts", "b.ts")],
    });
    const rev = buildReverseAdjacency(graph);
    expect(rev.get("b.ts")).toEqual(["a.ts", "a.ts"]);
  });
});

// ── findTransitiveTests ──────────────────────────────────────────────

describe("findTransitiveTests", () => {
  it("returns empty for target with no importers", () => {
    const rev = new Map<string, string[]>();
    expect(findTransitiveTests(rev, "target.ts", new Set())).toEqual([]);
  });

  it("finds a test file one hop away", () => {
    const rev = new Map([["target.ts", ["src/__tests__/target.test.ts"]]]);
    const result = findTransitiveTests(rev, "target.ts", new Set());
    expect(result).toEqual(["src/__tests__/target.test.ts"]);
  });

  it("excludes direct tests", () => {
    const rev = new Map([["target.ts", ["src/__tests__/target.test.ts"]]]);
    const directTests = new Set(["src/__tests__/target.test.ts"]);
    const result = findTransitiveTests(rev, "target.ts", directTests);
    expect(result).toEqual([]);
  });

  it("finds transitive test files through intermediate modules", () => {
    const rev = new Map([
      ["target.ts", ["intermediate.ts"]],
      ["intermediate.ts", ["src/__tests__/integration.test.ts"]],
    ]);
    const result = findTransitiveTests(rev, "target.ts", new Set());
    expect(result).toEqual(["src/__tests__/integration.test.ts"]);
  });

  it("handles cycles without infinite loop", () => {
    const rev = new Map([
      ["a.ts", ["b.ts"]],
      ["b.ts", ["a.ts"]],
    ]);
    const result = findTransitiveTests(rev, "a.ts", new Set());
    expect(result).toEqual([]);
  });

  it("respects MAX_INTEGRATION_TESTS limit (5)", () => {
    const importers = Array.from({ length: 10 }, (_, i) => `src/__tests__/test${i}.test.ts`);
    const rev = new Map([["target.ts", importers]]);
    const result = findTransitiveTests(rev, "target.ts", new Set());
    expect(result).toHaveLength(5);
  });

  it("skips non-test files and continues BFS", () => {
    const rev = new Map([
      ["target.ts", ["not-test.ts"]],
      ["not-test.ts", ["src/__tests__/found.test.ts"]],
    ]);
    const result = findTransitiveTests(rev, "target.ts", new Set());
    expect(result).toEqual(["src/__tests__/found.test.ts"]);
  });
});

// ── getFileGraphData ─────────────────────────────────────────────────

describe("getFileGraphData", () => {
  it("returns null for unknown file", () => {
    const graph = makeGraph();
    const rev = buildReverseAdjacency(graph);
    expect(getFileGraphData(graph, "unknown.ts", rev)).toBeNull();
  });

  it("returns correct data for known file", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": makeFile({
          role: "Foundation",
          betweenness: 0.5,
          isChokepoint: true,
          separatesComponents: 3,
        }),
      },
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/utils.ts", rev);
    expect(data).not.toBeNull();
    expect(data!.role).toBe("Foundation");
    expect(data!.betweenness).toBe(0.5);
    expect(data!.isChokepoint).toBe(true);
    expect(data!.separatesComponents).toBe(3);
  });

  it("defaults role to Leaf when null", () => {
    const graph = makeGraph({
      files: {
        "src/leaf.ts": makeFile({ role: null }),
      },
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/leaf.ts", rev);
    expect(data!.role).toBe("Leaf");
  });

  it("includes co-change data sorted by confidence", () => {
    const graph = makeGraph({
      files: { "src/a.ts": makeFile() },
      changeCoupling: [
        { fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.3, coChangeCount: 5 },
        { fileA: "src/c.ts", fileB: "src/a.ts", confidence: 0.8, coChangeCount: 10 },
        { fileA: "src/a.ts", fileB: "src/d.ts", confidence: 0.5, coChangeCount: 7 },
      ],
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/a.ts", rev);
    expect(data!.coChange).toHaveLength(3);
    expect(data!.coChange[0].file).toBe("src/c.ts");
    expect(data!.coChange[0].confidence).toBe(0.8);
    expect(data!.coChange[1].confidence).toBe(0.5);
    expect(data!.coChange[2].confidence).toBe(0.3);
  });

  it("limits co-change to top 3", () => {
    const coupling = Array.from({ length: 5 }, (_, i) => ({
      fileA: "src/a.ts",
      fileB: `src/other${i}.ts`,
      confidence: (i + 1) * 0.1,
      coChangeCount: i + 1,
    }));
    const graph = makeGraph({
      files: { "src/a.ts": makeFile() },
      changeCoupling: coupling,
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/a.ts", rev);
    expect(data!.coChange).toHaveLength(3);
    // Top 3 by confidence: 0.5, 0.4, 0.3
    expect(data!.coChange[0].confidence).toBe(0.5);
  });

  it("includes integration tests from transitive BFS", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": makeFile({ testFiles: ["src/__tests__/utils.test.ts"] }),
      },
      edges: [
        makeEdge("src/consumer.ts", "src/utils.ts"),
        makeEdge("src/__tests__/integration.test.ts", "src/consumer.ts"),
      ],
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/utils.ts", rev);
    expect(data!.integrationTests).toContain("src/__tests__/integration.test.ts");
  });

  it("returns empty coChange when no coupling data", () => {
    const graph = makeGraph({
      files: { "src/a.ts": makeFile() },
    });
    const rev = buildReverseAdjacency(graph);
    const data = getFileGraphData(graph, "src/a.ts", rev);
    expect(data!.coChange).toEqual([]);
  });
});
