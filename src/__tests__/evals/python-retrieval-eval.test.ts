/**
 * Python (Flask) BM25F retrieval evaluation.
 *
 * Validates that BM25F retrieval works for Python codebases with module-based
 * imports. Flask is a well-known micro-framework (~50 Python source files)
 * with a clear module layout.
 *
 * Requires:
 *   git clone --depth=1 https://github.com/pallets/flask.git /tmp/clarte-test-flask
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/python-retrieval-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../core/graph/build.js";
import { resolveEditTargets } from "../../steer/targets-resolve.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../core/types/persisted-graph.js";
import type { ImportGraph } from "../../core/types.js";
import { initTreeSitter } from "../../core/parsers/init.js";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const FLASK_DIR = "/tmp/clarte-test-flask";

interface RetrievalTask {
  name: string;
  query: string;
  groundTruth: string[];
}

const TASKS: RetrievalTask[] = [
  {
    name: "session-cookie-secure-flag",
    query:
      "Session cookie is sent without the Secure flag even when SESSION_COOKIE_SECURE is set to True in the config. The Set-Cookie header is missing the Secure attribute on HTTPS responses",
    groundTruth: ["src/flask/sessions.py"],
  },
  {
    name: "blueprint-error-handler",
    query:
      "Error handlers registered on a Blueprint are not called when an exception is raised in a route belonging to that blueprint. The app-level error handler catches it instead",
    groundTruth: ["src/flask/app.py"],
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

describe.skipIf(SKIP)("Python (Flask) BM25F retrieval evaluation", () => {
  let graph: PersistedGraph;

  beforeAll(async () => {
    if (!existsSync(FLASK_DIR)) {
      throw new Error(`Flask not cloned. Run: git clone --depth=1 https://github.com/pallets/flask.git ${FLASK_DIR}`);
    }
    await initTreeSitter();
    const importGraph = await buildImportGraph(FLASK_DIR, "python");
    graph = toPersistedGraph(importGraph);
  }, 120_000);

  it("structural overview", () => {
    const fileCount = Object.keys(graph.files).length;
    const edgeCount = graph.edges.length;
    console.log(`\n=== Flask (Python): ${fileCount} files, ${edgeCount} edges ===`);
    expect(fileCount).toBeGreaterThan(5);
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
