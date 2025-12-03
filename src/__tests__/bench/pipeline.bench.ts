/**
 * Full pipeline benchmarks: graph construction through all analysis steps.
 *
 * Measures the combined cost of running every graph algorithm on
 * a single ImportGraph, simulating what happens during a real analysis run.
 */

import { bench, describe } from "vitest";
import {
  computeHITS,
  computeBetweenness,
  detectCommunities,
  findChokepoints,
  computeInstability,
  findCircularDeps,
  findDeadFiles,
  detectArchitecturalLayers,
  getHubFiles,
  findSCCs,
  findCrossCuttingFiles,
  computeLayerConsistency,
} from "../../graph.js";
import { generateGraph } from "./graph-generator.js";

// ── Pre-generate graphs ─────────────────────────────────────────────

const graph100 = generateGraph(100, 3, 200);
const graph500 = generateGraph(500, 3, 600);

/**
 * Run the full analysis pipeline on a given graph.
 * This mirrors the sequence in index.ts where all algorithms
 * are invoked on the import graph during context generation.
 */
function runFullPipeline(graph: ReturnType<typeof generateGraph>) {
  // Extract file list for HITS
  const files = [...new Set(graph.edges.filter((e) => !e.isExternal).flatMap((e) => [e.from, e.to]))];

  // 1. HITS centrality
  computeHITS(files, graph.edges);

  // 2. Betweenness centrality (sampled)
  computeBetweenness(graph, 50);

  // 3. Hub files
  getHubFiles(graph);

  // 4. Circular dependencies (SCC-based)
  findSCCs(graph);
  findCircularDeps(graph);

  // 5. Architectural layers and consistency
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  computeLayerConsistency(graph, layers, layerEdges);
  findCrossCuttingFiles(graph, layers);

  // 6. Community detection
  detectCommunities(graph);

  // 7. Chokepoints (articulation points)
  findChokepoints(graph);

  // 8. Instability
  computeInstability(graph);

  // 9. Dead files
  findDeadFiles(graph);
}

// ── Full pipeline benchmarks ────────────────────────────────────────

describe("full analysis pipeline", () => {
  bench(
    "100 nodes",
    () => {
      runFullPipeline(graph100);
    },
    { time: 10000 },
  );

  bench(
    "500 nodes",
    () => {
      runFullPipeline(graph500);
    },
    { time: 10000 },
  );
});
