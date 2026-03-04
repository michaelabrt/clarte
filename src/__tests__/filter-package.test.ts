import { describe, it, expect } from "vitest";
import { filterAnalysisForPackage, filterGraphForPackage } from "../analysis/filter-package.js";
import { makeContextAnalysis, makeImportGraph } from "./helpers/factories.js";
import type { ImportGraph } from "../types.js";

// ── filterAnalysisForPackage ────────────────────────────────────────

describe("filterAnalysisForPackage", () => {
  it("filters hubFiles to package prefix and strips paths", () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "packages/api/src/index.ts",
          centrality: 0.9,
          authority: 0.9,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 10,
          imports: 2,
        },
        {
          path: "packages/web/src/app.ts",
          centrality: 0.5,
          authority: 0.5,
          hubScore: 0.5,
          role: "Leaf",
          importedBy: 3,
          imports: 5,
        },
        {
          path: "shared/utils.ts",
          centrality: 0.3,
          authority: 0.3,
          hubScore: 0.1,
          role: "Leaf",
          importedBy: 1,
          imports: 0,
        },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.hubFiles).toHaveLength(1);
    expect(result.hubFiles[0].path).toBe("src/index.ts");
  });

  it("excludes circular deps where not all chain members are in package", () => {
    const analysis = makeContextAnalysis({
      circularDeps: [
        { chain: ["packages/api/src/a.ts", "packages/api/src/b.ts", "packages/api/src/a.ts"] },
        { chain: ["packages/api/src/a.ts", "packages/web/src/c.ts", "packages/api/src/a.ts"] },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.circularDeps).toHaveLength(1);
    expect(result.circularDeps[0].chain).toEqual(["src/a.ts", "src/b.ts", "src/a.ts"]);
  });

  it("removes empty layers after filtering", () => {
    const analysis = makeContextAnalysis({
      layers: [
        { name: "types", files: ["packages/api/src/types.ts"], importedByLayers: 2, dependsOn: [] },
        { name: "utils", files: ["packages/web/src/utils.ts"], importedByLayers: 1, dependsOn: ["types"] },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.layers).toHaveLength(1);
    expect(result.layers[0].name).toBe("types");
    expect(result.layers[0].files).toEqual(["src/types.ts"]);
  });

  it("removes empty communities after filtering", () => {
    const analysis = makeContextAnalysis({
      communities: [
        { id: 0, files: ["packages/api/src/a.ts", "packages/api/src/b.ts"], label: "api" },
        { id: 1, files: ["packages/web/src/c.ts"], label: "web" },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.communities).toHaveLength(1);
    expect(result.communities[0].files).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("sets root-only fields to undefined", () => {
    const analysis = makeContextAnalysis({
      configConstraints: { typescript: { strict: true, target: "ES2022", pathAliases: {}, otherStrict: [] } },
      conventions: {
        naming: { functions: "camelCase", types: "PascalCase", constants: "UPPER_SNAKE_CASE", files: "camelCase" },
        exportStyle: { preferNamed: true, defaultExportPercent: 5, barrelFileCount: 2 },
      },
      graphTopology: {
        componentCount: 1,
        componentSizes: [10],
        approximateDiameter: 3,
        reachability: 1,
        isFragmented: false,
      },
      monorepoAnalysis: { crossPackageEdges: [], encapsulationViolations: [], packageDependencies: new Map() },
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.configConstraints).toBeUndefined();
    expect(result.conventions).toBeUndefined();
    expect(result.graphTopology).toBeUndefined();
    expect(result.monorepoAnalysis).toBeUndefined();
  });

  it("filters gitActivity fields by prefix", () => {
    const analysis = makeContextAnalysis({
      gitActivity: {
        commitCounts: new Map([
          ["packages/api/src/a.ts", 10],
          ["packages/web/src/b.ts", 5],
        ]),
        hotFiles: [
          { path: "packages/api/src/a.ts", commits: 10, lastChanged: "2026-01-01" },
          { path: "packages/web/src/b.ts", commits: 5, lastChanged: "2026-01-02" },
        ],
        changeCoupling: [
          {
            fileA: "packages/api/src/a.ts",
            fileB: "packages/api/src/c.ts",
            coChangeCount: 3,
            support: 0.5,
            confidence: 0.6,
          },
          {
            fileA: "packages/api/src/a.ts",
            fileB: "packages/web/src/b.ts",
            coChangeCount: 2,
            support: 0.3,
            confidence: 0.4,
          },
        ],
        lagCouplings: [
          { fileA: "packages/api/src/a.ts", fileB: "packages/api/src/c.ts", sameCommitCount: 2, lagScore: 0.8 },
        ],
        fileChurn: new Map([
          ["packages/api/src/a.ts", { linesAdded: 100, linesRemoved: 20 }],
          ["packages/web/src/b.ts", { linesAdded: 50, linesRemoved: 10 }],
        ]),
      },
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.gitActivity).not.toBeNull();
    expect(result.gitActivity?.commitCounts.size).toBe(1);
    expect(result.gitActivity?.commitCounts.get("src/a.ts")).toBe(10);
    expect(result.gitActivity?.hotFiles).toHaveLength(1);
    expect(result.gitActivity?.hotFiles[0].path).toBe("src/a.ts");
    expect(result.gitActivity?.changeCoupling).toHaveLength(1);
    expect(result.gitActivity?.changeCoupling[0].fileA).toBe("src/a.ts");
    expect(result.gitActivity?.lagCouplings).toHaveLength(1);
    expect(result.gitActivity?.fileChurn?.size).toBe(1);
  });

  it("filters testMapping fields by prefix", () => {
    const analysis = makeContextAnalysis({
      testMapping: {
        sourceToTests: new Map([
          ["packages/api/src/a.ts", ["packages/api/src/__tests__/a.test.ts"]],
          ["packages/web/src/b.ts", ["packages/web/src/__tests__/b.test.ts"]],
        ]),
        untestedFiles: ["packages/api/src/c.ts", "packages/web/src/d.ts"],
        testTypes: new Map([
          ["packages/api/src/__tests__/a.test.ts", "unit"],
          ["packages/web/src/__tests__/b.test.ts", "unit"],
        ]),
        exemplarTestFile: "packages/api/src/__tests__/a.test.ts",
      },
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.testMapping).toBeDefined();
    expect(result.testMapping?.sourceToTests.size).toBe(1);
    expect(result.testMapping?.sourceToTests.get("src/a.ts")).toEqual(["src/__tests__/a.test.ts"]);
    expect(result.testMapping?.untestedFiles).toEqual(["src/c.ts"]);
    expect(result.testMapping?.testTypes?.size).toBe(1);
    expect(result.testMapping?.exemplarTestFile).toBe("src/__tests__/a.test.ts");
  });

  it("filters chokepoints and strips dependent paths", () => {
    const analysis = makeContextAnalysis({
      chokepoints: [
        {
          file: "packages/api/src/core.ts",
          importedBy: 5,
          upstreamCount: 10,
          downstreamCount: 2,
          dependents: ["packages/api/src/a.ts", "packages/web/src/x.ts"],
        },
        { file: "packages/web/src/app.ts", importedBy: 3, upstreamCount: 5, downstreamCount: 1 },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.chokepoints).toHaveLength(1);
    expect(result.chokepoints?.[0].file).toBe("src/core.ts");
    expect(result.chokepoints?.[0].dependents).toEqual(["src/a.ts"]);
  });

  it("filters changeImpact keys and value files", () => {
    const analysis = makeContextAnalysis({
      changeImpact: new Map([
        [
          "packages/api/src/a.ts",
          [
            { file: "packages/api/src/b.ts", score: 0.9 },
            { file: "packages/web/src/c.ts", score: 0.5 },
          ],
        ],
        ["packages/web/src/x.ts", [{ file: "packages/web/src/y.ts", score: 0.8 }]],
      ]),
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.changeImpact).toBeDefined();
    expect(result.changeImpact?.size).toBe(1);
    const impacts = result.changeImpact?.get("src/a.ts");
    expect(impacts).toHaveLength(1);
    expect(impacts[0].file).toBe("src/b.ts");
  });

  it("does not match packages/api-docs when filtering for packages/api", () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "packages/api/src/index.ts",
          centrality: 0.9,
          authority: 0.9,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 10,
          imports: 2,
        },
        {
          path: "packages/api-docs/src/main.ts",
          centrality: 0.5,
          authority: 0.5,
          hubScore: 0.5,
          role: "Leaf",
          importedBy: 3,
          imports: 5,
        },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.hubFiles).toHaveLength(1);
    expect(result.hubFiles[0].path).toBe("src/index.ts");
  });

  it("returns empty analysis for package with no matching files", () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "packages/web/src/app.ts",
          centrality: 0.5,
          authority: 0.5,
          hubScore: 0.5,
          role: "Leaf",
          importedBy: 3,
          imports: 5,
        },
      ],
      circularDeps: [{ chain: ["packages/web/src/a.ts", "packages/web/src/b.ts"] }],
      deadFiles: ["packages/web/src/dead.ts"],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.hubFiles).toHaveLength(0);
    expect(result.circularDeps).toHaveLength(0);
    expect(result.deadFiles).toEqual([]);
  });

  it("preserves analysisDays from original", () => {
    const analysis = makeContextAnalysis({ analysisDays: 60 });
    const result = filterAnalysisForPackage(analysis, "packages/api");
    expect(result.analysisDays).toBe(60);
  });

  it("handles trailing slash in packagePath", () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "packages/api/src/index.ts",
          centrality: 0.9,
          authority: 0.9,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 10,
          imports: 2,
        },
      ],
    });

    const result = filterAnalysisForPackage(analysis, "packages/api/");
    expect(result.hubFiles).toHaveLength(1);
    expect(result.hubFiles[0].path).toBe("src/index.ts");
  });
});

