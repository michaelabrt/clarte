/**
 * Hono BM25F retrieval evaluation (Phase 3 of adversarial audit).
 *
 * Builds a real Hono import graph and runs resolveEditTargets for three
 * benchmark tasks where clarte underperformed or had insufficient evidence:
 *
 * 1. JWT (#4119): middleware/jwt/jwt.ts vs utils/jwt/jwt.ts path confusion
 * 2. JSX async context (#4582): context lost after await in async component
 * 3. Form validator (PR #4753): prototype pollution in parseBody
 *
 * Requires:
 *   git clone --depth=1 https://github.com/honojs/hono.git /tmp/clarte-test-hono
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/hono-retrieval-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../core/graph/build.js";
import { resolveEditTargets, tokenizeQuery } from "../../steer/targets-resolve.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../core/types/persisted-graph.js";
import type { ImportGraph } from "../../core/types.js";
import { initTreeSitter } from "../../core/parsers/init.js";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const HONO_DIR = "/tmp/clarte-test-hono";

// ── Benchmark tasks ──────────────────────────────────────────────────────

interface RetrievalTask {
  name: string;
  query: string;
  groundTruth: string[];
  /** Files that are known decoys (path-similar but wrong). */
  decoys?: string[];
}

const TASKS: RetrievalTask[] = [
  {
    name: "jwt-jwk-alg-fallback",
    query:
      "JWT signature verification fails when using JWKS keys from providers like Microsoft Entra ID. The tokens are valid RS256 JWTs and the JWKS endpoint returns the correct keys, but verification rejects them",
    groundTruth: ["src/middleware/jwt/jwt.ts"],
    decoys: ["src/utils/jwt/jwt.ts"],
  },
  {
    name: "jsx-async-context-loss",
    query:
      "When an async parent component awaits a promise before rendering children with the html template helper, child components that call useContext get the default value instead of the provided value",
    groundTruth: ["src/jsx/context.ts"],
  },
  {
    name: "form-validator-prototype-pollution",
    query:
      "Form data parsing returns incorrect values when form fields have names that collide with Object prototype properties like toString. The parsed form object contains unexpected null values mixed with the submitted data",
    groundTruth: ["src/validator/validator.ts"],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────────

/** Build a minimal PersistedGraph from an ImportGraph (no full analysis needed). */
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

/** Reciprocal rank: 1/rank of first correct result, or 0 if not found. */
function reciprocalRank(results: string[], expected: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expected.includes(results[i] ?? "")) return 1 / (i + 1);
  }
  return 0;
}

// ── Test suite ───────────────────────────────────────────────────────────

