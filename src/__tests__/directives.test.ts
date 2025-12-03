import { describe, expect, it } from "vitest";
import { buildDirectives, renderDirectivesSection } from "../templates/directives.js";
import type { FileComplexityInfo } from "../templates/directives.js";
import type { ContextAnalysis, DetectedContext, ImportGraph } from "../types.js";

function mockCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 10000,
    sourceFileCount: 20,
    monorepo: null,
    ...overrides,
  };
}

function emptyAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
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

describe("buildDirectives", () => {
  it("generates foundation guards for Foundation-role hub files", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/types.ts",
          centrality: 1.0,
          authority: 1.0,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 20,
          imports: 0,
        },
        {
          path: "src/utils.ts",
          centrality: 0.8,
          authority: 0.8,
          hubScore: 0.3,
          role: "Foundation",
          importedBy: 14,
          imports: 2,
        },
        {
          path: "src/index.ts",
          centrality: 0.5,
          authority: 0.2,
          hubScore: 0.9,
          role: "Orchestrator",
          importedBy: 1,
          imports: 10,
        },
      ],
    });
    const directives = buildDirectives(analysis, mockCtx());

    const foundationDirectives = directives.filter((d) => d.includes("Foundation"));
    expect(foundationDirectives).toHaveLength(2);
    expect(foundationDirectives[0]).toContain("src/types.ts");
    expect(foundationDirectives[0]).toContain("20 files");
    // Orchestrator should NOT produce a foundation guard
    expect(directives.some((d) => d.includes("src/index.ts") && d.includes("Foundation"))).toBe(false);
  });

  it("limits foundation guards to max 3", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        { path: "a.ts", centrality: 1.0, authority: 1.0, hubScore: 0, role: "Foundation", importedBy: 10, imports: 0 },
        { path: "b.ts", centrality: 0.9, authority: 0.9, hubScore: 0, role: "Foundation", importedBy: 9, imports: 0 },
        { path: "c.ts", centrality: 0.8, authority: 0.8, hubScore: 0, role: "Foundation", importedBy: 8, imports: 0 },
        { path: "d.ts", centrality: 0.7, authority: 0.7, hubScore: 0, role: "Foundation", importedBy: 7, imports: 0 },
      ],
    });
    const directives = buildDirectives(analysis, mockCtx());
    const foundationDirectives = directives.filter((d) => d.includes("Foundation"));
    expect(foundationDirectives).toHaveLength(3);
  });

  it("includes circular dep break hints", () => {
    const analysis = emptyAnalysis({
      circularDeps: [{ chain: ["a.ts", "b.ts", "a.ts"], breakHint: "Convert a.ts -> b.ts to type-only import" }],
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("type-only import"))).toBe(true);
  });

  it("generates fallback message for circular deps without break hints", () => {
    const analysis = emptyAnalysis({
      circularDeps: [{ chain: ["x.ts", "y.ts", "x.ts"] }],
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("Break circular dependency"))).toBe(true);
  });

  it("generates co-change directives only for confidence >= 0.6", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [],
        changeCoupling: [
          { fileA: "a.ts", fileB: "b.ts", coChangeCount: 10, support: 0.5, confidence: 0.83 },
          { fileA: "c.ts", fileB: "d.ts", coChangeCount: 2, support: 0.1, confidence: 0.3 },
        ],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("a.ts") && d.includes("83%"))).toBe(true);
    expect(directives.some((d) => d.includes("c.ts"))).toBe(false);
  });

  it("generates chokepoint caution directives", () => {
    const analysis = emptyAnalysis({
      chokepoints: [{ file: "src/graph.ts", separates: 3, importedBy: 6 }],
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("chokepoint") && d.includes("src/graph.ts"))).toBe(true);
  });

  it("generates test reminders for untested hub files with importedBy >= 2", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/core.ts",
          centrality: 0.9,
          authority: 0.9,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 5,
          imports: 1,
        },
        {
          path: "src/leaf.ts",
          centrality: 0.1,
          authority: 0.1,
          hubScore: 0.0,
          role: "Leaf",
          importedBy: 1,
          imports: 0,
        },
      ],
      testMapping: {
        sourceToTests: new Map(),
        untestedFiles: ["src/core.ts", "src/leaf.ts"],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    // core.ts has importedBy=5 >= 2, so it should get a test reminder
    expect(directives.some((d) => d.includes("src/core.ts") && d.includes("no tests"))).toBe(true);
    // leaf.ts has importedBy=1 < 2, so it should NOT get a test reminder
    expect(directives.some((d) => d.includes("src/leaf.ts") && d.includes("no tests"))).toBe(false);
  });

  it("generates layer violation warnings grouped by pair", () => {
    const analysis = emptyAnalysis({
      layerConsistency: {
        consistency: 0.8,
        violations: [
          { from: "a.ts", to: "b.ts", fromLayer: "components", toLayer: "types" },
          { from: "c.ts", to: "d.ts", fromLayer: "components", toLayer: "types" },
          { from: "e.ts", to: "f.ts", fromLayer: "hooks", toLayer: "utils" },
        ],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    const layerDirectives = directives.filter((d) => d.includes("Layer violation"));
    expect(layerDirectives.length).toBeLessThanOrEqual(2);
    expect(layerDirectives[0]).toContain("components -> types");
    expect(layerDirectives[0]).toContain("2 imports");
  });

  it("returns empty array for empty analysis", () => {
    const directives = buildDirectives(emptyAnalysis(), mockCtx());
    expect(directives).toEqual([]);
  });

  it("generates tool integration hints for .beads directory", () => {
    const directives = buildDirectives(emptyAnalysis(), mockCtx({ directories: ["src", ".beads"] }));
    expect(directives.some((d) => d.includes("Beads"))).toBe(true);
  });

  it("generates tool integration hints for .beans directory", () => {
    const directives = buildDirectives(emptyAnalysis(), mockCtx({ directories: ["src", ".beans"] }));
    expect(directives.some((d) => d.includes("Beans"))).toBe(true);
  });

  it("generates high-churn directives for files with >= 10 commits", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map([
          ["src/index.ts", 16],
          ["src/types.ts", 12],
          ["src/utils.ts", 5],
        ]),
        hotFiles: [
          { path: "src/index.ts", commits: 16, lastChanged: "2 hours ago" },
          { path: "src/types.ts", commits: 12, lastChanged: "6 hours ago" },
          { path: "src/utils.ts", commits: 5, lastChanged: "1 day ago" },
        ],
        changeCoupling: [],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    const churnDirectives = directives.filter((d) => d.includes("high-churn"));
    // Only src/index.ts (16) and src/types.ts (12) have >= 10 commits
    expect(churnDirectives).toHaveLength(2);
    expect(churnDirectives[0]).toContain("src/index.ts");
    expect(churnDirectives[0]).toContain("16 commits");
    expect(churnDirectives[1]).toContain("src/types.ts");
    // src/utils.ts has only 5 commits, should not appear
    expect(directives.some((d) => d.includes("src/utils.ts") && d.includes("high-churn"))).toBe(false);
  });

  it("limits high-churn directives to max 3", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [
          { path: "a.ts", commits: 20, lastChanged: "1h" },
          { path: "b.ts", commits: 18, lastChanged: "2h" },
          { path: "c.ts", commits: 15, lastChanged: "3h" },
          { path: "d.ts", commits: 12, lastChanged: "4h" },
        ],
        changeCoupling: [],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    const churnDirectives = directives.filter((d) => d.includes("high-churn"));
    expect(churnDirectives).toHaveLength(3);
  });

  it("generates complexity directives for hub files with medium/high branch points", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/graph.ts",
          centrality: 0.8,
          authority: 0.8,
          hubScore: 0.2,
          role: "Foundation",
          importedBy: 6,
          imports: 2,
        },
        {
          path: "src/simple.ts",
          centrality: 0.3,
          authority: 0.3,
          hubScore: 0.1,
          role: "Utility",
          importedBy: 3,
          imports: 1,
        },
      ],
    });
    const fileComplexity: FileComplexityInfo[] = [
      { path: "src/graph.ts", exports: 24, lines: 2400, branchPoints: 55 },
      { path: "src/simple.ts", exports: 3, lines: 50, branchPoints: 5 },
    ];
    const directives = buildDirectives(analysis, mockCtx(), fileComplexity);
    const complexityDirectives = directives.filter((d) => d.includes("complexity"));
    // Only graph.ts has high complexity (55 > 50)
    expect(complexityDirectives).toHaveLength(1);
    expect(complexityDirectives[0]).toContain("src/graph.ts");
    expect(complexityDirectives[0]).toContain("Foundation");
    expect(complexityDirectives[0]).toContain("high complexity");
    expect(complexityDirectives[0]).toContain("24 exports");
    expect(complexityDirectives[0]).toContain("2400+");
    // simple.ts has low complexity, should not appear
    expect(directives.some((d) => d.includes("src/simple.ts") && d.includes("complexity"))).toBe(false);
  });

  it("generates medium complexity directives for branch points 20-50", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/mid.ts",
          centrality: 0.5,
          authority: 0.5,
          hubScore: 0.3,
          role: "Bridge",
          importedBy: 4,
          imports: 3,
        },
      ],
    });
    const fileComplexity: FileComplexityInfo[] = [{ path: "src/mid.ts", exports: 10, lines: 500, branchPoints: 30 }];
    const directives = buildDirectives(analysis, mockCtx(), fileComplexity);
    const complexityDirectives = directives.filter((d) => d.includes("complexity"));
    expect(complexityDirectives).toHaveLength(1);
    expect(complexityDirectives[0]).toContain("medium complexity");
    expect(complexityDirectives[0]).toContain("Bridge");
  });

  it("limits complexity directives to max 3", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "a.ts",
          centrality: 0.9,
          authority: 0.9,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 10,
          imports: 0,
        },
        { path: "b.ts", centrality: 0.8, authority: 0.8, hubScore: 0.1, role: "Foundation", importedBy: 8, imports: 0 },
        { path: "c.ts", centrality: 0.7, authority: 0.7, hubScore: 0.1, role: "Foundation", importedBy: 6, imports: 0 },
        { path: "d.ts", centrality: 0.6, authority: 0.6, hubScore: 0.1, role: "Foundation", importedBy: 4, imports: 0 },
      ],
    });
    const fileComplexity: FileComplexityInfo[] = [
      { path: "a.ts", exports: 20, lines: 1000, branchPoints: 60 },
      { path: "b.ts", exports: 18, lines: 900, branchPoints: 55 },
      { path: "c.ts", exports: 15, lines: 800, branchPoints: 45 },
      { path: "d.ts", exports: 12, lines: 700, branchPoints: 35 },
    ];
    const directives = buildDirectives(analysis, mockCtx(), fileComplexity);
    const complexityDirectives = directives.filter((d) => d.includes("complexity"));
    expect(complexityDirectives).toHaveLength(3);
  });

  it("skips complexity directives when fileComplexity is not provided", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/graph.ts",
          centrality: 0.8,
          authority: 0.8,
          hubScore: 0.2,
          role: "Foundation",
          importedBy: 6,
          imports: 2,
        },
      ],
    });
    // No fileComplexity passed
    const directives = buildDirectives(analysis, mockCtx());
    const complexityDirectives = directives.filter((d) => d.includes("complexity"));
    expect(complexityDirectives).toHaveLength(0);
  });

  it("generates lag coupling directives", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [],
        changeCoupling: [],
        lagCouplings: [
          { fileA: "schema.ts", fileB: "migration.ts", sameCommitCount: 5, lagScore: 4.0 },
          { fileA: "types.ts", fileB: "validate.ts", sameCommitCount: 3, lagScore: 2.5 },
        ],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    const lagDirectives = directives.filter((d) => d.includes("lagged co-change"));
    expect(lagDirectives).toHaveLength(2);
    expect(lagDirectives[0]).toContain("schema.ts");
    expect(lagDirectives[0]).toContain("migration.ts");
  });

  it("limits lag coupling directives to max 3", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [],
        changeCoupling: [],
        lagCouplings: [
          { fileA: "a.ts", fileB: "b.ts", sameCommitCount: 5, lagScore: 4.0 },
          { fileA: "c.ts", fileB: "d.ts", sameCommitCount: 4, lagScore: 3.0 },
          { fileA: "e.ts", fileB: "f.ts", sameCommitCount: 3, lagScore: 2.5 },
          { fileA: "g.ts", fileB: "h.ts", sameCommitCount: 2, lagScore: 2.0 },
        ],
      },
    });
    const directives = buildDirectives(analysis, mockCtx());
    const lagDirectives = directives.filter((d) => d.includes("lagged co-change"));
    expect(lagDirectives).toHaveLength(3);
  });

  it("generates change impact directives", () => {
    const changeImpact = new Map<string, Array<{ file: string; score: number }>>();
    changeImpact.set("src/graph.ts", [
      { file: "src/types.ts", score: 0.03 },
      { file: "src/index.ts", score: 0.02 },
      { file: "src/snapshot.ts", score: 0.01 },
    ]);

    const analysis = emptyAnalysis({ changeImpact });
    const directives = buildDirectives(analysis, mockCtx());
    const impactDirectives = directives.filter((d) => d.includes("also check:"));
    expect(impactDirectives).toHaveLength(1);
    expect(impactDirectives[0]).toContain("src/graph.ts");
    expect(impactDirectives[0]).toContain("src/types.ts");
    expect(impactDirectives[0]).toContain("src/index.ts");
  });

  it("limits change impact directives to max 5", () => {
    const changeImpact = new Map<string, Array<{ file: string; score: number }>>();
    for (let i = 0; i < 7; i++) {
      changeImpact.set(`hub${i}.ts`, [{ file: `target${i}.ts`, score: 0.01 }]);
    }

    const analysis = emptyAnalysis({ changeImpact });
    const directives = buildDirectives(analysis, mockCtx());
    const impactDirectives = directives.filter((d) => d.includes("also check:"));
    expect(impactDirectives).toHaveLength(5);
  });

  it("generates flow bottleneck directives for high betweenness non-chokepoints", () => {
    const analysis = emptyAnalysis({
      chokepoints: [{ file: "src/bridge.ts", separates: 2, importedBy: 5 }],
    });

    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["src/utils.ts", 0.8], // high betweenness, NOT a chokepoint
        ["src/bridge.ts", 0.9], // high betweenness, IS a chokepoint (should be excluded)
        ["src/leaf.ts", 0.2], // low betweenness
      ]),
    };

    const directives = buildDirectives(analysis, mockCtx(), undefined, graph);
    const bottleneckDirectives = directives.filter((d) => d.includes("flow bottleneck"));
    expect(bottleneckDirectives).toHaveLength(1);
    expect(bottleneckDirectives[0]).toContain("src/utils.ts");
    // bridge.ts should NOT appear (it's already a chokepoint)
    expect(directives.some((d) => d.includes("src/bridge.ts") && d.includes("flow bottleneck"))).toBe(false);
  });

  it("limits flow bottleneck directives to max 3", () => {
    const analysis = emptyAnalysis();
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["a.ts", 0.9],
        ["b.ts", 0.8],
        ["c.ts", 0.7],
        ["d.ts", 0.6],
      ]),
    };

    const directives = buildDirectives(analysis, mockCtx(), undefined, graph);
    const bottleneckDirectives = directives.filter((d) => d.includes("flow bottleneck"));
    expect(bottleneckDirectives).toHaveLength(3);
  });

  it("excludes files with betweenness <= 0.5 from bottleneck directives", () => {
    const analysis = emptyAnalysis();
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["a.ts", 0.5], // exactly 0.5, should NOT be included (> 0.5 required)
        ["b.ts", 0.3],
      ]),
    };

    const directives = buildDirectives(analysis, mockCtx(), undefined, graph);
    const bottleneckDirectives = directives.filter((d) => d.includes("flow bottleneck"));
    expect(bottleneckDirectives).toHaveLength(0);
  });

  it("generates fitness violation directives for test isolation", () => {
    const analysis = emptyAnalysis({
      archViolations: [
        {
          from: "tests/a.test.ts",
          to: "tests/b.test.ts",
          rule: "test-isolation",
          message:
            "`tests/a.test.ts` imports another test file `tests/b.test.ts`. Extract shared setup to a test utility.",
          severity: "warning",
        },
        {
          from: "tests/c.test.ts",
          to: "tests/d.test.ts",
          rule: "test-isolation",
          message:
            "`tests/c.test.ts` imports another test file `tests/d.test.ts`. Extract shared setup to a test utility.",
          severity: "warning",
        },
      ],
    });

    const directives = buildDirectives(analysis, mockCtx());
    const fitnessDirectives = directives.filter((d) => d.includes("test files import other test files"));
    expect(fitnessDirectives).toHaveLength(1);
    expect(fitnessDirectives[0]).toContain("2 test files");
    expect(fitnessDirectives[0]).toContain("test-utils/");
  });

  it("generates fitness violation directives for layer skips", () => {
    const analysis = emptyAnalysis({
      archViolations: [
        {
          from: "src/pages/Home.ts",
          to: "src/types/index.ts",
          rule: "layer-skip",
          message:
            "`src/pages/Home.ts` imports directly from `src/types/index.ts`, skipping 2 intermediate layers. Consider adding an abstraction in an intermediate layer.",
          severity: "warning",
        },
      ],
    });

    const directives = buildDirectives(analysis, mockCtx());
    const skipDirectives = directives.filter((d) => d.includes("skipping"));
    expect(skipDirectives).toHaveLength(1);
    expect(skipDirectives[0]).toContain("src/pages/Home.ts");
  });

  it("generates fitness violation directives for upward dependencies", () => {
    const analysis = emptyAnalysis({
      archViolations: [
        {
          from: "src/types/User.ts",
          to: "src/components/Form.ts",
          rule: "no-upward-dep",
          message:
            "`src/types/User.ts` (types layer) should not import from `src/components/Form.ts` (components layer). Extract shared logic to a lower layer.",
          severity: "warning",
        },
      ],
    });

    const directives = buildDirectives(analysis, mockCtx());
    const upwardDirectives = directives.filter((d) => d.includes("should not import"));
    expect(upwardDirectives).toHaveLength(1);
    expect(upwardDirectives[0]).toContain("src/types/User.ts");
  });

  it("limits fitness violation directives to max 5", () => {
    const analysis = emptyAnalysis({
      archViolations: [
        // 3 test isolation
        { from: "a.test.ts", to: "b.test.ts", rule: "test-isolation", message: "test1", severity: "warning" },
        { from: "c.test.ts", to: "d.test.ts", rule: "test-isolation", message: "test2", severity: "warning" },
        { from: "e.test.ts", to: "f.test.ts", rule: "test-isolation", message: "test3", severity: "warning" },
        // 4 layer skips
        { from: "p1.ts", to: "t1.ts", rule: "layer-skip", message: "skip1", severity: "warning" },
        { from: "p2.ts", to: "t2.ts", rule: "layer-skip", message: "skip2", severity: "warning" },
        { from: "p3.ts", to: "t3.ts", rule: "layer-skip", message: "skip3", severity: "warning" },
        { from: "p4.ts", to: "t4.ts", rule: "layer-skip", message: "skip4", severity: "warning" },
        // 3 upward deps
        { from: "u1.ts", to: "c1.ts", rule: "no-upward-dep", message: "up1", severity: "warning" },
        { from: "u2.ts", to: "c2.ts", rule: "no-upward-dep", message: "up2", severity: "warning" },
        { from: "u3.ts", to: "c3.ts", rule: "no-upward-dep", message: "up3", severity: "warning" },
      ],
    });

    const directives = buildDirectives(analysis, mockCtx());
    // Count all fitness directives:
    // test-isolation grouped = 1, layer-skip (max 2) = 2, upward-dep grouped = 1 => 4 total
    // Should be at most 5
    const fitnessRelated = directives.filter(
      (d) => d.includes("test files import") || d.includes("skip") || d.includes("upward dependency"),
    );
    expect(fitnessRelated.length).toBeLessThanOrEqual(5);
  });

  it("does not generate fitness directives when archViolations is empty", () => {
    const analysis = emptyAnalysis({ archViolations: [] });
    const directives = buildDirectives(analysis, mockCtx());
    const fitnessDirectives = directives.filter(
      (d) => d.includes("test files import") || d.includes("skipping") || d.includes("upward dependency"),
    );
    expect(fitnessDirectives).toHaveLength(0);
  });
});

