/**
 * Hono query-robustness replication (adversarial audit 5.1).
 *
 * Each of the 3 Hono benchmark tasks gets 5 paraphrased queries (n=5).
 * Measures per-task MRR stability across paraphrases and overall effect
 * size vs random baseline. Addresses the n=1 gap flagged in the audit.
 *
 * Requires:
 *   git clone --depth=1 https://github.com/honojs/hono.git /tmp/clarte-test-hono
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/hono-replication-eval.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../core/graph/build";
import { resolveEditTargets } from "../../steer/targets-resolve";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph, type FileRecord } from "../../core/types/persisted-graph";
import type { ImportGraph } from "../../core/types";
import { initTreeSitter } from "../../core/parsers/init";

const SKIP = !process.env.REAL_PROJECT_EVAL;
const HONO_DIR = "/tmp/clarte-test-hono";

// ── Paraphrased queries per task ──────────────────────────────────────

interface ReplicationTask {
  name: string;
  groundTruth: string[];
  /** 5 distinct phrasings of the same bug. */
  queries: string[];
}

const TASKS: ReplicationTask[] = [
  {
    name: "jwt-jwk-alg-fallback",
    groundTruth: ["src/middleware/jwt/jwt.ts"],
    queries: [
      // Q1: original
      "JWT signature verification fails when using JWKS keys from providers like Microsoft Entra ID. The tokens are valid RS256 JWTs and the JWKS endpoint returns the correct keys, but verification rejects them",
      // Q2: user-perspective, minimal jargon
      "Login tokens from Azure AD are rejected even though they work in jwt.io. The JWKS key fetch succeeds but the middleware still returns 401",
      // Q3: developer-perspective, code-level
      "The jwt middleware does not fall back to the alg field in the JWKS key when the JWT header alg is missing. RS256 tokens fail verification",
      // Q4: terse issue title style
      "JWT verify fails for JWKS keys without alg in header",
      // Q5: symptoms only, no root cause
      "Users get 401 Unauthorized on every request after switching identity provider. Bearer tokens are valid and not expired. Other frameworks accept the same tokens",
    ],
  },
  {
    name: "jsx-async-context-loss",
    groundTruth: ["src/jsx/context.ts"],
    queries: [
      // Q1: original
      "When an async parent component awaits a promise before rendering children with the html template helper, child components that call useContext get the default value instead of the provided value",
      // Q2: user-perspective
      "Context value is lost after await in async JSX component. Children render with default context instead of the value I provided",
      // Q3: developer-perspective
      "useContext returns stale default value when the parent component is async and uses await before the return. The context provider wraps children correctly",
      // Q4: terse
      "async component loses JSX context after await",
      // Q5: symptoms only
      "Child components show wrong data intermittently. It only happens when the parent does async work. Removing the await fixes it but we need the data fetch",
    ],
  },
  {
    name: "form-validator-prototype-pollution",
    groundTruth: ["src/validator/validator.ts"],
    queries: [
      // Q1: original
      "Form data parsing returns incorrect values when form fields have names that collide with Object prototype properties like toString. The parsed form object contains unexpected null values mixed with the submitted data",
      // Q2: user-perspective
      "Submitting a form with a field named 'constructor' or 'toString' breaks the validation. Some fields come back as null or [object Object]",
      // Q3: developer-perspective
      "The validator parseBody output includes prototype methods when form field names shadow Object.prototype. Needs hasOwnProperty guard or null-prototype object",
      // Q4: terse
      "form validator prototype pollution with __proto__ field names",
      // Q5: symptoms only
      "Random form submissions fail validation even though all fields are filled in correctly. Only happens with certain field names. The error message says required field is missing but it was sent",
    ],
  },
];

// ── Helpers ──────────────────────────────────────────────────────────

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

