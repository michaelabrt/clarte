import { describe, expect, it } from "vitest";
import { buildDirectives, renderDirectivesSection } from "../templates/directives.js";
import type { ContextAnalysis, DetectedContext } from "../types.js";

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
        { path: "src/types.ts", centrality: 1.0, authority: 1.0, hubScore: 0.1, role: "Foundation", importedBy: 20, imports: 0 },
        { path: "src/utils.ts", centrality: 0.8, authority: 0.8, hubScore: 0.3, role: "Foundation", importedBy: 14, imports: 2 },
        { path: "src/index.ts", centrality: 0.5, authority: 0.2, hubScore: 0.9, role: "Orchestrator", importedBy: 1, imports: 10 },
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
      circularDeps: [
        { chain: ["a.ts", "b.ts", "a.ts"], breakHint: "Convert a.ts -> b.ts to type-only import" },
      ],
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("type-only import"))).toBe(true);
  });

  it("generates fallback message for circular deps without break hints", () => {
    const analysis = emptyAnalysis({
      circularDeps: [
        { chain: ["x.ts", "y.ts", "x.ts"] },
      ],
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
      chokepoints: [
        { file: "src/graph.ts", separates: 3, importedBy: 6 },
      ],
    });
    const directives = buildDirectives(analysis, mockCtx());
    expect(directives.some((d) => d.includes("chokepoint") && d.includes("src/graph.ts"))).toBe(true);
  });

  it("generates test reminders for untested hub files with importedBy >= 2", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        { path: "src/core.ts", centrality: 0.9, authority: 0.9, hubScore: 0.1, role: "Foundation", importedBy: 5, imports: 1 },
        { path: "src/leaf.ts", centrality: 0.1, authority: 0.1, hubScore: 0.0, role: "Leaf", importedBy: 1, imports: 0 },
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
    const directives = buildDirectives(
      emptyAnalysis(),
      mockCtx({ directories: ["src", ".beads"] }),
    );
    expect(directives.some((d) => d.includes("Beads"))).toBe(true);
  });

  it("generates tool integration hints for .beans directory", () => {
    const directives = buildDirectives(
      emptyAnalysis(),
      mockCtx({ directories: ["src", ".beans"] }),
    );
    expect(directives.some((d) => d.includes("Beans"))).toBe(true);
  });
});

describe("renderDirectivesSection", () => {
  it("returns null when no directives generated", () => {
    const result = renderDirectivesSection(emptyAnalysis(), mockCtx());
    expect(result).toBeNull();
  });

  it("renders markdown section with header and bullets", () => {
    const analysis = emptyAnalysis({
      hubFiles: [
        { path: "src/types.ts", centrality: 1.0, authority: 1.0, hubScore: 0.1, role: "Foundation", importedBy: 20, imports: 0 },
      ],
    });
    const result = renderDirectivesSection(analysis, mockCtx());
    expect(result).not.toBeNull();
    expect(result).toContain("## Working Guidelines");
    expect(result).toContain("- When modifying");
    expect(result).toContain("src/types.ts");
  });
});
