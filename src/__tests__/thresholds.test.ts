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
import { FRAGMENT_MIN_SIZE, MCP } from "../config/thresholds.js";
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
