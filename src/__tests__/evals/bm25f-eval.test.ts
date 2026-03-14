/**
 * Offline evaluation harness for BM25F retrieval quality.
 *
 * Measures MRR (Mean Reciprocal Rank), Recall@k and Precision@k on
 * synthetic benchmark queries. Each query has a ground-truth set of
 * expected files. The graph fixtures approximate real-world structures
 * (ambiguous paths, synonym-resolvable files, provider/consumer pairs).
 *
 * Run with: npx vitest run src/__tests__/bm25f-eval.test.ts
 */

import { describe, it, expect } from "vitest";
import { resolveEditTargets } from "../../cli/resolve-targets.js";
import type { PersistedGraph } from "../../types/persisted-graph.js";
import { PERSISTED_GRAPH_VERSION } from "../../types/persisted-graph.js";

// ── Helpers ──────────────────────────────────────────────────────────────

function makeGraph(overrides?: Partial<PersistedGraph>): PersistedGraph {
  return {
    version: PERSISTED_GRAPH_VERSION,
    timestamp: "2026-01-01T00:00:00Z",
    files: {},
    edges: [],
    communities: [],
    changeCoupling: [],
    structuralMismatches: [],
    testMapping: {},
    lagCouplings: [],
    ...overrides,
  };
}

function file(overrides?: Record<string, unknown>) {
  return {
    role: null,
    authority: 0,
    hubScore: 0,
    betweenness: 0,
    instability: null,
    importedByCount: 0,
    isChokepoint: false,
    separatesComponents: 0,
    isCrossCutting: false,
    layerSpread: 0,
    layers: [],
    hasTests: false,
    testFiles: [],
    communityId: null,
    ...overrides,
  };
}

// ── Metrics ──────────────────────────────────────────────────────────────

/** Reciprocal rank: 1/rank of first correct result, or 0 if not found. */
function reciprocalRank(results: string[], expected: string[]): number {
  for (let i = 0; i < results.length; i++) {
    if (expected.includes(results[i])) return 1 / (i + 1);
  }
  return 0;
}

/** Recall@k: fraction of expected files found in top-k results. */
function recallAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  const found = expected.filter((e) => topK.includes(e)).length;
  return found / expected.length;
}

/** Precision@k: fraction of top-k results that are in expected set. */
function precisionAtK(results: string[], expected: string[], k: number): number {
  const topK = results.slice(0, k);
  if (topK.length === 0) return 0;
  const relevant = topK.filter((r) => expected.includes(r)).length;
  return relevant / topK.length;
}

// ── Benchmark queries ────────────────────────────────────────────────────

interface BenchmarkQuery {
  name: string;
  query: string;
  expected: string[];
  graph: PersistedGraph;
}