// ── filterGraphForPackage ───────────────────────────────────────────

describe("filterGraphForPackage", () => {
  it("filters edges to intra-package and strips prefix", () => {
    const graph = makeImportGraph([
      { from: "packages/api/src/a.ts", to: "packages/api/src/b.ts" },
      { from: "packages/api/src/a.ts", to: "packages/web/src/c.ts" },
      { from: "packages/web/src/c.ts", to: "packages/web/src/d.ts" },
    ]);

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe("src/a.ts");
    expect(result.edges[0].to).toBe("src/b.ts");
  });

  it("filters Map fields by key prefix and strips keys", () => {
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map([
        ["packages/api/src/a.ts", 3],
        ["packages/web/src/b.ts", 1],
      ]),
      centrality: new Map([
        ["packages/api/src/a.ts", 0.8],
        ["packages/web/src/b.ts", 0.2],
      ]),
      externalImportCounts: new Map([
        ["express", 5],
        ["lodash", 2],
      ]),
      authority: new Map([["packages/api/src/a.ts", 0.9]]),
      hubScores: new Map([["packages/api/src/a.ts", 0.1]]),
    };

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.inDegree.size).toBe(1);
    expect(result.inDegree.get("src/a.ts")).toBe(3);
    expect(result.centrality.get("src/a.ts")).toBe(0.8);
    expect(result.authority.get("src/a.ts")).toBe(0.9);
    // externalImportCounts are kept as-is
    expect(result.externalImportCounts.size).toBe(2);
  });

  it("filters barrelFiles Set by prefix and strips", () => {
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      barrelFiles: new Set(["packages/api/src/index.ts", "packages/web/src/index.ts"]),
    };

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.barrelFiles).toBeDefined();
    expect(result.barrelFiles?.size).toBe(1);
    expect(result.barrelFiles?.has("src/index.ts")).toBe(true);
  });

  it("filters betweennessScores by prefix and strips", () => {
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["packages/api/src/core.ts", 0.7],
        ["packages/web/src/app.ts", 0.3],
      ]),
    };

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.betweennessScores?.size).toBe(1);
    expect(result.betweennessScores?.get("src/core.ts")).toBe(0.7);
  });

  it("does not match packages/api-docs when filtering for packages/api", () => {
    const graph = makeImportGraph([
      { from: "packages/api/src/a.ts", to: "packages/api/src/b.ts" },
      { from: "packages/api-docs/src/a.ts", to: "packages/api-docs/src/b.ts" },
    ]);

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0].from).toBe("src/a.ts");
  });

  it("returns empty graph for package with no matching files", () => {
    const graph = makeImportGraph([{ from: "packages/web/src/a.ts", to: "packages/web/src/b.ts" }]);

    const result = filterGraphForPackage(graph, "packages/api");
    expect(result.edges).toHaveLength(0);
    expect(result.inDegree.size).toBe(0);
  });
});
