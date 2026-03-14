/**
 * Rust (ripgrep) BM25F retrieval evaluation.
 *
 * Validates that BM25F retrieval works for Rust codebases with module-based
 * imports (use statements). ripgrep is ~300 Rust files with focused domain
 * (recursive file search).
 *
 * Requires:
 *   git clone --depth=1 https://github.com/BurntSushi/ripgrep.git /tmp/clarte-test-ripgrep
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/rust-retrieval-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../graph/build.js";
import { resolveEditTargets } from "../../cli/resolve-targets.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../types/persisted-graph.js";
import type { ImportGraph } from "../../types.js";
import { initTreeSitter } from "../../parsers/init.js";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const RIPGREP_DIR = "/tmp/clarte-test-ripgrep";

interface RetrievalTask {
  name: string;
  query: string;
  groundTruth: string[];
}

const TASKS: RetrievalTask[] = [
  {
    name: "glob-pattern-negation",
    query:
      "The --glob flag does not correctly handle negation patterns. Using --glob '!*.log' still includes .log files in the search results instead of excluding them",
    groundTruth: ["crates/core/flags/hiargs.rs"],
  },
  {
    name: "binary-file-detection",
    query:
      "ripgrep incorrectly treats UTF-16 encoded files as binary and skips them. Files with BOM markers are not detected as text files even when they contain searchable content",
    groundTruth: ["crates/searcher/src/searcher/mod.rs"],
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

describe.skipIf(SKIP)("Rust (ripgrep) BM25F retrieval evaluation", () => {
  let graph: PersistedGraph;

  beforeAll(async () => {
    if (!existsSync(RIPGREP_DIR)) {
      throw new Error(
        `ripgrep not cloned. Run: git clone --depth=1 https://github.com/BurntSushi/ripgrep.git ${RIPGREP_DIR}`,
      );
    }
    await initTreeSitter();
    const importGraph = await buildImportGraph(RIPGREP_DIR, "rust");
    graph = toPersistedGraph(importGraph);
  }, 120_000);

  it("structural overview", () => {
    const fileCount = Object.keys(graph.files).length;
    const edgeCount = graph.edges.length;
    console.log(`\n=== ripgrep (Rust): ${fileCount} files, ${edgeCount} edges ===`);
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
