/**
 * Tests for centralized thresholds in src/config/thresholds.ts.
 *
 * Focus: verify the constants are wired to the behavior they govern, not just
 * that they exist. Each test targets the specific boundary or cut-off the
 * constant controls.
 */

import { describe, expect, it } from "vitest";
import { computeGraphTopology } from "../graph/topology.js";
import { formatScope, formatImpact, formatFunction } from "../mcp/format.js";
import {
  FRAGMENT_MIN_SIZE,
  MCP,
  HITS,
  ROLE_THRESHOLDS,
  BARREL_THRESHOLD,
  MAJORITY_THRESHOLD,
  STRONG_MAJORITY_THRESHOLD,
  INSTABILITY_TYPE_ONLY_WEIGHT,
  HASH_CONCURRENCY,
  INSTABILITY_THRESHOLD,
  BETWEENNESS_K,
  DIFF_COUPLING_THRESHOLD,
  LAYER_CONSISTENCY,
  SNAPSHOT_LANGUAGES,
  GRAPH_DATA,
} from "../config/thresholds.js";
import { makeGraph, edge } from "./algorithm/helpers.js";
import { makePersistedGraph, makeFileRecord } from "./helpers/factories.js";
import type { CallSite } from "../types/call-graph.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEdgesByTarget(edges: Array<{ from: string; to: string }>) {
  const map = new Map<string, { from: string; to: string; importedNames: string[] }[]>();
  for (const e of edges) {
    if (!map.has(e.to)) map.set(e.to, []);
    map.get(e.to)?.push({ from: e.from, to: e.to, importedNames: [] });
  }
  return map;
}

/**
 * Build a chain of `n` isolated nodes: a0 -> a1 -> ... -> a(n-1).
 * All nodes are in one component; for fragmentation tests we also need a
 * separate disconnected component.
 */
function chainEdges(prefix: string, n: number): Array<{ from: string; to: string }> {
  return Array.from({ length: n - 1 }, (_, i) => ({ from: `${prefix}${i}`, to: `${prefix}${i + 1}` }));
}

// ---------------------------------------------------------------------------
// FRAGMENT_MIN_SIZE — controls isFragmented in computeGraphTopology
// ---------------------------------------------------------------------------

describe("FRAGMENT_MIN_SIZE controls isFragmented boundary", () => {
  it("is not fragmented when second component has fewer files than FRAGMENT_MIN_SIZE", () => {
    // Main component: 10 files (a0..a9).  Second component: FRAGMENT_MIN_SIZE - 1 files.
    const secondSize = FRAGMENT_MIN_SIZE - 1;
    const mainEdges = chainEdges("a", 10);
    const secondEdges = chainEdges("b", secondSize);
    const allEdges = [...mainEdges, ...secondEdges].map((e) => edge(e.from, e.to));
    const files = [
      ...Array.from({ length: 10 }, (_, i) => `a${i}`),
      ...Array.from({ length: secondSize }, (_, i) => `b${i}`),
    ];
    const graph = makeGraph(files, allEdges);
    const topology = computeGraphTopology(graph);
    expect(topology.isFragmented).toBe(false);
  });

  it("is fragmented when second component reaches FRAGMENT_MIN_SIZE files", () => {
    // Second component exactly at the threshold.
    const mainEdges = chainEdges("a", 10);
    const secondEdges = chainEdges("b", FRAGMENT_MIN_SIZE);
    const allEdges = [...mainEdges, ...secondEdges].map((e) => edge(e.from, e.to));
    const files = [
      ...Array.from({ length: 10 }, (_, i) => `a${i}`),
      ...Array.from({ length: FRAGMENT_MIN_SIZE }, (_, i) => `b${i}`),
    ];
    const graph = makeGraph(files, allEdges);
    const topology = computeGraphTopology(graph);
    expect(topology.isFragmented).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// MCP.CO_CHANGE_THRESHOLD — controls which co-changes appear in formatScope
// ---------------------------------------------------------------------------

describe("MCP.CO_CHANGE_THRESHOLD filters co-changes in formatScope", () => {
  it("excludes co-change partners below the threshold", () => {
    const confidence = MCP.CO_CHANGE_THRESHOLD - 0.01;
    const graph = makePersistedGraph({
      files: { "src/a.ts": makeFileRecord({}) },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence, coChangeCount: 10 }],
    });
    const result = formatScope("src/a.ts", graph, makeEdgesByTarget([]));
    expect(result).not.toContain("CO-CHANGES");
  });

  it("includes co-change partners at exactly the threshold", () => {
    const confidence = MCP.CO_CHANGE_THRESHOLD;
    const graph = makePersistedGraph({
      files: { "src/a.ts": makeFileRecord({}) },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence, coChangeCount: 10 }],
    });
    const result = formatScope("src/a.ts", graph, makeEdgesByTarget([]));
    expect(result).toContain("CO-CHANGES");
    expect(result).toContain("src/b.ts");
  });
});

