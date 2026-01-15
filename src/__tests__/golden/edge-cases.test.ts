/**
 * Edge-case golden tests for degenerate projects.
 * Verifies the analysis pipeline handles minimal/empty projects gracefully.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import { buildImportGraph } from "../../graph/build.js";
import { getHubFiles } from "../../graph/hub-files.js";
import { findCircularDeps } from "../../graph/cycles.js";
import { detectArchitecturalLayers } from "../../graph/layers.js";
import { computeInstability } from "../../graph/instability.js";
import { detectCommunities } from "../../graph/communities.js";
import { findDeadFiles } from "../../graph/dead-files.js";
import { computeGraphTopology } from "../../graph/topology.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

describe("edge-case: empty-project (no source files)", () => {
  it("produces an empty graph without crashing", async () => {
    const fixtureDir = path.join(FIXTURES_DIR, "empty-project");
    const graph = await buildImportGraph(fixtureDir, "typescript");

    expect(graph.edges).toHaveLength(0);
    expect(graph.inDegree.size).toBe(0);
  });

  it("all analysis functions return empty results on empty graph", async () => {
    const fixtureDir = path.join(FIXTURES_DIR, "empty-project");
    const graph = await buildImportGraph(fixtureDir, "typescript");

    expect(getHubFiles(graph, 10)).toHaveLength(0);
    expect(findCircularDeps(graph, 20)).toHaveLength(0);
    expect(detectArchitecturalLayers(graph).layers).toHaveLength(0);
    expect(computeInstability(graph)).toHaveLength(0);
    expect(detectCommunities(graph)).toHaveLength(0);
    expect(findDeadFiles(graph)).toHaveLength(0);
  });
});

describe("edge-case: single-file project", () => {
  it("produces a graph with one file and no edges", async () => {
    const fixtureDir = path.join(FIXTURES_DIR, "single-file");
    const graph = await buildImportGraph(fixtureDir, "typescript");

    expect(graph.inDegree.size).toBe(1);
    // No imports between files, so no internal edges
    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges).toHaveLength(0);
  });

  it("topology reports 0 components for edgeless graph", async () => {
    const fixtureDir = path.join(FIXTURES_DIR, "single-file");
    const graph = await buildImportGraph(fixtureDir, "typescript");

    // Topology is edge-based: a single node with no edges = 0 components
    const topology = computeGraphTopology(graph);
    expect(topology.componentCount).toBe(0);
    expect(topology.isFragmented).toBe(false);
  });

  it("dead-file detection returns empty for isolated file (no edges to analyze)", async () => {
    const fixtureDir = path.join(FIXTURES_DIR, "single-file");
    const graph = await buildImportGraph(fixtureDir, "typescript");

    // findDeadFiles checks files with no incoming edges in the edge graph;
    // a file with zero edges at all is not in the edge-derived sets
    const deadFiles = findDeadFiles(graph);
    expect(deadFiles).toHaveLength(0);
  });
});