describe("renderDirectivesSection", () => {
  it("returns null when no directives generated", async () => {
    const result = await renderDirectivesSection(emptyAnalysis(), mockCtx());
    expect(result).toBeNull();
  });

  it("renders markdown section with header and bullets", async () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        {
          path: "src/types.ts",
          centrality: 1.0,
          authority: 1.0,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 20,
          imports: 0,
        },
      ],
    });
    const result = await renderDirectivesSection(analysis, mockCtx());
    expect(result).not.toBeNull();
    expect(result).toContain("## Working Guidelines");
    expect(result).toContain("- When modifying");
    expect(result).toContain("src/types.ts");
  });

  it("includes flow bottleneck directive when graph has high betweenness non-chokepoints", async () => {
    const analysis = emptyAnalysis({
      chokepoints: [{ file: "src/bridge.ts", separates: 2, importedBy: 5 }],
    });
    const graph: ImportGraph = {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["src/hot-path.ts", 0.75],
        ["src/bridge.ts", 0.9],
      ]),
    };

    const result = await renderDirectivesSection(analysis, mockCtx(), graph);
    expect(result).not.toBeNull();
    expect(result).toContain("## Working Guidelines");
    expect(result).toContain("flow bottleneck");
    expect(result).toContain("src/hot-path.ts");
    // bridge.ts is a chokepoint, should not appear as a flow bottleneck
    expect(result).not.toMatch(/src\/bridge\.ts.*flow bottleneck/);
  });
});