// ---------------------------------------------------------------------------
// MCP.RISK_* — risk level boundaries in formatImpact
// ---------------------------------------------------------------------------

describe("MCP risk thresholds determine risk label", () => {
  function buildImpactGraph(dependentCount: number): {
    graph: ReturnType<typeof makePersistedGraph>;
    edgesByTarget: ReturnType<typeof makeEdgesByTarget>;
  } {
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {
      "src/target.ts": makeFileRecord({ importedByCount: dependentCount }),
    };
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < dependentCount; i++) {
      const name = `src/dep${i}.ts`;
      files[name] = makeFileRecord({});
      edges.push({ from: name, to: "src/target.ts" });
    }
    return { graph: makePersistedGraph({ files }), edgesByTarget: makeEdgesByTarget(edges) };
  }

  it("returns RISK: LOW when dependents equal MCP.RISK_LOW", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_LOW);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: LOW");
  });

  it("returns RISK: MEDIUM when dependents are one above MCP.RISK_LOW", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_LOW + 1);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: MEDIUM");
  });

  it("returns RISK: MEDIUM when dependents equal MCP.RISK_MEDIUM", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_MEDIUM);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: MEDIUM");
  });

  it("returns RISK: HIGH when dependents are one above MCP.RISK_MEDIUM", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_MEDIUM + 1);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: HIGH");
  });

  it("returns RISK: HIGH when dependents equal MCP.RISK_HIGH", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_HIGH);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: HIGH");
  });

  it("returns RISK: CRITICAL when dependents exceed MCP.RISK_HIGH", () => {
    const { graph, edgesByTarget } = buildImpactGraph(MCP.RISK_HIGH + 1);
    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: CRITICAL");
  });
});

// ---------------------------------------------------------------------------
// MCP.IMPACT_CAP — BFS is capped and CRITICAL label is used when cap exceeded
// ---------------------------------------------------------------------------

describe("MCP.IMPACT_CAP caps BFS in formatImpact", () => {
  it("shows CRITICAL with '... first N' when dependent count exceeds IMPACT_CAP", () => {
    // Build IMPACT_CAP + 2 dependents so BFS must be capped.
    const dependentCount = MCP.IMPACT_CAP + 2;
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {
      "src/target.ts": makeFileRecord({ importedByCount: dependentCount }),
    };
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < dependentCount; i++) {
      const name = `src/dep${i}.ts`;
      files[name] = makeFileRecord({});
      edges.push({ from: name, to: "src/target.ts" });
    }
    const graph = makePersistedGraph({ files });
    const edgesByTarget = makeEdgesByTarget(edges);

    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("RISK: CRITICAL");
    expect(text).toContain(`showing first ${MCP.IMPACT_CAP}`);
  });
});

// ---------------------------------------------------------------------------
// MCP.DISPLAY_PER_DEPTH — truncates files listed per depth level
// ---------------------------------------------------------------------------

describe("MCP.DISPLAY_PER_DEPTH truncates depth-level listings in formatImpact", () => {
  it("appends '... N more' when a depth level has more files than DISPLAY_PER_DEPTH", () => {
    const extraCount = MCP.DISPLAY_PER_DEPTH + 3;
    // Keep total under IMPACT_CAP so truncation is from DISPLAY_PER_DEPTH, not the cap.
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {
      "src/target.ts": makeFileRecord({ importedByCount: extraCount }),
    };
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < extraCount; i++) {
      const name = `src/dep${i}.ts`;
      files[name] = makeFileRecord({});
      edges.push({ from: name, to: "src/target.ts" });
    }
    const graph = makePersistedGraph({ files });
    const edgesByTarget = makeEdgesByTarget(edges);

    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).toContain("... (3 more)");
  });

  it("does not append more-suffix when files at a depth fit within DISPLAY_PER_DEPTH", () => {
    const count = MCP.DISPLAY_PER_DEPTH;
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {
      "src/target.ts": makeFileRecord({ importedByCount: count }),
    };
    const edges: Array<{ from: string; to: string }> = [];
    for (let i = 0; i < count; i++) {
      const name = `src/dep${i}.ts`;
      files[name] = makeFileRecord({});
      edges.push({ from: name, to: "src/target.ts" });
    }
    const graph = makePersistedGraph({ files });
    const edgesByTarget = makeEdgesByTarget(edges);

    const text = formatImpact("src/target.ts", graph, edgesByTarget);
    expect(text).not.toContain("more)");
  });
});

