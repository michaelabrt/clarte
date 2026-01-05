import { describe, it, expect } from "vitest";
import { formatInspect, formatImpact, type InspectData, type ImpactData } from "../mcp/formatters.js";
import { handleInspect, handleImpact } from "../mcp/tools.js";
import { buildPersistedGraph } from "../mcp/persist.js";
import { checkStaleness } from "../mcp/persist.js";
import type { PersistedGraph, FileRecord, EdgeRecord } from "../mcp/types.js";
import type { ImportGraph, ContextAnalysis } from "../types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
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

function makeGraph(opts: {
  files: Record<string, Partial<FileRecord>>;
  edges?: EdgeRecord[];
  communities?: PersistedGraph["communities"];
  changeCoupling?: PersistedGraph["changeCoupling"];
  structuralMismatches?: PersistedGraph["structuralMismatches"];
  testMapping?: PersistedGraph["testMapping"];
}): PersistedGraph {
  const files: Record<string, FileRecord> = {};
  for (const [path, overrides] of Object.entries(opts.files)) {
    files[path] = makeFileRecord(overrides);
  }
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    headCommit: "abc123",
    files,
    edges: opts.edges ?? [],
    communities: opts.communities ?? [],
    changeCoupling: opts.changeCoupling ?? [],
    structuralMismatches: opts.structuralMismatches ?? [],
    testMapping: opts.testMapping ?? {},
    lagCouplings: [],
  };
}

// ---------------------------------------------------------------------------
// A. Formatter tests
// ---------------------------------------------------------------------------

describe("formatInspect", () => {
  it("stays within 80-token cap for full data", () => {
    const data: InspectData = {
      role: "Foundation",
      betweenness: 0.72,
      instability: 0.12,
      chokepoint: { separates: 5 },
      integrationTests: ["budget.test.ts", "cache.test.ts"],
      coChange: [
        { file: "src/cache.ts", confidence: 0.7 },
        { file: "src/centrality.ts", confidence: 0.45 },
      ],
      community: { id: 2, label: "graph" },
      crossCutting: { layerSpread: 3, layers: ["services", "types", "utils"] },
    };
    const result = formatInspect(data);
    // Token estimate: ~3.2-3.5 chars/token. 80 tokens * 3.2 = 256 chars is the low bound
    expect(result.length).toBeLessThan(400); // generous but sane
    expect(result).toContain("role: Foundation");
    expect(result).toContain("betweenness: 72%");
  });

  it("always includes role and betweenness", () => {
    const data: InspectData = {
      role: "Orchestrator",
      betweenness: 0.15,
      instability: 0.95,
      integrationTests: ["a.test.ts", "b.test.ts", "c.test.ts", "d.test.ts", "e.test.ts", "f.test.ts"],
      coChange: [
        { file: "x.ts", confidence: 0.5 },
        { file: "y.ts", confidence: 0.4 },
        { file: "z.ts", confidence: 0.3 },
      ],
      community: { id: 1, label: "core" },
      crossCutting: { layerSpread: 4, layers: ["a", "b", "c", "d"] },
    };
    const result = formatInspect(data);
    expect(result).toContain("role: Orchestrator");
    expect(result).toContain("betweenness: 15%");
  });

  it("returns minimal output for a leaf file", () => {
    const data: InspectData = {
      role: "Leaf",
      betweenness: 0,
      instability: 0.5,
      integrationTests: [],
      coChange: [],
    };
    const result = formatInspect(data);
    expect(result).toContain("role: Leaf");
    expect(result).toContain("betweenness: 0%");
    expect(result).not.toContain("chokepoint");
  });
});

