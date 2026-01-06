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
  describe("missing co-changes", () => {
    it("flags a partner not in the diff", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "b.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map([["a.ts", 10]]),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges).toHaveLength(1);
      expect(result.missingCoChanges[0].changed).toBe("a.ts");
      expect(result.missingCoChanges[0].missing).toBe("partner.ts");
      expect(result.missingCoChanges[0].confidence).toBe(0.5);
    });

    it("omits partners already in the diff", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "b.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts", "b.ts"], analysis, graph);

      expect(result.missingCoChanges).toHaveLength(0);
    });

    it("marks hidden coupling when no import edge exists", async () => {
      const graph = makeGraph([]); // no edges
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges[0].isHiddenCoupling).toBe(true);
    });

    it("marks structural coupling when import edge exists", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "partner.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges[0].isHiddenCoupling).toBe(false);
    });

    it("includes structural-temporal mismatches as hidden coupling", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        structuralMismatches: [
          { fileA: "a.ts", fileB: "far.ts", graphDistance: -1, coChangeConfidence: 0.6, coChangeCount: 8 },
        ],
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges).toHaveLength(1);
      expect(result.missingCoChanges[0].missing).toBe("far.ts");
      expect(result.missingCoChanges[0].isHiddenCoupling).toBe(true);
    });

    it("deduplicates by changed:partner pair", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [{ fileA: "a.ts", fileB: "partner.ts", coChangeCount: 5, support: 0.3, confidence: 0.5 }],
        },
        structuralMismatches: [
          { fileA: "a.ts", fileB: "partner.ts", graphDistance: -1, coChangeConfidence: 0.6, coChangeCount: 8 },
        ],
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      // Should appear only once (from changeCoupling, which is processed first)
      expect(result.missingCoChanges).toHaveLength(1);
    });

    it("sorts hidden first, then by confidence desc", async () => {
      const graph = makeGraph([{ from: "a.ts", to: "structural.ts" }]);
      const analysis = makeAnalysis({
        gitActivity: {
          commitCounts: new Map(),
          hotFiles: [],
          changeCoupling: [
            { fileA: "a.ts", fileB: "structural.ts", coChangeCount: 5, support: 0.3, confidence: 0.8 },
            { fileA: "a.ts", fileB: "hidden-low.ts", coChangeCount: 3, support: 0.2, confidence: 0.3 },
            { fileA: "a.ts", fileB: "hidden-high.ts", coChangeCount: 7, support: 0.4, confidence: 0.7 },
          ],
        },
      });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges).toHaveLength(3);
      // Hidden first (hidden-high, hidden-low), then structural
      expect(result.missingCoChanges[0].missing).toBe("hidden-high.ts");
      expect(result.missingCoChanges[1].missing).toBe("hidden-low.ts");
      expect(result.missingCoChanges[2].missing).toBe("structural.ts");
    });
  });

  describe("chokepoints", () => {
    it("alerts when a chokepoint is in the diff", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        chokepoints: [{ file: "choke.ts", separates: 5, importedBy: 10 }],
      });

      const result = await analyzeForCI("/tmp", ["choke.ts"], analysis, graph);

      expect(result.chokepoints).toHaveLength(1);
      expect(result.chokepoints[0].file).toBe("choke.ts");
      expect(result.chokepoints[0].separates).toBe(5);
    });

    it("ignores chokepoints not in the diff", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        chokepoints: [{ file: "choke.ts", separates: 5, importedBy: 10 }],
      });

      const result = await analyzeForCI("/tmp", ["other.ts"], analysis, graph);

      expect(result.chokepoints).toHaveLength(0);
    });
  });

  describe("cross-cutting", () => {
    it("alerts with layer info when file is in diff", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        crossCuttingFiles: [{ file: "types.ts", totalImporters: 10, layerSpread: 3, layers: ["a", "b", "c"] }],
      });

      const result = await analyzeForCI("/tmp", ["types.ts"], analysis, graph);

      expect(result.crossCutting).toHaveLength(1);
      expect(result.crossCutting[0].layerSpread).toBe(3);
      expect(result.crossCutting[0].layers).toEqual(["a", "b", "c"]);
    });
  });

  describe("flow bottlenecks", () => {
    it("alerts when betweenness exceeds 0.1", async () => {
      const betweenness = new Map([["hub.ts", 0.25]]);
      const graph = makeGraph(
        [
          { from: "a.ts", to: "hub.ts" },
          { from: "b.ts", to: "hub.ts" },
        ],
        { betweenness },
      );
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", ["hub.ts"], analysis, graph);

      expect(result.flowBottlenecks).toHaveLength(1);
      expect(result.flowBottlenecks[0].betweenness).toBe(0.25);
      expect(result.flowBottlenecks[0].importedBy).toBe(2);
    });

    it("ignores files with betweenness at or below 0.1", async () => {
      const betweenness = new Map([["low.ts", 0.1]]);
      const graph = makeGraph([], { betweenness });
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", ["low.ts"], analysis, graph);

      expect(result.flowBottlenecks).toHaveLength(0);
    });
  });

  describe("tight coupling", () => {
    it("alerts when either side is in the diff", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        tightCouplings: [{ from: "cache.ts", to: "types.ts", importedNames: 15 }],
      });

      // Only cache.ts in diff, types.ts not
      const result = await analyzeForCI("/tmp", ["cache.ts"], analysis, graph);

      expect(result.tightCouplings).toHaveLength(1);
      expect(result.tightCouplings[0].from).toBe("cache.ts");
      expect(result.tightCouplings[0].importedNames).toBe(15);
    });

    it("alerts when only the target side is in the diff", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        tightCouplings: [{ from: "cache.ts", to: "types.ts", importedNames: 15 }],
      });

      const result = await analyzeForCI("/tmp", ["types.ts"], analysis, graph);

      expect(result.tightCouplings).toHaveLength(1);
    });
  });

  describe("hasFindings", () => {
    it("is false when no signals fire", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", ["clean.ts"], analysis, graph);

      expect(result.hasFindings).toBe(false);
    });

    it("is true when any signal fires", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({
        chokepoints: [{ file: "choke.ts", separates: 3, importedBy: 5 }],
      });

      const result = await analyzeForCI("/tmp", ["choke.ts"], analysis, graph);

      expect(result.hasFindings).toBe(true);
    });
  });

  describe("edge cases", () => {
    it("handles empty changed files", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis();

      const result = await analyzeForCI("/tmp", [], analysis, graph);

      expect(result.filesAnalyzed).toBe(0);
      expect(result.hasFindings).toBe(false);
      expect(result.version).toBe(2);
    });

    it("handles null gitActivity", async () => {
      const graph = makeGraph([]);
      const analysis = makeAnalysis({ gitActivity: null });

      const result = await analyzeForCI("/tmp", ["a.ts"], analysis, graph);

      expect(result.missingCoChanges).toHaveLength(0);
    });
  });
});