// ---------------------------------------------------------------------------
// MCP.DISPLAY_CALLERS — truncates caller/callee listings in formatFunction
// ---------------------------------------------------------------------------

describe("MCP.DISPLAY_CALLERS truncates caller/callee listings in formatFunction", () => {
  function makeSites(callerCount: number): CallSite[] {
    return Array.from({ length: callerCount }, (_, i) => ({
      caller: `src/caller${i}.ts`,
      callerFn: `fn${i}`,
      callee: "myFn",
      calleeFile: "src/target.ts",
      line: i + 1,
    }));
  }

  it("does not truncate when callers fit within DISPLAY_CALLERS", () => {
    const sites = makeSites(MCP.DISPLAY_CALLERS);
    const callerIndex = new Map<string, CallSite[]>();
    callerIndex.set("src/target.ts::myFn", sites);
    const fileCallIndex = new Map<string, CallSite[]>();

    const text = formatFunction("myFn", "src/target.ts", callerIndex, fileCallIndex);
    expect(text).not.toContain("more)");
  });

  it("appends truncation suffix when callers exceed DISPLAY_CALLERS", () => {
    const extra = 3;
    const sites = makeSites(MCP.DISPLAY_CALLERS + extra);
    const callerIndex = new Map<string, CallSite[]>();
    callerIndex.set("src/target.ts::myFn", sites);
    const fileCallIndex = new Map<string, CallSite[]>();

    const text = formatFunction("myFn", "src/target.ts", callerIndex, fileCallIndex);
    expect(text).toContain(`(${extra} more)`);
  });
});

// ---------------------------------------------------------------------------
// Range validation for all algorithm parameters
// ---------------------------------------------------------------------------

