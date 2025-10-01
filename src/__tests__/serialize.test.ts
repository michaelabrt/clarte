import { describe, expect, it } from "vitest";
import { serializeAnalysis } from "../serialize.js";
import type { CodeSnapshot, ContextAnalysis, DetectedContext, ImportGraph } from "../types.js";

function mockCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [{ name: "Vitest", version: "4.0.18", importCount: 9 }],
    directories: ["src", "src/__tests__"],
    dependencies: ["vitest"],
    isGitRepo: true,
    totalSourceBytes: 50000,
    sourceFileCount: 20,
    monorepo: null,
    testFramework: "Vitest",
    ...overrides,
  };
}

function mockGraph(): ImportGraph {
  return {
    edges: [],
    inDegree: new Map(),
    centrality: new Map(),
    externalImportCounts: new Map(),
    authority: new Map(),
    hubScores: new Map(),
  };
}

function mockAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [
      { path: "src/types.ts", centrality: 1.0, authority: 1.0, hubScore: 0.1, role: "Foundation", importedBy: 20, imports: 0 },
    ],
    circularDeps: [],
    layers: [
      { name: "types", files: ["src/types.ts"], importedByLayers: 3, dependsOn: [] },
    ],
    layerEdges: [{ from: "utils", to: "types" }],
    gitActivity: {
      commitCounts: new Map([["src/index.ts", 16], ["src/types.ts", 12]]),
      hotFiles: [
        { path: "src/index.ts", commits: 16, lastChanged: "2 hours ago" },
      ],
      changeCoupling: [
        { fileA: "a.ts", fileB: "b.ts", coChangeCount: 10, support: 0.5, confidence: 0.83 },
      ],
    },
    instabilities: [],
    communities: [{ id: 0, files: ["src/types.ts"], label: "types" }],
    testMapping: {
      sourceToTests: new Map([["src/graph.ts", ["src/__tests__/graph.test.ts"]]]),
      untestedFiles: ["src/utils.ts"],
      testPattern: { framework: "Vitest", convention: "co-located", filePattern: "*.test.ts" },
    },
    ...overrides,
  };
}

describe("serializeAnalysis", () => {
  it("has version field set to 1", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.version).toBe(1);
  });

  it("includes all required project fields", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.project.language).toBe("typescript");
    expect(output.project.hasTypeScript).toBe(true);
    expect(output.project.packageManager).toBe("npm");
    expect(output.project.sourceFileCount).toBe(20);
    expect(output.project.frameworks).toHaveLength(1);
    expect(output.project.frameworks[0].name).toBe("Vitest");
  });

  it("converts Maps to plain objects for gitActivity", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.analysis.gitActivity).toBeDefined();
    // commitCounts should be a plain object, not a Map
    const commitCounts = output.analysis.gitActivity!.commitCounts;
    expect(commitCounts).toEqual({ "src/index.ts": 16, "src/types.ts": 12 });
    // Verify it's a plain object (not a Map)
    expect(commitCounts instanceof Map).toBe(false);
  });

  it("converts Maps to plain objects for testMapping", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.analysis.testMapping).toBeDefined();
    const sourceToTests = output.analysis.testMapping!.sourceToTests;
    expect(sourceToTests).toEqual({ "src/graph.ts": ["src/__tests__/graph.test.ts"] });
    expect(sourceToTests instanceof Map).toBe(false);
  });

  it("handles null snapshot", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.snapshot).toBeNull();
  });

  it("includes snapshot when provided", () => {
    const snapshot: CodeSnapshot = {
      entries: [
        { file: "src/types.ts", category: "interface", signature: "export interface Foo {}", importedByCount: 5 },
      ],
      markdown: "```ts\nexport interface Foo {}\n```",
      estimatedTokens: 100,
      budgetExcluded: 2,
    };
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), snapshot, mockGraph(), []);
    expect(output.snapshot).not.toBeNull();
    expect(output.snapshot!.entries).toHaveLength(1);
    expect(output.snapshot!.entries[0].file).toBe("src/types.ts");
    expect(output.snapshot!.estimatedTokens).toBe(100);
    expect(output.snapshot!.budgetExcluded).toBe(2);
  });

  it("includes directives", () => {
    const directives = ["Check types.ts dependents.", "Run tests for graph.ts."];
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), directives);
    expect(output.directives).toEqual(directives);
  });

  it("handles null monorepo", () => {
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), null, mockGraph(), []);
    expect(output.project.monorepo).toBeNull();
  });

  it("handles monorepo data", () => {
    const ctx = mockCtx({
      monorepo: {
        type: "pnpm-workspaces",
        packages: [
          { name: "@app/web", path: "packages/web", dependencies: ["react"], frameworks: [{ name: "React" }] },
        ],
      },
    });
    const output = serializeAnalysis(ctx, mockAnalysis(), null, mockGraph(), []);
    expect(output.project.monorepo).not.toBeNull();
    expect(output.project.monorepo!.type).toBe("pnpm-workspaces");
    expect(output.project.monorepo!.packages).toHaveLength(1);
  });

  it("roundtrips through JSON.parse", () => {
    const snapshot: CodeSnapshot = {
      entries: [{ file: "a.ts", category: "type", signature: "type A = string" }],
      markdown: "```ts\ntype A = string\n```",
      estimatedTokens: 50,
    };
    const output = serializeAnalysis(mockCtx(), mockAnalysis(), snapshot, mockGraph(), ["directive 1"]);
    const json = JSON.stringify(output);
    const parsed = JSON.parse(json);
    expect(parsed.version).toBe(1);
    expect(parsed.project.language).toBe("typescript");
    expect(parsed.analysis.hubFiles).toHaveLength(1);
    expect(parsed.snapshot.entries).toHaveLength(1);
    expect(parsed.directives).toEqual(["directive 1"]);
  });

  it("handles null optional fields in analysis", () => {
    const analysis = mockAnalysis({
      gitActivity: null,
      testMapping: undefined,
      chokepoints: undefined,
      crossCuttingFiles: undefined,
      deadFiles: undefined,
    });
    const output = serializeAnalysis(mockCtx(), analysis, null, mockGraph(), []);
    expect(output.analysis.gitActivity).toBeUndefined();
    expect(output.analysis.testMapping).toBeUndefined();
    expect(output.analysis.chokepoints).toBeUndefined();
  });
});
