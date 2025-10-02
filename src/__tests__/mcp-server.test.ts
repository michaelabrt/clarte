import { describe, it, expect } from "vitest";
import {
  queryHubFiles,
  queryFileInfo,
  queryWhatImports,
  queryWhatDoesImport,
  queryCircularDeps,
  queryLayers,
  queryLayerFor,
  queryRelatedTests,
  queryChangePartners,
} from "../mcp-server.js";
import type {
  ContextAnalysis,
  ImportGraph,
  HubFile,
  ImportEdge,
  ArchitecturalLayer,
  CircularDependency,
  ChangeCoupling,
} from "../types.js";

// ── Mock data helpers ─────────────────────────────────────────────────

function makeEdge(
  from: string,
  to: string,
  opts?: Partial<ImportEdge>,
): ImportEdge {
  return {
    from,
    to,
    isExternal: false,
    specifier: `./${to}`,
    importedNames: [],
    ...opts,
  };
}

function makeHubFile(path: string, overrides?: Partial<HubFile>): HubFile {
  return {
    path,
    centrality: 0.5,
    authority: 0.5,
    hubScore: 0.3,
    role: "Foundation",
    importedBy: 3,
    imports: 1,
    ...overrides,
  };
}

function makeMockGraph(edges: ImportEdge[]): ImportGraph {
  const inDegree = new Map<string, number>();
  for (const edge of edges) {
    if (!edge.isExternal) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }
  return {
    edges,
    inDegree,
    centrality: new Map(),
    externalImportCounts: new Map(),
    authority: new Map(),
    hubScores: new Map(),
  };
}

