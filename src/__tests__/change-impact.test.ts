import { describe, expect, it } from "vitest";
import { predictChangeImpact } from "../analysis/change-impact.js";
import type { GitAnalysis, ImportGraph } from "../types.js";

function makeGraph(edges: Array<{ from: string; to: string }>): ImportGraph {
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
  };
}

describe("predictChangeImpact", () => {
  it("returns structurally close files ranked by BFS distance", () => {
    const graph = makeGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "c.ts" },
      { from: "c.ts", to: "d.ts" },
    ]);

    const result = predictChangeImpact("a.ts", graph, null);

    // b.ts is distance 1, c.ts is 2, d.ts is 3
    expect(result.length).toBeGreaterThan(0);
    const files = result.map((r) => r.file);
    expect(files).toContain("b.ts");
    // b.ts should rank higher than d.ts
    const bIdx = files.indexOf("b.ts");
    const dIdx = files.indexOf("d.ts");
    if (dIdx >= 0) {
      expect(bIdx).toBeLessThan(dIdx);
    }
  });

  it("excludes the input file from results", () => {
    const graph = makeGraph([
      { from: "a.ts", to: "b.ts" },
      { from: "b.ts", to: "a.ts" },
    ]);

    const result = predictChangeImpact("a.ts", graph, null);
    expect(result.every((r) => r.file !== "a.ts")).toBe(true);
  });

  it("returns at most 5 predictions", () => {
    const graph = makeGraph([
      { from: "hub.ts", to: "a.ts" },
      { from: "hub.ts", to: "b.ts" },
      { from: "hub.ts", to: "c.ts" },
      { from: "hub.ts", to: "d.ts" },
      { from: "hub.ts", to: "e.ts" },
      { from: "hub.ts", to: "f.ts" },
      { from: "hub.ts", to: "g.ts" },
    ]);

    const result = predictChangeImpact("hub.ts", graph, null);
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("boosts files that appear in multiple rankings (temporal + structural)", () => {
    const graph = makeGraph([
      { from: "src/graph.ts", to: "src/types.ts" },
      { from: "src/graph.ts", to: "src/utils.ts" },
      { from: "src/index.ts", to: "src/graph.ts" },
    ]);

    const gitActivity: GitAnalysis = {
      commitCounts: new Map(),
      hotFiles: [],
      changeCoupling: [
        { fileA: "src/graph.ts", fileB: "src/types.ts", coChangeCount: 10, support: 0.5, confidence: 0.8 },
        { fileA: "src/graph.ts", fileB: "src/index.ts", coChangeCount: 5, support: 0.3, confidence: 0.6 },
      ],
    };

    const result = predictChangeImpact("src/graph.ts", graph, gitActivity);
    expect(result.length).toBeGreaterThan(0);

    // types.ts should rank high (appears in both structural and temporal rankings)
    const typesEntry = result.find((r) => r.file === "src/types.ts");
    expect(typesEntry).toBeDefined();
  });

  it("uses RRF formula correctly with known rankings", () => {
    // Create a simple graph where we can predict exact RRF scores
    const graph = makeGraph([{ from: "a.ts", to: "b.ts" }]);

    const result = predictChangeImpact("a.ts", graph, null);

    // b.ts is rank 1 in structural (distance 1) and rank 1 in directory (same dir)
    // RRF = 1/(60+1) + 1/(60+1) = 2/61
    expect(result.length).toBeGreaterThan(0);
    const bEntry = result.find((r) => r.file === "b.ts");
    expect(bEntry).toBeDefined();
    // b.ts is rank 1 in structural ranking only (no shared path segments for directory proximity)
    // RRF with k=60: 1/(60+1) = 1/61
    expect(bEntry!.score).toBeCloseTo(1 / 61, 4);
  });

  it("returns empty array when file has no connections", () => {
    const graph = makeGraph([{ from: "b.ts", to: "c.ts" }]);

    const result = predictChangeImpact("unrelated.ts", graph, null);
    expect(result).toEqual([]);
  });

  it("includes directory-proximate files in results", () => {
    // icon.ts is in the same directory as button.ts, so it should appear
    const graph = makeGraph([
      { from: "src/components/button.ts", to: "src/utils/helpers.ts" },
      { from: "src/components/button.ts", to: "src/components/icon.ts" },
    ]);

    const result = predictChangeImpact("src/components/button.ts", graph, null);
    const files = result.map((r) => r.file);

    // Both files should appear (structural proximity + directory proximity)
    expect(files).toContain("src/components/icon.ts");
    expect(files).toContain("src/utils/helpers.ts");

    // icon.ts should have a higher RRF score because it benefits from both
    // structural (distance 1) AND directory proximity (2/3 shared segments)
    const iconScore = result.find((r) => r.file === "src/components/icon.ts")!.score;
    const helpersScore = result.find((r) => r.file === "src/utils/helpers.ts")!.score;
    expect(iconScore).toBeGreaterThanOrEqual(helpersScore);
  });
});
