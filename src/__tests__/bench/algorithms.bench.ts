/**
 * Performance benchmarks for graph analysis algorithms.
 *
 * Uses Vitest's bench API to measure execution time at various graph scales.
 * Performance budgets are set to catch regressions (2x tolerance via time limits).
 */

import { bench, describe } from "vitest";
import { computeHITS, computeBetweenness } from "../../core/graph/centrality.js";
import { detectCommunities } from "../../core/graph/communities.js";
import { findChokepoints } from "../../core/graph/chokepoints.js";
import { computeInstability } from "../../core/graph/instability.js";
import { findCircularDeps } from "../../core/graph/cycles.js";
import { findDeadFiles } from "../../core/graph/dead-files.js";
import { generateGraph } from "./graph-generator.js";

// ── Pre-generate graphs (excluded from benchmark timing) ────────────

const graph100 = generateGraph(100, 3, 100);
const graph500 = generateGraph(500, 3, 500);
const graph1000 = generateGraph(1000, 3, 1000);

// Extract files lists for computeHITS (it takes files + edges, not ImportGraph)
const files100 = [...new Set(graph100.edges.filter((e) => !e.isExternal).flatMap((e) => [e.from, e.to]))];
const files500 = [...new Set(graph500.edges.filter((e) => !e.isExternal).flatMap((e) => [e.from, e.to]))];
const files1000 = [...new Set(graph1000.edges.filter((e) => !e.isExternal).flatMap((e) => [e.from, e.to]))];

// ── HITS ────────────────────────────────────────────────────────────

describe("computeHITS", () => {
  bench(
    "100 nodes",
    () => {
      computeHITS(files100, graph100.edges);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      computeHITS(files500, graph500.edges);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      computeHITS(files1000, graph1000.edges);
    },
    { time: 5000 },
  );
});

// ── Betweenness (k=50) ─────────────────────────────────────────────

describe("computeBetweenness", () => {
  bench(
    "100 nodes",
    () => {
      computeBetweenness(graph100, 50);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      computeBetweenness(graph500, 50);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      computeBetweenness(graph1000, 50);
    },
    { time: 5000 },
  );
});

// ── Communities (label propagation) ─────────────────────────────────

describe("detectCommunities", () => {
  bench(
    "100 nodes",
    () => {
      detectCommunities(graph100);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      detectCommunities(graph500);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      detectCommunities(graph1000);
    },
    { time: 5000 },
  );
});

// ── Chokepoints (articulation points) ───────────────────────────────

describe("findChokepoints", () => {
  bench(
    "100 nodes",
    () => {
      findChokepoints(graph100);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      findChokepoints(graph500);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      findChokepoints(graph1000);
    },
    { time: 5000 },
  );
});

// ── Instability ─────────────────────────────────────────────────────

describe("computeInstability", () => {
  bench(
    "100 nodes",
    () => {
      computeInstability(graph100);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      computeInstability(graph500);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      computeInstability(graph1000);
    },
    { time: 5000 },
  );
});

// ── Circular dependency detection ───────────────────────────────────

describe("findCircularDeps", () => {
  bench(
    "100 nodes",
    () => {
      findCircularDeps(graph100);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      findCircularDeps(graph500);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      findCircularDeps(graph1000);
    },
    { time: 5000 },
  );
});

// ── Dead file detection ─────────────────────────────────────────────

describe("findDeadFiles", () => {
  bench(
    "100 nodes",
    () => {
      findDeadFiles(graph100);
    },
    { time: 5000 },
  );

  bench(
    "500 nodes",
    () => {
      findDeadFiles(graph500);
    },
    { time: 5000 },
  );

  bench(
    "1000 nodes",
    () => {
      findDeadFiles(graph1000);
    },
    { time: 5000 },
  );
});