describe("formatImpact", () => {
  it("stays within 120-token cap", () => {
    const data: ImpactData = {
      integrationTests: [
        { file: "graph.test.ts", via: "graph-build.ts" },
        { file: "cache.test.ts", via: "cache.ts" },
      ],
      transitiveReach: 23,
      hiddenCoChange: [{ file: "src/config.ts", confidence: 0.35, coChangeCount: 8 }],
      risk: { level: "high", reason: "src/utils.ts: flow bottleneck (betweenness: 34%) + Foundation" },
      communityCrossing: {
        communities: [
          { id: 1, label: "graph" },
          { id: 2, label: "templates" },
        ],
      },
    };
    const result = formatImpact(data);
    expect(result.length).toBeLessThan(600); // generous but sane
    expect(result).toContain("integration-tests:");
    expect(result).toContain("risk: high");
  });

  it("always includes integration-tests and risk", () => {
    const data: ImpactData = {
      integrationTests: [
        { file: "a.test.ts", via: "x.ts" },
        { file: "b.test.ts", via: "y.ts" },
        { file: "c.test.ts", via: "z.ts" },
        { file: "d.test.ts", via: "w.ts" },
        { file: "e.test.ts", via: "v.ts" },
      ],
      transitiveReach: 50,
      hiddenCoChange: [
        { file: "a.ts", confidence: 0.5, coChangeCount: 10 },
        { file: "b.ts", confidence: 0.4, coChangeCount: 8 },
      ],
      risk: { level: "medium", reason: "src/foo.ts: Bridge" },
      communityCrossing: {
        communities: [
          { id: 1, label: "a" },
          { id: 2, label: "b" },
          { id: 3, label: "c" },
        ],
      },
    };
    const result = formatImpact(data);
    expect(result).toContain("integration-tests:");
    expect(result).toContain("risk: medium");
  });
});

// ---------------------------------------------------------------------------
// B. Tool query tests
// ---------------------------------------------------------------------------

describe("handleInspect", () => {
  it("returns correct data for a Foundation file", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": {
          role: "Foundation",
          betweenness: 0.72,
          instability: 0.12,
          importedByCount: 44,
          isChokepoint: true,
          separatesComponents: 5,
          testFiles: ["src/__tests__/utils.test.ts"],
          communityId: 0,
        },
        "src/__tests__/budget.test.ts": { role: "Leaf" },
        "src/a.ts": { role: "Leaf" },
      },
      edges: [
        { from: "src/a.ts", to: "src/utils.ts", importedNames: ["isTestFile"] },
        { from: "src/__tests__/budget.test.ts", to: "src/a.ts", importedNames: ["foo"] },
      ],
      communities: [{ id: 0, files: ["src/utils.ts", "src/a.ts"], label: "core" }],
      changeCoupling: [{ fileA: "src/utils.ts", fileB: "src/cache.ts", confidence: 0.7, coChangeCount: 15 }],
    });

    const result = handleInspect(graph, "src/utils.ts");
    expect(result).toContain("role: Foundation");
    expect(result).toContain("betweenness: 72%");
    expect(result).toContain("chokepoint");
    expect(result).toContain("cochange:");
  });

  it("returns error for unknown files", () => {
    const graph = makeGraph({ files: {} });
    const result = handleInspect(graph, "nonexistent.ts");
    expect(result).toContain("file not found");
  });

  it("normalizes paths (strips ./)", () => {
    const graph = makeGraph({
      files: { "src/utils.ts": { role: "Foundation", betweenness: 0.5 } },
    });
    const result = handleInspect(graph, "./src/utils.ts");
    expect(result).toContain("role: Foundation");
  });

  it("includes integration tests NOT in direct test list", () => {
    // Chain: test.ts -> a.ts -> utils.ts
    // utils.ts has testFiles: [utils.test.ts] (direct)
    // test.ts should be found as integration test
    const graph = makeGraph({
      files: {
        "src/utils.ts": {
          role: "Foundation",
          betweenness: 0.5,
          testFiles: ["src/__tests__/utils.test.ts"],
        },
        "src/a.ts": { role: "Leaf" },
        "src/__tests__/a.test.ts": { role: "Leaf" },
        "src/__tests__/utils.test.ts": { role: "Leaf" },
      },
      edges: [
        { from: "src/a.ts", to: "src/utils.ts", importedNames: ["isTestFile"] },
        { from: "src/__tests__/a.test.ts", to: "src/a.ts", importedNames: ["foo"] },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts", importedNames: ["isTestFile"] },
      ],
    });

    const result = handleInspect(graph, "src/utils.ts");
    // Should find a.test.ts (transitive) but not utils.test.ts (direct)
    expect(result).toContain("a.test.ts");
  });
});

