/**
 * Go (Gin) BM25F retrieval evaluation.
 *
 * Validates that BM25F retrieval works for Go codebases with package-based
 * import paths. Gin is a popular HTTP framework (~200 Go files) with clear
 * module boundaries.
 *
 * Requires:
 *   git clone --depth=1 https://github.com/gin-gonic/gin.git /tmp/clarte-test-gin
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/go-retrieval-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../graph/build.js";
import { resolveEditTargets } from "../../cli/resolve-targets.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../types/persisted-graph.js";
import type { ImportGraph } from "../../types.js";
import { initTreeSitter } from "../../parsers/init.js";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const GIN_DIR = "/tmp/clarte-test-gin";

interface RetrievalTask {
  name: string;
  query: string;
  groundTruth: string[];
}

const TASKS: RetrievalTask[] = [
  {
    name: "bind-json-validation",
    query:
      "JSON binding fails to validate required fields when using ShouldBindJSON. The struct has binding:required tags but empty fields pass validation without error",
    groundTruth: ["binding/json.go"],
  },
  {
    name: "router-redirect-trailing-slash",
    query:
      "Router returns 301 redirect for routes with trailing slash instead of matching the handler directly. RedirectTrailingSlash is enabled but the behavior is wrong for POST requests",
    groundTruth: ["tree.go"],
  },
];

function toPersistedGraph(graph: ImportGraph): PersistedGraph {
  const files: Record<string, FileRecord> = {};
  for (const [filePath, inDeg] of graph.inDegree) {
    const symbols = graph.symbolNames?.get(filePath);
    files[filePath] = {
      role: null,
      authority: graph.authority?.get(filePath) ?? 0,
      hubScore: graph.hubScores?.get(filePath) ?? 0,
      betweenness: graph.betweennessScores?.get(filePath) ?? 0,
      instability: null,
      importedByCount: inDeg,
      isChokepoint: false,
      separatesComponents: 0,
      isCrossCutting: false,
      layerSpread: 0,
      layers: [],
      hasTests: false,
      testFiles: [],
      communityId: null,
      ...(symbols && symbols.length > 0 && { symbolNames: symbols }),
    };
  }
  const edges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => ({
      from: e.from,
      to: e.to,
      importedNames: e.importedNames,
      ...(e.isTypeOnly && { isTypeOnly: true }),
    }));
  return {
    version: PERSISTED_GRAPH_VERSION,
    timestamp: new Date().toISOString(),
    files,
    edges,
    communities: [],
    changeCoupling: [],
    structuralMismatches: [],
    testMapping: {},
    lagCouplings: [],
  };
}

function reciprocalRank(results: string[], expected: string[]): number {
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r && expected.includes(r)) return 1 / (i + 1);
  }
  return 0;
}

describe.skipIf(SKIP)("Go (Gin) BM25F retrieval evaluation", () => {
  let graph: PersistedGraph;

  beforeAll(async () => {
    if (!existsSync(GIN_DIR)) {
      throw new Error(`Gin not cloned. Run: git clone --depth=1 https://github.com/gin-gonic/gin.git ${GIN_DIR}`);
    }
    await initTreeSitter();
    const importGraph = await buildImportGraph(GIN_DIR, "go");
    graph = toPersistedGraph(importGraph);
  }, 120_000);

  it("structural overview", () => {
    const fileCount = Object.keys(graph.files).length;
    const edgeCount = graph.edges.length;
    console.log(`\n=== Gin (Go): ${fileCount} files, ${edgeCount} edges ===`);
    expect(fileCount).toBeGreaterThan(10);
  });

  for (const task of TASKS) {
    it(`${task.name}: ground truth in top 10`, () => {
      const results = resolveEditTargets(task.query, graph, 10);
      console.log(`\n=== ${task.name} ===`);
      console.log(`  Top 10:`);
      for (let i = 0; i < results.length; i++) {
        const isGT = task.groundTruth.includes(results[i] ?? "") ? " <<<" : "";
        console.log(`    ${i + 1}. ${results[i]}${isGT}`);
      }
      const rr = reciprocalRank(results, task.groundTruth);
      console.log(`  RR = ${rr.toFixed(2)}`);
      expect(task.groundTruth.some((gt) => results.includes(gt))).toBe(true);
    });
  }

  it("aggregate MRR >= 0.2", () => {
    let totalRR = 0;
    for (const task of TASKS) {
      const results = resolveEditTargets(task.query, graph, 10);
      totalRR += reciprocalRank(results, task.groundTruth);
    }
    expect(totalRR / TASKS.length).toBeGreaterThanOrEqual(0.2);
  });
});