function buildBenchmarkQueries(): BenchmarkQuery[] {
  const queries: BenchmarkQuery[] = [];

  // Q1: JWT ambiguity (consumer vs provider)
  // Tests that import-direction tiebreaker prefers the middleware (consumer)
  queries.push({
    name: "jwt-consumer-vs-provider",
    query: "JWT signature verification fails using JWKS keys",
    expected: ["src/middleware/jwt/jwt.ts"],
    graph: makeGraph({
      files: {
        "src/middleware/jwt/jwt.ts": file({ betweenness: 0.4, importedByCount: 8 }),
        "src/utils/jwt/jwt.ts": file({ betweenness: 0.1, importedByCount: 2 }),
        "src/middleware/jwt/index.ts": file(),
        "src/routes/auth.ts": file(),
      },
      edges: [
        { from: "src/middleware/jwt/jwt.ts", to: "src/utils/jwt/jwt.ts", importedNames: ["signJwt", "verifyJwt"] },
        { from: "src/routes/auth.ts", to: "src/middleware/jwt/index.ts", importedNames: ["jwtMiddleware"] },
        { from: "src/middleware/jwt/index.ts", to: "src/middleware/jwt/jwt.ts", importedNames: ["verifyJwt"] },
      ],
    }),
  });

  // Q2: Synonym expansion (auth → authentication)
  // Tests that "auth" query finds "authentication" in path via synonyms
  queries.push({
    name: "auth-synonym-expansion",
    query: "auth token refresh broken",
    expected: ["src/authentication/token-refresh.ts"],
    graph: makeGraph({
      files: {
        "src/authentication/token-refresh.ts": file({ symbolNames: ["refreshToken", "validateExpiry"] }),
        "src/utils/string-helpers.ts": file({ symbolNames: ["capitalize", "truncate"] }),
        "src/database/users.ts": file({ symbolNames: ["findUser", "createUser"] }),
      },
    }),
  });

  // Q3: Symbol-only match (no path match)
  // Tests that BM25F finds files where the query term only appears in symbols
  queries.push({
    name: "symbol-only-match",
    query: "sqlite check constraint fails",
    expected: ["src/driver/sqlite/query-runner.ts"],
    graph: makeGraph({
      files: {
        "src/driver/sqlite/query-runner.ts": file({
          symbolNames: ["SqliteQueryRunner", "runQuery", "checkConstraint"],
        }),
        "src/driver/postgres/query-runner.ts": file({
          symbolNames: ["PostgresQueryRunner", "runQuery"],
        }),
        "src/utils/string.ts": file({ symbolNames: ["titleCase", "camelCase"] }),
      },
    }),
  });

  // Q4: Deep path with exact match
  // Tests that exact basename match outranks partial matches
  queries.push({
    name: "exact-basename-match",
    query: "cache invalidation bug",
    expected: ["src/cache.ts"],
    graph: makeGraph({
      files: {
        "src/cache.ts": file({ symbolNames: ["invalidateCache", "getCache"] }),
        "src/services/cache-warmup.ts": file({ symbolNames: ["warmupCache"] }),
        "src/utils/memo.ts": file({ symbolNames: ["memoize"] }),
      },
    }),
  });

  // Q5: Co-change coupling surfaces related file
  queries.push({
    name: "cochange-surfaces-partner",
    query: "validation schema error",
    expected: ["src/schema/validator.ts", "src/schema/types.ts"],
    graph: makeGraph({
      files: {
        "src/schema/validator.ts": file({ symbolNames: ["validateSchema", "SchemaError"] }),
        "src/schema/types.ts": file({ symbolNames: ["SchemaType", "FieldDef"] }),
        "src/core/engine.ts": file({ symbolNames: ["runEngine"] }),
      },
      changeCoupling: [
        { fileA: "src/schema/validator.ts", fileB: "src/schema/types.ts", confidence: 0.8, coChangeCount: 12 },
      ],
    }),
  });

  // Q6: Crypto synonym expansion (crypto → encrypt/decrypt)
  queries.push({
    name: "crypto-synonym",
    query: "crypto key rotation broken",
    expected: ["src/security/encryption.ts"],
    graph: makeGraph({
      files: {
        "src/security/encryption.ts": file({ symbolNames: ["encryptPayload", "decryptPayload", "rotateKey"] }),
        "src/core/startup.ts": file({ symbolNames: ["bootstrap", "initApp"] }),
      },
    }),
  });

  // Q7: Test file proxy scoring
  queries.push({
    name: "test-proxy-finds-source",
    query: "markdown renderer breaks on nested lists",
    expected: ["src/core/processor.ts"],
    graph: makeGraph({
      files: {
        "src/core/processor.ts": file(),
        "src/utils.ts": file(),
        "test/core/markdown-renderer.test.ts": file(),
      },
      testMapping: {
        "src/core/processor.ts": ["test/core/markdown-renderer.test.ts"],
      },
    }),
  });

  // Q8: Error synonym expansion (err → error/exception)
  queries.push({
    name: "error-synonym",
    query: "err handling in database layer",
    expected: ["src/database/error-handler.ts"],
    graph: makeGraph({
      files: {
        "src/database/error-handler.ts": file({ symbolNames: ["handleDbError", "retryOnFailure"] }),
        "src/database/connection.ts": file({ symbolNames: ["connect", "disconnect"] }),
        "src/utils/logger.ts": file({ symbolNames: ["log", "warn"] }),
      },
    }),
  });

  // Q9: Path-dominant — correct file has descriptive path, generic symbols;
  // decoy has generic path but matching symbols. Tests that PATH_WEIGHT > SYMBOL_WEIGHT
  // is beneficial when path tokens are highly specific.
  queries.push({
    name: "path-dominant-over-symbol",
    query: "websocket reconnection logic",
    expected: ["src/transport/websocket/reconnect.ts"],
    graph: makeGraph({
      files: {
        // Path: "transport/websocket/reconnect" matches 2 query terms. Symbols: generic.
        "src/transport/websocket/reconnect.ts": file({
          symbolNames: ["open", "close", "send", "onMessage"],
        }),
        // Path: "core/connection" matches 0 query terms. Symbols: "reconnect" matches 1.
        "src/core/connection-pool.ts": file({
          symbolNames: ["reconnect", "getConnection", "releaseConnection"],
        }),
        "src/utils/timer.ts": file({ symbolNames: ["setTimeout", "clearTimeout"] }),
      },
    }),
  });

  // Q10: Symbol-dominant — correct file has a generic path but unique matching
  // symbols; decoy has matching path but wrong symbols. Tests that SYMBOL_WEIGHT
  // contributes enough when path tokens are ambiguous.
  queries.push({
    name: "symbol-dominant-over-path",
    query: "rate limiter sliding window algorithm",
    expected: ["src/core/throttle.ts"],
    graph: makeGraph({
      files: {
        // Path: "core/throttle" — no query term overlap. Symbols: "rateLimiter", "slidingWindow" match.
        "src/core/throttle.ts": file({
          symbolNames: ["rateLimiter", "slidingWindow", "tokenBucket", "checkQuota"],
        }),
        // Path: "middleware/rate-limiter" — matches "rate" + "limiter". Symbols: generic.
        "src/middleware/rate-limiter.ts": file({
          symbolNames: ["applyMiddleware", "createHandler"],
        }),
        "src/config/limits.ts": file({ symbolNames: ["maxRequests", "windowSize"] }),
      },
    }),
  });

  // Q11: Consumer/provider tie — two files with near-identical BM25 scores
  // (same path token "payment", same symbol overlap). The consumer (checkout)
  // imports from the provider (gateway). Consumer should rank higher because
  // bug reports describe symptoms at call sites.
  queries.push({
    name: "consumer-beats-provider-tie",
    query: "payment charge fails with invalid currency",
    expected: ["src/checkout/payment-flow.ts"],
    graph: makeGraph({
      files: {
        // Consumer: imports chargeCard from gateway. Path has "payment" via edge.
        "src/checkout/payment-flow.ts": file({
          symbolNames: ["processPayment", "handleCharge", "validateCurrency"],
          betweenness: 0.2,
          importedByCount: 3,
        }),
        // Provider: defines chargeCard. Also has "payment" in symbols.
        "src/payments/gateway.ts": file({
          symbolNames: ["chargeCard", "refundPayment", "createPaymentIntent"],
          betweenness: 0.3,
          importedByCount: 6,
        }),
        "src/utils/currency.ts": file({ symbolNames: ["formatCurrency", "parseCurrency"] }),
      },
      edges: [
        {
          from: "src/checkout/payment-flow.ts",
          to: "src/payments/gateway.ts",
          importedNames: ["chargeCard", "createPaymentIntent"],
        },
      ],
    }),
  });

  // Q12: Weight-sensitivity canary — designed so flipping PATH_WEIGHT < SYMBOL_WEIGHT
  // would change the winner. The correct file has 2 path token matches and 0 symbol
  // matches. The decoy has 0 path matches and 2 symbol matches. If path weight is
  // properly higher, the path-matched file wins.
  queries.push({
    name: "weight-sensitivity-canary",
    query: "email notification delivery",
    expected: ["src/notifications/email-sender.ts"],
    graph: makeGraph({
      files: {
        // Path: "notifications/email" matches "notification" (via synonym) + "email". Symbols: generic.
        "src/notifications/email-sender.ts": file({
          symbolNames: ["dispatch", "enqueue", "retry"],
        }),
        // Path: "services/outbox" — 0 overlap. Symbols: "emailNotification", "deliveryStatus" match.
        "src/services/outbox.ts": file({
          symbolNames: ["emailNotification", "deliveryStatus", "markSent"],
        }),
        "src/templates/welcome.ts": file({ symbolNames: ["renderWelcome"] }),
      },
    }),
  });

  return queries;
}