describe.skipIf(SKIP)("Hono BM25F retrieval evaluation", () => {
  let importGraph: ImportGraph;
  let graph: PersistedGraph;

  beforeAll(async () => {
    if (!existsSync(HONO_DIR)) {
      throw new Error(`Hono not cloned. Run: git clone --depth=1 https://github.com/honojs/hono.git ${HONO_DIR}`);
    }
    await initTreeSitter();
    importGraph = await buildImportGraph(HONO_DIR, "typescript");
    graph = toPersistedGraph(importGraph);
  }, 120_000);

  // ── Structural analysis ──────────────────────────────────────────────

  it("structural overview: file count, edge count, path depth distribution", () => {
    const fileCount = Object.keys(graph.files).length;
    const edgeCount = graph.edges.length;

    // Path depth distribution
    const depths = Object.keys(graph.files).map((fp) => fp.split("/").length);
    const avgDepth = depths.reduce((a, b) => a + b, 0) / depths.length;
    const maxDepth = Math.max(...depths);

    // Files per top-level directory
    const topDirs = new Map<string, number>();
    for (const fp of Object.keys(graph.files)) {
      const parts = fp.split("/");
      const topDir = parts.length > 2 ? `${parts[0]}/${parts[1]}` : (parts[0] ?? "");
      topDirs.set(topDir, (topDirs.get(topDir) ?? 0) + 1);
    }

    console.log("\n=== Hono structural overview ===");
    console.log(`  Files: ${fileCount}`);
    console.log(`  Edges: ${edgeCount}`);
    console.log(`  Avg path depth: ${avgDepth.toFixed(1)}`);
    console.log(`  Max path depth: ${maxDepth}`);
    console.log("\n  Top-level directories:");
    for (const [dir, count] of [...topDirs.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15)) {
      console.log(`    ${count.toString().padStart(3)} ${dir}`);
    }

    expect(fileCount).toBeGreaterThan(100);
  });

  it("path-similarity analysis: files sharing basename tokens", () => {
    const filesByBasename = new Map<string, string[]>();
    for (const fp of Object.keys(graph.files)) {
      const basename = (fp.split("/").pop() ?? "").replace(/\.[jt]sx?$/, "");
      const tokens = basename.toLowerCase().split(/[-_./]/);
      for (const tok of tokens) {
        if (tok.length < 2) continue;
        if (!filesByBasename.has(tok)) filesByBasename.set(tok, []);
        filesByBasename.get(tok)?.push(fp);
      }
    }

    // Find tokens with most ambiguity
    const ambiguous = [...filesByBasename.entries()]
      .filter(([, files]) => files.length > 3)
      .sort((a, b) => b[1].length - a[1].length)
      .slice(0, 10);

    console.log("\n=== Path token ambiguity ===");
    for (const [token, files] of ambiguous) {
      console.log(`  "${token}" appears in ${files.length} files:`);
      for (const f of files.slice(0, 5)) {
        console.log(`    ${f}`);
      }
      if (files.length > 5) console.log(`    ... and ${files.length - 5} more`);
    }

    // Specific JWT ambiguity check
    const jwtFiles = Object.keys(graph.files).filter((fp) => fp.includes("jwt") || fp.includes("jwk"));
    console.log(`\n  JWT/JWK files (${jwtFiles.length}):`);
    for (const f of jwtFiles) {
      const rec = graph.files[f];
      if (!rec) continue;
      console.log(
        `    ${f}  (betweenness=${rec.betweenness.toFixed(4)}, importedBy=${rec.importedByCount}, symbols=[${(rec.symbolNames ?? []).join(", ")}])`,
      );
    }
  });

  // ── Per-task retrieval evaluation ────────────────────────────────────

  for (const task of TASKS) {
    describe(task.name, () => {
      let results: string[];

      beforeAll(() => {
        results = resolveEditTargets(task.query, graph, 10);
      });

      it("ground truth file appears in top 10", () => {
        const found = task.groundTruth.filter((gt) => results.includes(gt));
        console.log(`\n=== ${task.name} ===`);
        console.log(`  Query: "${task.query.slice(0, 80)}..."`);
        console.log(`  Ground truth: ${task.groundTruth.join(", ")}`);
        console.log(`  Top 10 results:`);
        for (let i = 0; i < results.length; i++) {
          const r = results[i] ?? "";
          const isGT = task.groundTruth.includes(r) ? " <<<" : "";
          const isDecoy = task.decoys?.includes(r) ? " [DECOY]" : "";
          console.log(`    ${i + 1}. ${results[i]}${isGT}${isDecoy}`);
        }
        console.log(`  RR = ${reciprocalRank(results, task.groundTruth).toFixed(2)}`);

        expect(found.length).toBeGreaterThan(0);
      });

      it("ground truth in top 5 (pre-flight threshold)", () => {
        const top5 = results.slice(0, 5);
        const found = task.groundTruth.some((gt) => top5.includes(gt));
        expect(found).toBe(true);
      });
    });
  }

  // ── Aggregate metrics ────────────────────────────────────────────────

  it("aggregate MRR across all tasks", () => {
    let totalRR = 0;
    for (const task of TASKS) {
      const results = resolveEditTargets(task.query, graph, 10);
      totalRR += reciprocalRank(results, task.groundTruth);
    }
    const mrr = totalRR / TASKS.length;
    console.log(`\n=== Aggregate MRR: ${mrr.toFixed(3)} ===`);
    expect(mrr).toBeGreaterThanOrEqual(0.33); // At least all in top 3 on average
  });

  // ── Token analysis (diagnostic) ─────────────────────────────────────

  it("diagnostic: query token overlap with ground truth vs decoys", () => {
    console.log("\n=== Token overlap analysis ===");
    for (const task of TASKS) {
      const queryTokens = tokenizeQuery(task.query);
      console.log(`\n  ${task.name}:`);
      console.log(`    Query tokens: [${queryTokens.join(", ")}]`);

      for (const gt of task.groundTruth) {
        const rec = graph.files[gt];
        if (!rec) {
          console.log(`    Ground truth ${gt}: NOT IN GRAPH`);
          continue;
        }
        const pathTokens = gt
          .toLowerCase()
          .split(/[/._-]/)
          .filter((t) => t.length >= 2);
        const symbolTokens = (rec.symbolNames ?? []).flatMap((s) =>
          s
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/\s+/),
        );
        const pathOverlap = queryTokens.filter((qt) => pathTokens.includes(qt));
        const symbolOverlap = queryTokens.filter((qt) => symbolTokens.some((st) => st.includes(qt)));
        console.log(`    ${gt}:`);
        console.log(`      Path tokens: [${pathTokens.join(", ")}]`);
        console.log(
          `      Symbol tokens: [${symbolTokens.slice(0, 10).join(", ")}${symbolTokens.length > 10 ? "..." : ""}]`,
        );
        console.log(`      Path overlap: [${pathOverlap.join(", ")}]`);
        console.log(`      Symbol overlap: [${symbolOverlap.join(", ")}]`);
      }

      for (const decoy of task.decoys ?? []) {
        const rec = graph.files[decoy];
        if (!rec) continue;
        const pathTokens = decoy
          .toLowerCase()
          .split(/[/._-]/)
          .filter((t) => t.length >= 2);
        const symbolTokens = (rec.symbolNames ?? []).flatMap((s) =>
          s
            .replace(/([a-z])([A-Z])/g, "$1 $2")
            .toLowerCase()
            .split(/\s+/),
        );
        const pathOverlap = queryTokens.filter((qt) => pathTokens.includes(qt));
        const symbolOverlap = queryTokens.filter((qt) => symbolTokens.some((st) => st.includes(qt)));
        console.log(`    ${decoy} [DECOY]:`);
        console.log(`      Path tokens: [${pathTokens.join(", ")}]`);
        console.log(
          `      Symbol tokens: [${symbolTokens.slice(0, 10).join(", ")}${symbolTokens.length > 10 ? "..." : ""}]`,
        );
        console.log(`      Path overlap: [${pathOverlap.join(", ")}]`);
        console.log(`      Symbol overlap: [${symbolOverlap.join(", ")}]`);
      }
    }
  });
});