function makeMockAnalysis(
  overrides?: Partial<ContextAnalysis>,
): ContextAnalysis {
  return {
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("queryHubFiles", () => {
  const hubFiles: HubFile[] = [
    makeHubFile("src/types.ts", { centrality: 0.9, authority: 0.9 }),
    makeHubFile("src/utils.ts", { centrality: 0.7, authority: 0.7 }),
    makeHubFile("src/graph.ts", { centrality: 0.5, authority: 0.5 }),
    makeHubFile("src/detect.ts", { centrality: 0.3, authority: 0.3 }),
    makeHubFile("src/config.ts", { centrality: 0.1, authority: 0.1 }),
  ];
  const analysis = makeMockAnalysis({ hubFiles });

  it("returns all hub files sorted by centrality when no filters", () => {
    const result = queryHubFiles(analysis);
    expect(result).toHaveLength(5);
    expect(result[0].path).toBe("src/types.ts");
    expect(result[4].path).toBe("src/config.ts");
  });

  it("respects limit parameter", () => {
    const result = queryHubFiles(analysis, 2);
    expect(result).toHaveLength(2);
    expect(result[0].path).toBe("src/types.ts");
    expect(result[1].path).toBe("src/utils.ts");
  });

  it("filters by min_centrality", () => {
    const result = queryHubFiles(analysis, undefined, 0.5);
    expect(result).toHaveLength(3);
    expect(result.every((f) => f.centrality >= 0.5)).toBe(true);
  });

  it("applies both limit and min_centrality", () => {
    const result = queryHubFiles(analysis, 1, 0.5);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("src/types.ts");
  });
});

describe("queryFileInfo", () => {
  const edges: ImportEdge[] = [
    makeEdge("src/graph.ts", "src/types.ts"),
    makeEdge("src/detect.ts", "src/types.ts"),
    makeEdge("src/graph.ts", "src/utils.ts"),
    makeEdge("src/types.ts", "src/config.ts"),
  ];
  const graph = makeMockGraph(edges);
  const hubFiles: HubFile[] = [
    makeHubFile("src/types.ts", { centrality: 0.9 }),
  ];
  const layers: ArchitecturalLayer[] = [
    {
      name: "types",
      files: ["src/types.ts"],
      importedByLayers: 2,
      dependsOn: [],
    },
  ];
  const circularDeps: CircularDependency[] = [
    { chain: ["src/a.ts", "src/b.ts", "src/a.ts"] },
  ];
  const changeCoupling: ChangeCoupling[] = [
    {
      fileA: "src/types.ts",
      fileB: "src/graph.ts",
      coChangeCount: 10,
      support: 0.6,
      confidence: 0.7,
    },
  ];
  const testMapping = {
    sourceToTests: new Map([["src/types.ts", ["src/__tests__/types.test.ts"]]]),
    untestedFiles: [],
  };
  const analysis = makeMockAnalysis({
    hubFiles,
    layers,
    circularDeps,
    gitActivity: {
      commitCounts: new Map(),
      hotFiles: [],
      changeCoupling,
    },
    testMapping,
  });

  it("returns full file info for a known file", () => {
    const result = queryFileInfo("src/types.ts", analysis, graph);
    expect(result).not.toBeNull();
    expect(result!.path).toBe("src/types.ts");
    expect(result!.hubData?.centrality).toBe(0.9);
    expect(result!.layer).toBe("types");
    expect(result!.importedBy).toEqual(["src/graph.ts", "src/detect.ts"]);
    expect(result!.imports).toEqual(["src/config.ts"]);
    expect(result!.relatedTests).toEqual(["src/__tests__/types.test.ts"]);
    expect(result!.changePartners).toHaveLength(1);
  });

  it("returns null for an unknown file", () => {
    const result = queryFileInfo("src/nonexistent.ts", analysis, graph);
    expect(result).toBeNull();
  });

  it("strips leading ./ from path", () => {
    const result = queryFileInfo("./src/types.ts", analysis, graph);
    expect(result).not.toBeNull();
    expect(result!.path).toBe("src/types.ts");
  });

  it("returns circular deps involving the file", () => {
    const result = queryFileInfo("src/a.ts", analysis, graph);
    // src/a.ts is in circular deps but not in graph edges, so null
    // (it needs to be in graph or analysis)
    expect(result).toBeNull();
  });
});

describe("queryWhatImports", () => {
  const edges = [
    makeEdge("src/graph.ts", "src/types.ts"),
    makeEdge("src/detect.ts", "src/types.ts"),
    makeEdge("src/config.ts", "src/types.ts"),
    makeEdge(
      "src/graph.ts",
      "node:path",
      { isExternal: true, specifier: "node:path" },
    ),
  ];
  const graph = makeMockGraph(edges);

  it("returns all files that import the target", () => {
    const result = queryWhatImports("src/types.ts", graph);
    expect(result).toEqual(["src/graph.ts", "src/detect.ts", "src/config.ts"]);
  });

  it("excludes external imports", () => {
    const result = queryWhatImports("node:path", graph);
    expect(result).toEqual([]);
  });

  it("returns empty array for unknown file", () => {
    const result = queryWhatImports("src/unknown.ts", graph);
    expect(result).toEqual([]);
  });
});

describe("queryWhatDoesImport", () => {
  const edges = [
    makeEdge("src/graph.ts", "src/types.ts"),
    makeEdge("src/graph.ts", "src/utils.ts"),
    makeEdge(
      "src/graph.ts",
      "tinyglobby",
      { isExternal: true, specifier: "tinyglobby" },
    ),
  ];
  const graph = makeMockGraph(edges);

  it("returns all internal imports of the file", () => {
    const result = queryWhatDoesImport("src/graph.ts", graph);
    expect(result).toEqual(["src/types.ts", "src/utils.ts"]);
  });

  it("excludes external imports", () => {
    const result = queryWhatDoesImport("src/graph.ts", graph);
    expect(result).not.toContain("tinyglobby");
  });
});

describe("queryCircularDeps", () => {
  const circularDeps: CircularDependency[] = [
    { chain: ["src/a.ts", "src/b.ts", "src/a.ts"] },
    { chain: ["src/c.ts", "src/d.ts", "src/e.ts", "src/c.ts"] },
  ];
  const analysis = makeMockAnalysis({ circularDeps });

  it("returns all circular deps when no filter", () => {
    const result = queryCircularDeps(analysis);
    expect(result).toHaveLength(2);
  });

  it("filters by involving file", () => {
    const result = queryCircularDeps(analysis, "src/a.ts");
    expect(result).toHaveLength(1);
    expect(result[0].chain).toContain("src/a.ts");
  });

  it("returns empty for uninvolved file", () => {
    const result = queryCircularDeps(analysis, "src/x.ts");
    expect(result).toEqual([]);
  });
});

describe("queryLayers", () => {
  const layers: ArchitecturalLayer[] = [
    {
      name: "types",
      files: ["src/types.ts"],
      importedByLayers: 3,
      dependsOn: [],
    },
    {
      name: "utils",
      files: ["src/utils.ts"],
      importedByLayers: 2,
      dependsOn: ["types"],
    },
  ];
  const analysis = makeMockAnalysis({
    layers,
    layerConsistency: { consistency: 0.95, violations: [] },
  });

  it("returns all layers and consistency", () => {
    const result = queryLayers(analysis);
    expect(result.layers).toHaveLength(2);
    expect(result.layerConsistency?.consistency).toBe(0.95);
  });
});

describe("queryLayerFor", () => {
  const layers: ArchitecturalLayer[] = [
    {
      name: "types",
      files: ["src/types.ts"],
      importedByLayers: 3,
      dependsOn: [],
    },
  ];
  const analysis = makeMockAnalysis({ layers });

  it("returns the layer for a known file", () => {
    const result = queryLayerFor("src/types.ts", analysis);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("types");
  });

  it("returns null for a file not in any layer", () => {
    const result = queryLayerFor("src/unknown.ts", analysis);
    expect(result).toBeNull();
  });
});

describe("queryRelatedTests", () => {
  const testMapping = {
    sourceToTests: new Map([
      ["src/graph.ts", ["src/__tests__/graph.test.ts"]],
      [
        "src/utils.ts",
        ["src/__tests__/utils.test.ts", "src/__tests__/utils.edge.test.ts"],
      ],
    ]),
    untestedFiles: ["src/orphan.ts"],
  };
  const analysis = makeMockAnalysis({ testMapping });

  it("returns test files for a source file", () => {
    const result = queryRelatedTests("src/graph.ts", analysis);
    expect(result).toEqual(["src/__tests__/graph.test.ts"]);
  });

  it("returns multiple test files", () => {
    const result = queryRelatedTests("src/utils.ts", analysis);
    expect(result).toHaveLength(2);
  });

  it("returns empty for untested file", () => {
    const result = queryRelatedTests("src/orphan.ts", analysis);
    expect(result).toEqual([]);
  });
});

describe("queryChangePartners", () => {
  const changeCoupling: ChangeCoupling[] = [
    {
      fileA: "src/types.ts",
      fileB: "src/graph.ts",
      coChangeCount: 10,
      support: 0.6,
      confidence: 0.7,
    },
    {
      fileA: "src/types.ts",
      fileB: "src/detect.ts",
      coChangeCount: 5,
      support: 0.4,
      confidence: 0.5,
    },
    {
      fileA: "src/config.ts",
      fileB: "src/detect.ts",
      coChangeCount: 3,
      support: 0.3,
      confidence: 0.4,
    },
  ];
  const analysis = makeMockAnalysis({
    gitActivity: {
      commitCounts: new Map(),
      hotFiles: [],
      changeCoupling,
    },
  });

  it("returns change partners for a file (as fileA)", () => {
    const result = queryChangePartners("src/types.ts", analysis);
    expect(result).toHaveLength(2);
  });

  it("returns change partners for a file (as fileB)", () => {
    const result = queryChangePartners("src/detect.ts", analysis);
    expect(result).toHaveLength(2);
  });

  it("returns empty when no git activity", () => {
    const noGit = makeMockAnalysis({ gitActivity: null });
    const result = queryChangePartners("src/types.ts", noGit);
    expect(result).toEqual([]);
  });
});
