/**
 * TypeORM BM25F retrieval evaluation (Phase 3 regression check).
 *
 * Validates that BM25F changes for Hono don't regress the TypeORM benchmark
 * where pre-flight already beats placebo by -66% turns, -71% cost.
 *
 * Task: SQLite simple-enum array (issue #6326, fix PR #11865)
 * Ground truth: 3 source files changed in the fix.
 *
 * Requires:
 *   git clone --depth=1 https://github.com/typeorm/typeorm.git /tmp/clarte-test-typeorm
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/typeorm-retrieval-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../core/graph/build";
import { resolveEditTargets } from "../../steer/targets-resolve";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../core/types/persisted-graph";
import type { ImportGraph } from "../../core/types";
import { initTreeSitter } from "../../core/parsers/init";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const TYPEORM_DIR = "/tmp/clarte-test-typeorm";

const GROUND_TRUTH = [
  "src/driver/sqlite-abstract/AbstractSqliteDriver.ts",
  "src/driver/sqlite-abstract/AbstractSqliteQueryRunner.ts",
  "src/util/DateUtils.ts",
];

const QUERY =
  "CHECK constraint fails when inserting records with simple-enum array columns in SQLite. The enum values are valid but SQLite rejects the INSERT with a constraint violation";

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
    if (expected.includes(results[i] ?? "")) return 1 / (i + 1);
  }
  return 0;
}

function recallAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  const found = expected.filter((e) => topK.includes(e)).length;
  return found / expected.length;
}

describe.skipIf(SKIP)("TypeORM BM25F retrieval evaluation", () => {
  let graph: PersistedGraph;

  beforeAll(async () => {
    if (!existsSync(TYPEORM_DIR)) {
      throw new Error(
        `TypeORM not cloned. Run: git clone --depth=1 https://github.com/typeorm/typeorm.git ${TYPEORM_DIR}`,
      );
    }
    await initTreeSitter();
    const importGraph = await buildImportGraph(TYPEORM_DIR, "typescript");
    graph = toPersistedGraph(importGraph);
  }, 180_000);

  it("structural overview", () => {
    const fileCount = Object.keys(graph.files).length;
    const edgeCount = graph.edges.length;
    console.log(`\n=== TypeORM: ${fileCount} files, ${edgeCount} edges ===`);
    expect(fileCount).toBeGreaterThan(100);
  });

  it("ground truth files exist in graph", () => {
    for (const gt of GROUND_TRUTH) {
      expect(graph.files[gt], `${gt} should be in graph`).toBeDefined();
    }
  });

  it("at least 1 ground truth in top 5 (pre-flight threshold)", () => {
    const results = resolveEditTargets(QUERY, graph, 10);
    console.log(`\n=== TypeORM SQLite enum ===`);
    console.log(`  Query: "${QUERY.slice(0, 80)}..."`);
    console.log(`  Ground truth: ${GROUND_TRUTH.join(", ")}`);
    console.log(`  Top 10 results:`);
    for (let i = 0; i < results.length; i++) {
      const isGT = GROUND_TRUTH.includes(results[i] ?? "") ? " <<<" : "";
      console.log(`    ${i + 1}. ${results[i]}${isGT}`);
    }
    const rr = reciprocalRank(results, GROUND_TRUTH);
    const recall5 = recallAtK(results, GROUND_TRUTH, 5);
    console.log(`  RR = ${rr.toFixed(2)}, Recall@5 = ${recall5.toFixed(2)}`);

    expect(recall5).toBeGreaterThan(0);
  });

  it("MRR >= 0.2 (regression guard)", () => {
    const results = resolveEditTargets(QUERY, graph, 10);
    const rr = reciprocalRank(results, GROUND_TRUTH);
    expect(rr).toBeGreaterThanOrEqual(0.2);
  });
});
