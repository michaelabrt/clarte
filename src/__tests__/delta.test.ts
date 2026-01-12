import { describe, expect, it } from "vitest";
import {
  extractSnapshot,
  computeDelta,
  isDeltaEmpty,
  renderDeltaSection,
  buildDeltaDirectives,
} from "../analysis/delta.js";
import type { AnalysisSnapshot } from "../analysis/delta.js";
import type { ContextAnalysis } from "../types.js";

function mockAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [
      {
        path: "src/types.ts",
        centrality: 1.0,
        authority: 1.0,
        hubScore: 0.1,
        role: "Foundation",
        importedBy: 10,
        imports: 0,
      },
      {
        path: "src/utils.ts",
        centrality: 0.8,
        authority: 0.8,
        hubScore: 0.2,
        role: "Utility",
        importedBy: 8,
        imports: 2,
      },
    ],
    circularDeps: [{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"] }],
    layers: [{ name: "types", files: ["src/types.ts"], importedByLayers: 2, dependsOn: [] }],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    deadFiles: ["src/dead.ts"],
    chokepoints: [{ file: "src/utils.ts", separates: 2, importedBy: 8, upstreamCount: 2, downstreamCount: 0 }],
    layerConsistency: {
      consistency: 0.9,
      violations: [{ from: "src/x.ts", to: "src/y.ts", fromLayer: "hooks", toLayer: "types" }],
    },
    ...overrides,
  };
}

function mockSnapshot(overrides?: Partial<AnalysisSnapshot>): AnalysisSnapshot {
  return {
    timestamp: "2025-01-01T00:00:00.000Z",
    hubFilePaths: ["src/types.ts", "src/utils.ts"],
    hubFileRoles: { "src/types.ts": "Foundation", "src/utils.ts": "Utility" },
    circularDepChains: [["src/a.ts", "src/b.ts", "src/a.ts"]],
    deadFiles: ["src/dead.ts"],
    chokepointPaths: ["src/utils.ts"],
    layerViolationCount: 1,
    ...overrides,
  };
}