describe("thresholds: range validation", () => {
  describe("HITS parameters", () => {
    it.each([
      ["TELEPORT_ALPHA", HITS.TELEPORT_ALPHA, 0, 1],
      ["TYPE_ONLY_DISCOUNT", HITS.TYPE_ONLY_DISCOUNT, 0, 1],
      ["DYNAMIC_MULTIPLIER", HITS.DYNAMIC_MULTIPLIER, 0, 1],
      ["MIN_SPECIFICITY", HITS.MIN_SPECIFICITY, 0, 1],
      ["SPECIFICITY_LOG_BASE", HITS.SPECIFICITY_LOG_BASE, 2, 20],
      ["BARREL_DISCOUNT", HITS.BARREL_DISCOUNT, 0, 1],
      ["MAX_ITERATIONS", HITS.MAX_ITERATIONS, 1, 1000],
      ["EPSILON", HITS.EPSILON, 0, 0.01],
    ] as const)("%s = %s is in (%s, %s)", (_name, value, min, max) => {
      expect(value).toBeGreaterThan(min);
      expect(value).toBeLessThan(max);
    });

    it("TELEPORT_ALPHA ensures convergence (< 0.5)", () => {
      expect(HITS.TELEPORT_ALPHA).toBeLessThan(0.5);
    });

    it("EPSILON is small enough for meaningful convergence", () => {
      expect(HITS.EPSILON).toBeLessThanOrEqual(1e-4);
    });
  });

  describe("ROLE_THRESHOLDS", () => {
    it.each([
      ["FOUNDATION_AUTH", ROLE_THRESHOLDS.FOUNDATION_AUTH, 0, 1],
      ["FOUNDATION_HUB_MAX", ROLE_THRESHOLDS.FOUNDATION_HUB_MAX, 0, 1],
      ["ORCHESTRATOR_HUB", ROLE_THRESHOLDS.ORCHESTRATOR_HUB, 0, 1],
      ["ORCHESTRATOR_AUTH_MAX", ROLE_THRESHOLDS.ORCHESTRATOR_AUTH_MAX, 0, 1],
      ["BRIDGE_MIN", ROLE_THRESHOLDS.BRIDGE_MIN, 0, 1],
      ["UTILITY_AUTH_MIN", ROLE_THRESHOLDS.UTILITY_AUTH_MIN, 0, 1],
      ["UTILITY_AUTH_MAX", ROLE_THRESHOLDS.UTILITY_AUTH_MAX, 0, 1],
      ["UTILITY_HUB_MAX", ROLE_THRESHOLDS.UTILITY_HUB_MAX, 0, 1],
    ] as const)("%s = %s is in (%s, %s)", (_name, value, min, max) => {
      expect(value).toBeGreaterThan(min);
      expect(value).toBeLessThan(max);
    });

    it("Foundation auth > Utility auth max (non-overlapping)", () => {
      expect(ROLE_THRESHOLDS.FOUNDATION_AUTH).toBeGreaterThanOrEqual(ROLE_THRESHOLDS.UTILITY_AUTH_MAX);
    });

    it("Utility auth range is valid (min < max)", () => {
      expect(ROLE_THRESHOLDS.UTILITY_AUTH_MIN).toBeLessThan(ROLE_THRESHOLDS.UTILITY_AUTH_MAX);
    });

    it("Orchestrator and Foundation are symmetric opposites", () => {
      expect(ROLE_THRESHOLDS.FOUNDATION_AUTH).toBe(ROLE_THRESHOLDS.ORCHESTRATOR_HUB);
      expect(ROLE_THRESHOLDS.FOUNDATION_HUB_MAX).toBe(ROLE_THRESHOLDS.ORCHESTRATOR_AUTH_MAX);
    });
  });

  describe("scalar thresholds", () => {
    it.each([
      ["BARREL_THRESHOLD", BARREL_THRESHOLD, 0, 1],
      ["MAJORITY_THRESHOLD", MAJORITY_THRESHOLD, 0, 1],
      ["STRONG_MAJORITY_THRESHOLD", STRONG_MAJORITY_THRESHOLD, 0, 1],
      ["INSTABILITY_TYPE_ONLY_WEIGHT", INSTABILITY_TYPE_ONLY_WEIGHT, 0, 1],
      ["INSTABILITY_THRESHOLD", INSTABILITY_THRESHOLD, 0, 1],
      ["DIFF_COUPLING_THRESHOLD", DIFF_COUPLING_THRESHOLD, 0, 1],
    ] as const)("%s = %s is in (%s, %s)", (_name, value, min, max) => {
      expect(value).toBeGreaterThan(min);
      expect(value).toBeLessThan(max);
    });

    it("STRONG_MAJORITY_THRESHOLD > MAJORITY_THRESHOLD", () => {
      expect(STRONG_MAJORITY_THRESHOLD).toBeGreaterThan(MAJORITY_THRESHOLD);
    });
  });

  describe("integer thresholds", () => {
    it("HASH_CONCURRENCY is a positive integer", () => {
      expect(HASH_CONCURRENCY).toBeGreaterThan(0);
      expect(Number.isInteger(HASH_CONCURRENCY)).toBe(true);
    });

    it("BETWEENNESS_K is a positive integer", () => {
      expect(BETWEENNESS_K).toBeGreaterThan(0);
      expect(Number.isInteger(BETWEENNESS_K)).toBe(true);
    });
  });

  describe("LAYER_CONSISTENCY", () => {
    it("MIN_LAYERS_FOR_SCORING >= 2", () => {
      expect(LAYER_CONSISTENCY.MIN_LAYERS_FOR_SCORING).toBeGreaterThanOrEqual(2);
    });

    it("MIN_SKIP_DISTANCE >= 2", () => {
      expect(LAYER_CONSISTENCY.MIN_SKIP_DISTANCE).toBeGreaterThanOrEqual(2);
    });
  });

  describe("SNAPSHOT_LANGUAGES", () => {
    it("contains core languages", () => {
      for (const lang of ["typescript", "javascript", "python", "go", "rust", "java"]) {
        expect(SNAPSHOT_LANGUAGES.has(lang)).toBe(true);
      }
    });

    it("is non-empty", () => {
      expect(SNAPSHOT_LANGUAGES.size).toBeGreaterThan(0);
    });
  });

  describe("GRAPH_DATA", () => {
    it("MAX_INTEGRATION_TESTS is a positive integer", () => {
      expect(GRAPH_DATA.MAX_INTEGRATION_TESTS).toBeGreaterThan(0);
      expect(Number.isInteger(GRAPH_DATA.MAX_INTEGRATION_TESTS)).toBe(true);
    });

    it("MAX_COCHANGE is a positive integer", () => {
      expect(GRAPH_DATA.MAX_COCHANGE).toBeGreaterThan(0);
      expect(Number.isInteger(GRAPH_DATA.MAX_COCHANGE)).toBe(true);
    });

    it("MAX_BFS_DEPTH is a positive integer", () => {
      expect(GRAPH_DATA.MAX_BFS_DEPTH).toBeGreaterThan(0);
      expect(Number.isInteger(GRAPH_DATA.MAX_BFS_DEPTH)).toBe(true);
    });
  });
});