describe("handleImpact", () => {
  it("discovers transitive integration tests", () => {
    // Chain: test.ts -> a.ts -> b.ts -> utils.ts
    const graph = makeGraph({
      files: {
        "src/utils.ts": { role: "Foundation", testFiles: ["src/__tests__/utils.test.ts"] },
        "src/b.ts": { role: "Leaf" },
        "src/a.ts": { role: "Leaf" },
        "src/__tests__/chain.test.ts": { role: "Leaf" },
        "src/__tests__/utils.test.ts": { role: "Leaf" },
      },
      edges: [
        { from: "src/b.ts", to: "src/utils.ts", importedNames: ["isTestFile"] },
        { from: "src/a.ts", to: "src/b.ts", importedNames: ["bar"] },
        { from: "src/__tests__/chain.test.ts", to: "src/a.ts", importedNames: ["baz"] },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts", importedNames: ["isTestFile"] },
      ],
    });

    const result = handleImpact(graph, ["src/utils.ts"]);
    expect(result).toContain("chain.test.ts");
    expect(result).toContain("integration-tests:");
  });

  it("computes transitive reach beyond depth 1", () => {
    // utils.ts <- a.ts <- b.ts <- c.ts
    const graph = makeGraph({
      files: {
        "src/utils.ts": { role: "Foundation" },
        "src/a.ts": { role: "Leaf" },
        "src/b.ts": { role: "Leaf" },
        "src/c.ts": { role: "Leaf" },
      },
      edges: [
        { from: "src/a.ts", to: "src/utils.ts", importedNames: ["fn"] },
        { from: "src/b.ts", to: "src/a.ts", importedNames: ["fn"] },
        { from: "src/c.ts", to: "src/b.ts", importedNames: ["fn"] },
      ],
    });

    const result = handleImpact(graph, ["src/utils.ts"]);
    expect(result).toContain("transitive-reach:");
    // Direct dependent: a.ts (depth 1), transitive: b.ts, c.ts (depth 2+)
    expect(result).toContain("2 files beyond direct dependents");
  });

  it("finds hidden co-change partners", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": { role: "Foundation" },
        "src/config.ts": { role: "Leaf" },
      },
      structuralMismatches: [
        {
          fileA: "src/utils.ts",
          fileB: "src/config.ts",
          graphDistance: -1,
          coChangeConfidence: 0.35,
          coChangeCount: 8,
        },
      ],
    });

    const result = handleImpact(graph, ["src/utils.ts"]);
    expect(result).toContain("hidden-cochange:");
    expect(result).toContain("config.ts");
  });

  it("computes risk score correctly", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": {
          role: "Foundation",
          betweenness: 0.72,
          isChokepoint: true,
          separatesComponents: 5,
        },
      },
    });

    const result = handleImpact(graph, ["src/utils.ts"]);
    expect(result).toContain("risk: high");
    expect(result).toContain("Foundation");
  });

  it("detects community crossing", () => {
    const graph = makeGraph({
      files: {
        "src/utils.ts": { role: "Foundation", communityId: 0 },
        "src/templates/main.ts": { role: "Leaf", communityId: 1 },
      },
      communities: [
        { id: 0, files: ["src/utils.ts"], label: "graph" },
        { id: 1, files: ["src/templates/main.ts"], label: "templates" },
      ],
    });

    const result = handleImpact(graph, ["src/utils.ts", "src/templates/main.ts"]);
    expect(result).toContain("community-crossing:");
    expect(result).toContain("graph");
    expect(result).toContain("templates");
  });

  it("handles single-file changes", () => {
    const graph = makeGraph({
      files: { "src/a.ts": { role: "Leaf" } },
    });

    const result = handleImpact(graph, ["src/a.ts"]);
    expect(result).toContain("risk: low");
  });

  it("returns error for files not in graph", () => {
    const graph = makeGraph({ files: {} });
    const result = handleImpact(graph, ["nonexistent.ts"]);
    expect(result).toContain("no changed files found");
  });
});

// ---------------------------------------------------------------------------
// C. Persistence tests
// ---------------------------------------------------------------------------