/** Standard deviation of a number array. */
function stddev(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

// ── Test suite ───────────────────────────────────────────────────────

describe.skipIf(SKIP)("Hono query-robustness replication (n=5 per task)", () => {
  let graph: PersistedGraph;
  let fileCount: number;

  beforeAll(async () => {
    if (!existsSync(HONO_DIR)) {
      throw new Error(`Hono not cloned. Run: git clone --depth=1 https://github.com/honojs/hono.git ${HONO_DIR}`);
    }
    await initTreeSitter();
    const importGraph = await buildImportGraph(HONO_DIR, "typescript");
    graph = toPersistedGraph(importGraph);
    fileCount = Object.keys(graph.files).length;
  }, 120_000);

  // ── Per-task replication ────────────────────────────────────────

  for (const task of TASKS) {
    describe(`${task.name} (n=${task.queries.length})`, () => {
      let rrValues: number[];

      beforeAll(() => {
        rrValues = task.queries.map((q) => {
          const results = resolveEditTargets(q, graph, 10);
          return reciprocalRank(results, task.groundTruth);
        });
      });

      it("all paraphrases find ground truth in top 10", () => {
        console.log(`\n=== ${task.name} replication ===`);
        for (let i = 0; i < task.queries.length; i++) {
          const q = task.queries[i] ?? "";
          const results = resolveEditTargets(q, graph, 10);
          const rank = results.findIndex((r) => task.groundTruth.includes(r)) + 1;
          const rr = rrValues[i] ?? 0;
          console.log(`  Q${i + 1}: RR=${rr.toFixed(2)} rank=${rank || ">10"}  "${q.slice(0, 60)}..."`);
        }
        // Allow at most 1 miss out of 5
        const hits = rrValues.filter((rr) => rr > 0).length;
        expect(hits).toBeGreaterThanOrEqual(4);
      });

      it("mean RR >= 0.25 across paraphrases", () => {
        const meanRR = rrValues.reduce((a, b) => a + b, 0) / rrValues.length;
        const sd = stddev(rrValues);
        console.log(`  ${task.name}: mean RR = ${meanRR.toFixed(3)}, sd = ${sd.toFixed(3)}`);
        expect(meanRR).toBeGreaterThanOrEqual(0.25);
      });

      it("low variance (sd < 0.4)", () => {
        const sd = stddev(rrValues);
        // sd < 0.4 means results are reasonably stable across phrasings
        expect(sd).toBeLessThan(0.4);
      });
    });
  }

  // ── Aggregate statistics ───────────────────────────────────────

  it("aggregate: mean MRR across all tasks and paraphrases", () => {
    const allRR: number[] = [];
    for (const task of TASKS) {
      for (const q of task.queries) {
        allRR.push(reciprocalRank(resolveEditTargets(q, graph, 10), task.groundTruth));
      }
    }
    const grandMRR = allRR.reduce((a, b) => a + b, 0) / allRR.length;
    const grandSD = stddev(allRR);

    // Random baseline: expected RR for uniform random selection from N files
    // E[RR] = (1/N) * sum(1/k for k=1..10) ≈ (1/N) * 2.93 for top-10
    const harmonicSum10 = Array.from({ length: 10 }, (_, i) => 1 / (i + 1)).reduce((a, b) => a + b, 0);
    const randomBaseline = harmonicSum10 / fileCount;
    const effectSize = grandMRR / randomBaseline;

    console.log("\n=== Replication summary ===");
    console.log(`  Total queries: ${allRR.length} (${TASKS.length} tasks x 5 paraphrases)`);
    console.log(`  Grand MRR: ${grandMRR.toFixed(3)} (sd=${grandSD.toFixed(3)})`);
    console.log(`  Random baseline MRR: ${randomBaseline.toFixed(5)} (${fileCount} files)`);
    console.log(`  Effect size (MRR / baseline): ${effectSize.toFixed(1)}x`);
    console.log(`  Hit rate (RR > 0): ${allRR.filter((rr) => rr > 0).length}/${allRR.length}`);

    // System should be at least 50x better than random
    expect(effectSize).toBeGreaterThan(50);
    expect(grandMRR).toBeGreaterThanOrEqual(0.3);
  });
});
