import { describe, expect, it } from "vitest";
import { analyzeForCI } from "../analysis/ci.js";
import type { ContextAnalysis, ImportGraph } from "../types.js";

function makeGraph(
  edges: Array<{ from: string; to: string }>,
  opts?: { betweenness?: Map<string, number> },
): ImportGraph {
  const edgeObjs = edges.map((e) => ({
    from: e.from,
    to: e.to,
    isExternal: false,
    specifier: `./${e.to}`,
    importedNames: [],
  }));

  const inDegree = new Map<string, number>();
  for (const e of edgeObjs) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
  }

  return {
    edges: edgeObjs,
    inDegree,
    centrality: new Map(),
    externalImportCounts: new Map(),
    authority: new Map(),
    hubScores: new Map(),
    betweennessScores: opts?.betweenness,
  };
}

function makeAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
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

describe("analyzeForCI", () => {
  describe("risk scoring", () => {
    it("scores a chokepoint file as high or critical", async () => {
      const graph = makeGraph([
        { from: "a.ts", to: "utils.ts" },
        { from: "b.ts", to: "utils.ts" },
        { from: "c.ts", to: "utils.ts" },
        { from: "d.ts", to: "utils.ts" },
        { from: "e.ts", to: "utils.ts" },
      ]);
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "utils.ts",
            centrality: 0.9,
            authority: 0.9,
            hubScore: 0.1,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 5 }],
      });

      const result = await analyzeForCI("/tmp", ["utils.ts"], analysis, graph);
      const file = result.files[0];

      // chokepoint(3) + highImportCount(2) = 5 -> high
      expect(file.riskScore).toBeGreaterThanOrEqual(4);
      expect(["high", "critical"]).toContain(file.riskLevel);
      expect(file.isChokepoint).toBe(true);
      expect(file.reasons.some((r) => r.includes("Chokepoint"))).toBe(true);
    });

    it("scores a clean file with no risk factors as low", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", ["clean.ts"], analysis, graph);
      const file = result.files[0];

      expect(file.riskScore).toBe(0);
      expect(file.riskLevel).toBe("low");
      expect(file.reasons).toHaveLength(0);
    });

    it("maps score 6+ to critical", async () => {
      const graph = makeGraph([
        { from: "a.ts", to: "risky.ts" },
        { from: "b.ts", to: "risky.ts" },
        { from: "c.ts", to: "risky.ts" },
        { from: "d.ts", to: "risky.ts" },
        { from: "e.ts", to: "risky.ts" },
      ]);
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "risky.ts",
            centrality: 0.9,
            authority: 0.9,
            hubScore: 0.1,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        chokepoints: [{ file: "risky.ts", separates: 5, importedBy: 5 }],
        testMapping: { sourceToTests: new Map(), untestedFiles: ["risky.ts"] },
      });

      const result = await analyzeForCI("/tmp", ["risky.ts"], analysis, graph);
      const file = result.files[0];

      // chokepoint(3) + highImportCount(2) + noTests(2) = 7 -> critical
      expect(file.riskScore).toBeGreaterThanOrEqual(6);
      expect(file.riskLevel).toBe("critical");
    });

    it("maps score 4-5 to high", async () => {
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "hub.ts",
            centrality: 0.8,
            authority: 0.8,
            hubScore: 0.2,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        testMapping: { sourceToTests: new Map([["hub.ts", ["hub.test.ts"]]]), untestedFiles: [] },
      });
      const betweenness = new Map([["hub.ts", 0.5]]);
      const graph = makeGraph(
        [
          { from: "a.ts", to: "hub.ts" },
          { from: "b.ts", to: "hub.ts" },
          { from: "c.ts", to: "hub.ts" },
          { from: "d.ts", to: "hub.ts" },
          { from: "e.ts", to: "hub.ts" },
        ],
        { betweenness },
      );

      const result = await analyzeForCI("/tmp", ["hub.ts"], analysis, graph);
      const file = result.files[0];

      // highImportCount(2) + flowBottleneck(2) = 4 -> high
      expect(file.riskScore).toBeGreaterThanOrEqual(4);
      expect(file.riskLevel).toBe("high");
    });

    it("maps score 2-3 to medium", async () => {
      const graph = makeGraph([
        { from: "a.ts", to: "medium.ts" },
        { from: "b.ts", to: "medium.ts" },
        { from: "c.ts", to: "medium.ts" },
        { from: "d.ts", to: "medium.ts" },
        { from: "e.ts", to: "medium.ts" },
      ]);
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "medium.ts",
            centrality: 0.5,
            authority: 0.5,
            hubScore: 0.3,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        testMapping: { sourceToTests: new Map([["medium.ts", ["medium.test.ts"]]]), untestedFiles: [] },
      });

      const result = await analyzeForCI("/tmp", ["medium.ts"], analysis, graph);
      const file = result.files[0];

      // highImportCount(2) = 2 -> medium
      expect(file.riskScore).toBeGreaterThanOrEqual(2);
      expect(file.riskScore).toBeLessThan(4);
      expect(file.riskLevel).toBe("medium");
    });
  });

  describe("co-change detection", () => {
    it("flags co-change partners not in the diff", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "b.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map([
            ["a.ts", 10],
            ["b.ts", 8],
          ]),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);
      const file = result.files[0];
      const partner = file.coChangeFiles.find((c) => c.file === "partner.ts");

      expect(partner).toBeDefined();
      expect(partner!.inDiff).toBe(false);
    });

    it("does not flag co-change partners that are in the diff", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "b.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map([
            ["a.ts", 10],
            ["b.ts", 8],
          ]),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts", "b.ts"], analysis, graph);
      const file = result.files.find((f) => f.path === "a.ts")!;
      const partner = file.coChangeFiles.find((c) => c.file === "b.ts");

      expect(partner).toBeDefined();
      expect(partner!.inDiff).toBe(true);
    });

    it("identifies hidden coupling when no import edge exists", async () => {
      // No direct edges between a.ts and partner.ts
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map([["a.ts", 10]]),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);
      const file = result.files[0];
      const partner = file.coChangeFiles.find((c) => c.file === "partner.ts");

      expect(partner).toBeDefined();
      expect(partner!.isHiddenCoupling).toBe(true);
    });
  });

  describe("test gap detection", () => {
    it("detects files without test coverage", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        testMapping: {
          sourceToTests: new Map([["tested.ts", ["tested.test.ts"]]]),
          untestedFiles: ["untested.ts"],
        },
      });

      const result = await analyzeForCI("/tmp", ["tested.ts", "untested.ts"], analysis, graph);

      const testedGap = result.testGaps.find((g) => g.changedFile === "tested.ts");
      const untestedGap = result.testGaps.find((g) => g.changedFile === "untested.ts");

      expect(testedGap?.hasTests).toBe(true);
      expect(testedGap?.testFiles).toEqual(["tested.test.ts"]);
      expect(untestedGap?.hasTests).toBe(false);
      expect(result.summary.missingTests).toBe(1);
    });
  });

  describe("architectural impact", () => {
    it("detects chokepoint modifications", async () => {
      const graph = makeGraph([
        { from: "a.ts", to: "choke.ts" },
        { from: "b.ts", to: "choke.ts" },
        { from: "c.ts", to: "choke.ts" },
        { from: "d.ts", to: "choke.ts" },
        { from: "e.ts", to: "choke.ts" },
      ]);
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "choke.ts",
            centrality: 0.9,
            authority: 0.9,
            hubScore: 0.1,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        chokepoints: [{ file: "choke.ts", separates: 3, importedBy: 5 }],
      });

      const result = await analyzeForCI("/tmp", ["choke.ts"], analysis, graph);

      expect(result.architecturalImpact.chokepointModifications.length).toBe(1);
      expect(result.architecturalImpact.chokepointModifications[0]).toContain("choke.ts");
    });

    it("detects cross-cutting changes", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        crossCuttingFiles: [{ file: "types.ts", totalImporters: 10, layerSpread: 3, layers: ["a", "b", "c"] }],
      });

      const result = await analyzeForCI("/tmp", ["types.ts"], analysis, graph);

      expect(result.architecturalImpact.crossCuttingChanges).toContain("types.ts");
    });
  });

  describe("edge cases", () => {
    it("handles empty input gracefully", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", [], analysis, graph);

      expect(result.files).toHaveLength(0);
      expect(result.testGaps).toHaveLength(0);
      expect(result.summary.overallRisk).toBe("low");
      expect(result.summary.totalFilesChanged).toBe(0);
    });
  });

  describe("summary", () => {
    it("computes overall risk from highest individual risk", async () => {
      const graph = makeGraph([
        { from: "a.ts", to: "risky.ts" },
        { from: "b.ts", to: "risky.ts" },
        { from: "c.ts", to: "risky.ts" },
        { from: "d.ts", to: "risky.ts" },
        { from: "e.ts", to: "risky.ts" },
      ]);
      const analysis = makeAnalysis({
        hubFiles: [
          {
            path: "risky.ts",
            centrality: 0.9,
            authority: 0.9,
            hubScore: 0.1,
            role: "Foundation",
            importedBy: 5,
            imports: 0,
          },
        ],
        chokepoints: [{ file: "risky.ts", separates: 5, importedBy: 5 }],
        testMapping: { sourceToTests: new Map(), untestedFiles: ["risky.ts"] },
      });

      const result = await analyzeForCI("/tmp", ["risky.ts", "clean.ts"], analysis, graph);

      expect(result.summary.overallRisk).toBe("critical");
      expect(result.summary.criticalRiskFiles).toBe(1);
    });

    it("counts co-change warnings (partners not in diff)", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "outside.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.summary.coChangeWarnings).toBeGreaterThan(0);
    });
  });
});