describe("buildPersistedGraph", () => {
  function makeImportGraph(): ImportGraph {
    return {
      edges: [
        {
          from: "src/a.ts",
          to: "src/b.ts",
          isExternal: false,
          specifier: "./b",
          importedNames: ["foo", "bar"],
        },
        {
          from: "src/a.ts",
          to: "lodash",
          isExternal: true,
          specifier: "lodash",
          importedNames: ["merge"],
        },
      ],
      inDegree: new Map([
        ["src/a.ts", 0],
        ["src/b.ts", 1],
      ]),
      centrality: new Map([
        ["src/a.ts", 0.5],
        ["src/b.ts", 0.8],
      ]),
      externalImportCounts: new Map([["lodash", 1]]),
      authority: new Map([
        ["src/a.ts", 0.3],
        ["src/b.ts", 0.7],
      ]),
      hubScores: new Map([
        ["src/a.ts", 0.6],
        ["src/b.ts", 0.1],
      ]),
      betweennessScores: new Map([
        ["src/a.ts", 0.2],
        ["src/b.ts", 0.9],
      ]),
    };
  }

  function makeAnalysis(): ContextAnalysis {
    return {
      hubFiles: [
        {
          path: "src/b.ts",
          centrality: 0.8,
          authority: 0.7,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 1,
          imports: 0,
        },
      ],
      circularDeps: [],
      layers: [],
      layerEdges: [],
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [],
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        lagCouplings: [{ fileA: "src/a.ts", fileB: "src/b.ts", sameCommitCount: 3, lagScore: 0.8 }],
      },
      instabilities: [],
      communities: [{ id: 0, files: ["src/a.ts", "src/b.ts"], label: "core" }],
      chokepoints: [{ file: "src/b.ts", separates: 3, importedBy: 1 }],
      testMapping: {
        sourceToTests: new Map([["src/b.ts", ["src/__tests__/b.test.ts"]]]),
        untestedFiles: ["src/a.ts"],
      },
    };
  }

  it("round-trips through JSON serialization", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);
    const json = JSON.stringify(persisted);
    const parsed = JSON.parse(json) as PersistedGraph;

    expect(parsed.version).toBe(1);
    expect(parsed.files["src/a.ts"]).toBeDefined();
    expect(parsed.files["src/b.ts"]).toBeDefined();
    expect(parsed.edges.length).toBe(1); // external edge filtered out
  });

  it("includes all files from graph.inDegree", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);

    expect(Object.keys(persisted.files)).toHaveLength(2);
    expect(persisted.files["src/a.ts"]).toBeDefined();
    expect(persisted.files["src/b.ts"]).toBeDefined();
  });

  it("preserves edge-level importedNames", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);

    expect(persisted.edges[0].importedNames).toEqual(["foo", "bar"]);
  });

  it("assigns communityId to files", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);

    expect(persisted.files["src/a.ts"].communityId).toBe(0);
    expect(persisted.files["src/b.ts"].communityId).toBe(0);
  });

  it("preserves chokepoint data", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);

    expect(persisted.files["src/b.ts"].isChokepoint).toBe(true);
    expect(persisted.files["src/b.ts"].separatesComponents).toBe(3);
    expect(persisted.files["src/a.ts"].isChokepoint).toBe(false);
  });

  it("preserves test mapping", () => {
    const graph = makeImportGraph();
    const analysis = makeAnalysis();
    const persisted = buildPersistedGraph(graph, analysis);

    expect(persisted.files["src/b.ts"].hasTests).toBe(true);
    expect(persisted.files["src/b.ts"].testFiles).toEqual(["src/__tests__/b.test.ts"]);
    expect(persisted.files["src/a.ts"].hasTests).toBe(false);
  });
});

describe("checkStaleness", () => {
  it("reports stale when headCommit differs", () => {
    const graph = makeGraph({ files: {} });
    graph.headCommit = "old-commit";
    const result = checkStaleness(graph, "new-commit");
    expect(result.isStale).toBe(true);
    expect(result.reason).toContain("different commit");
  });

  it("reports stale when age > 24h", () => {
    const graph = makeGraph({ files: {} });
    graph.timestamp = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const result = checkStaleness(graph);
    expect(result.isStale).toBe(true);
    expect(result.ageHours).toBeGreaterThanOrEqual(25);
  });

  it("reports fresh when both match", () => {
    const graph = makeGraph({ files: {} });
    graph.timestamp = new Date().toISOString();
    graph.headCommit = "current-head";
    const result = checkStaleness(graph, "current-head");
    expect(result.isStale).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// D. Integration test for transitive test discovery
// ---------------------------------------------------------------------------

describe("transitive test discovery integration", () => {
  it("discovers test.ts even though it does not directly import utils.ts", () => {
    // Build: test.ts -> a.ts -> b.ts -> utils.ts
    const graph = makeGraph({
      files: {
        "utils.ts": { role: "Foundation", testFiles: [] },
        "b.ts": { role: "Leaf" },
        "a.ts": { role: "Leaf" },
        "chain.test.ts": { role: "Leaf" },
      },
      edges: [
        { from: "b.ts", to: "utils.ts", importedNames: ["fn"] },
        { from: "a.ts", to: "b.ts", importedNames: ["bar"] },
        { from: "chain.test.ts", to: "a.ts", importedNames: ["baz"] },
      ],
    });

    const result = handleImpact(graph, ["utils.ts"]);
    expect(result).toContain("chain.test.ts");
  });
});