describe("extractSnapshot", () => {
  it("extracts hub file paths and roles from analysis", () => {
    const snapshot = extractSnapshot(mockAnalysis());
    expect(snapshot.hubFilePaths).toEqual(["src/types.ts", "src/utils.ts"]);
    expect(snapshot.hubFileRoles).toEqual({
      "src/types.ts": "Foundation",
      "src/utils.ts": "Utility",
    });
  });

  it("extracts circular dependency chains", () => {
    const snapshot = extractSnapshot(mockAnalysis());
    expect(snapshot.circularDepChains).toEqual([["src/a.ts", "src/b.ts", "src/a.ts"]]);
  });

  it("extracts dead files and chokepoints", () => {
    const snapshot = extractSnapshot(mockAnalysis());
    expect(snapshot.deadFiles).toEqual(["src/dead.ts"]);
    expect(snapshot.chokepointPaths).toEqual(["src/utils.ts"]);
  });

  it("extracts layer violation count", () => {
    const snapshot = extractSnapshot(mockAnalysis());
    expect(snapshot.layerViolationCount).toBe(1);
  });

  it("handles missing optional fields", () => {
    const snapshot = extractSnapshot(
      mockAnalysis({
        deadFiles: undefined,
        chokepoints: undefined,
        layerConsistency: undefined,
      }),
    );
    expect(snapshot.deadFiles).toEqual([]);
    expect(snapshot.chokepointPaths).toEqual([]);
    expect(snapshot.layerViolationCount).toBe(0);
  });

  it("sets a valid ISO timestamp", () => {
    const snapshot = extractSnapshot(mockAnalysis());
    expect(snapshot.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });
});

describe("computeDelta", () => {
  it("detects new hub files", () => {
    const prev = mockSnapshot({ hubFilePaths: ["src/types.ts"] });
    const curr = mockSnapshot({ hubFilePaths: ["src/types.ts", "src/new-hub.ts"] });
    const delta = computeDelta(prev, curr);
    expect(delta.newHubFiles).toEqual(["src/new-hub.ts"]);
    expect(delta.demotedHubFiles).toEqual([]);
  });

  it("detects demoted hub files", () => {
    const prev = mockSnapshot({ hubFilePaths: ["src/types.ts", "src/old.ts"] });
    const curr = mockSnapshot({ hubFilePaths: ["src/types.ts"] });
    const delta = computeDelta(prev, curr);
    expect(delta.demotedHubFiles).toEqual(["src/old.ts"]);
  });

  it("detects new circular dependencies", () => {
    const prev = mockSnapshot({ circularDepChains: [] });
    const curr = mockSnapshot({ circularDepChains: [["src/x.ts", "src/y.ts", "src/x.ts"]] });
    const delta = computeDelta(prev, curr);
    expect(delta.newCircularDeps).toEqual([["src/x.ts", "src/y.ts", "src/x.ts"]]);
  });

  it("detects resolved circular dependencies", () => {
    const prev = mockSnapshot({ circularDepChains: [["src/a.ts", "src/b.ts", "src/a.ts"]] });
    const curr = mockSnapshot({ circularDepChains: [] });
    const delta = computeDelta(prev, curr);
    expect(delta.resolvedCircularDeps).toEqual([["src/a.ts", "src/b.ts", "src/a.ts"]]);
  });

  it("detects new dead files", () => {
    const prev = mockSnapshot({ deadFiles: [] });
    const curr = mockSnapshot({ deadFiles: ["src/orphan.ts"] });
    const delta = computeDelta(prev, curr);
    expect(delta.newDeadFiles).toEqual(["src/orphan.ts"]);
  });

  it("detects resurrected files", () => {
    const prev = mockSnapshot({ deadFiles: ["src/was-dead.ts"] });
    const curr = mockSnapshot({ deadFiles: [] });
    const delta = computeDelta(prev, curr);
    expect(delta.resurrectedFiles).toEqual(["src/was-dead.ts"]);
  });

  it("detects new chokepoints", () => {
    const prev = mockSnapshot({ chokepointPaths: [] });
    const curr = mockSnapshot({ chokepointPaths: ["src/critical.ts"] });
    const delta = computeDelta(prev, curr);
    expect(delta.newChokepoints).toEqual(["src/critical.ts"]);
  });

  it("detects resolved chokepoints", () => {
    const prev = mockSnapshot({ chokepointPaths: ["src/was-choke.ts"] });
    const curr = mockSnapshot({ chokepointPaths: [] });
    const delta = computeDelta(prev, curr);
    expect(delta.resolvedChokepoints).toEqual(["src/was-choke.ts"]);
  });

  it("computes layer violation delta", () => {
    const prev = mockSnapshot({ layerViolationCount: 2 });
    const curr = mockSnapshot({ layerViolationCount: 5 });
    const delta = computeDelta(prev, curr);
    expect(delta.layerViolationDelta).toBe(3);
  });

  it("handles empty previous snapshot gracefully", () => {
    const prev = mockSnapshot({
      hubFilePaths: [],
      circularDepChains: [],
      deadFiles: [],
      chokepointPaths: [],
      layerViolationCount: 0,
    });
    const curr = mockSnapshot();
    const delta = computeDelta(prev, curr);
    expect(delta.newHubFiles).toEqual(["src/types.ts", "src/utils.ts"]);
    expect(delta.demotedHubFiles).toEqual([]);
  });

  it("returns empty delta when nothing changed", () => {
    const snap = mockSnapshot();
    const delta = computeDelta(snap, snap);
    expect(isDeltaEmpty(delta)).toBe(true);
  });
});

describe("isDeltaEmpty", () => {
  it("returns true for empty delta", () => {
    expect(
      isDeltaEmpty({
        newHubFiles: [],
        demotedHubFiles: [],
        newCircularDeps: [],
        resolvedCircularDeps: [],
        newDeadFiles: [],
        resurrectedFiles: [],
        newChokepoints: [],
        resolvedChokepoints: [],
        layerViolationDelta: 0,
      }),
    ).toBe(true);
  });

  it("returns false when delta has changes", () => {
    expect(
      isDeltaEmpty({
        newHubFiles: ["src/new.ts"],
        demotedHubFiles: [],
        newCircularDeps: [],
        resolvedCircularDeps: [],
        newDeadFiles: [],
        resurrectedFiles: [],
        newChokepoints: [],
        resolvedChokepoints: [],
        layerViolationDelta: 0,
      }),
    ).toBe(false);
  });
});

describe("renderDeltaSection", () => {
  it("returns null for empty delta", () => {
    const result = renderDeltaSection({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toBeNull();
  });

  it("renders new hub files", () => {
    const result = renderDeltaSection({
      newHubFiles: ["src/new-hub.ts"],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toContain("## Architecture Changes");
    expect(result).toContain("`src/new-hub.ts` is a new hub file");
  });

  it("renders resolved circular deps", () => {
    const result = renderDeltaSection({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [["src/a.ts", "src/b.ts"]],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toContain("Circular dependency resolved");
    expect(result).toContain("`src/a.ts`");
  });

  it("renders layer violation changes", () => {
    const result = renderDeltaSection({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 3,
    });
    expect(result).toContain("3 new layer violations detected");
  });

  it("renders fixed violations", () => {
    const result = renderDeltaSection({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: -2,
    });
    expect(result).toContain("2 layer violations fixed");
  });

  it("groups many dead files with count", () => {
    const result = renderDeltaSection({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: ["a.ts", "b.ts", "c.ts", "d.ts"],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toContain("4 new dead files detected");
  });
});

describe("buildDeltaDirectives", () => {
  it("returns empty array for empty delta", () => {
    const result = buildDeltaDirectives({
      newHubFiles: [],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toEqual([]);
  });

  it("includes new hub file directives", () => {
    const result = buildDeltaDirectives({
      newHubFiles: ["src/new.ts"],
      demotedHubFiles: [],
      newCircularDeps: [],
      resolvedCircularDeps: [],
      newDeadFiles: [],
      resurrectedFiles: [],
      newChokepoints: [],
      resolvedChokepoints: [],
      layerViolationDelta: 0,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toContain("src/new.ts");
    expect(result[0]).toContain("hub file");
  });
});