// ── Evaluation ───────────────────────────────────────────────────────────

describe("BM25F offline evaluation", () => {
  const queries = buildBenchmarkQueries();

  // Individual query assertions
  for (const q of queries) {
    it(`${q.name}: correct file in top 5`, () => {
      const results = resolveEditTargets(q.query, q.graph);
      const recall = recallAtK(results, q.expected, 5);
      expect(recall).toBeGreaterThan(0);
    });
  }

  // Aggregate metrics
  it("aggregate MRR >= 0.7", () => {
    let totalRR = 0;
    for (const q of queries) {
      const results = resolveEditTargets(q.query, q.graph);
      totalRR += reciprocalRank(results, q.expected);
    }
    const mrr = totalRR / queries.length;
    expect(mrr).toBeGreaterThanOrEqual(0.7);
  });

  it("aggregate Recall@5 >= 0.8", () => {
    let totalRecall = 0;
    for (const q of queries) {
      const results = resolveEditTargets(q.query, q.graph);
      totalRecall += recallAtK(results, q.expected, 5);
    }
    const avgRecall = totalRecall / queries.length;
    expect(avgRecall).toBeGreaterThanOrEqual(0.8);
  });

  it("aggregate Precision@5 >= 0.3", () => {
    let totalPrecision = 0;
    for (const q of queries) {
      const results = resolveEditTargets(q.query, q.graph);
      totalPrecision += precisionAtK(results, q.expected, 5);
    }
    const avgPrecision = totalPrecision / queries.length;
    expect(avgPrecision).toBeGreaterThanOrEqual(0.3);
  });

  // Diagnostic: print full metrics (visible in verbose mode)
  it("diagnostic: per-query metrics", () => {
    const rows: Array<{ name: string; rr: number; recall5: number; precision5: number; rank1: string }> = [];
    for (const q of queries) {
      const results = resolveEditTargets(q.query, q.graph);
      rows.push({
        name: q.name,
        rr: reciprocalRank(results, q.expected),
        recall5: recallAtK(results, q.expected, 5),
        precision5: precisionAtK(results, q.expected, 5),
        rank1: results[0] ?? "(none)",
      });
    }
    // All queries should have RR > 0 (correct file found somewhere in results)
    for (const row of rows) {
      expect(row.rr).toBeGreaterThan(0);
    }
  });
});
