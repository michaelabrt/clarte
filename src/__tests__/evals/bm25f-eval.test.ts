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
import { resolveEditTargets } from "../../steer/targets-resolve.js";
import type { PersistedGraph } from "../../core/types/persisted-graph.js";
import { PERSISTED_GRAPH_VERSION } from "../../core/types/persisted-graph.js";

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
  /** "train" queries are used during parameter tuning; "test" queries are held out for validation. */
  purpose?: "train" | "test";
}

/** Bootstrap 95% confidence interval for MRR. */
function bootstrapMRR(rrValues: number[], n = 1000): { mean: number; ci95: [number, number] } {
  const means: number[] = [];
  for (let i = 0; i < n; i++) {
    let sum = 0;
    for (let j = 0; j < rrValues.length; j++) {
      sum += rrValues[Math.floor(Math.random() * rrValues.length)];
    }
    means.push(sum / rrValues.length);
  }
  means.sort((a, b) => a - b);
  return {
    mean: rrValues.reduce((a, b) => a + b, 0) / rrValues.length,
    ci95: [means[Math.floor(n * 0.025)], means[Math.floor(n * 0.975)]],
  };
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

  // ── Q13-Q30: expanded queries for stable parameter validation ──

  // Q13: Acronym handling — SQLiteDB should split to SQLite + DB
  queries.push({
    name: "acronym-sqlite",
    query: "SQLite database connection pool",
    expected: ["src/db/sqlite-pool.ts"],
    graph: makeGraph({
      files: {
        "src/db/sqlite-pool.ts": file({ symbolNames: ["createPool", "getConnection"] }),
        "src/db/postgres-pool.ts": file({ symbolNames: ["createPool", "getConnection"] }),
        "src/config/database.ts": file({ symbolNames: ["loadDbConfig"] }),
      },
    }),
  });

  // Q14: Acronym — HTTP in path
  queries.push({
    name: "acronym-http-client",
    query: "HTTP client timeout configuration",
    expected: ["src/http/client.ts"],
    graph: makeGraph({
      files: {
        "src/http/client.ts": file({ symbolNames: ["createClient", "setTimeout", "fetchJSON"] }),
        "src/ws/client.ts": file({ symbolNames: ["connect", "onMessage"] }),
        "src/config/timeouts.ts": file({ symbolNames: ["DEFAULT_TIMEOUT"] }),
      },
    }),
  });

  // Q15: Verb-noun bridging — "parsing" should match "parser" via synonyms
  queries.push({
    name: "verb-noun-parsing",
    query: "fix the configuration parsing logic",
    expected: ["src/config/parser.ts"],
    graph: makeGraph({
      files: {
        "src/config/parser.ts": file({ symbolNames: ["parseConfig", "validateSchema"] }),
        "src/config/defaults.ts": file({ symbolNames: ["getDefaults"] }),
        "src/cli/args.ts": file({ symbolNames: ["parseArgs"] }),
      },
    }),
  });

  // Q16: Deep nesting — file 4+ directories deep
  queries.push({
    name: "deep-nesting",
    query: "user avatar upload handler",
    expected: ["src/modules/users/profile/avatar/upload.ts"],
    graph: makeGraph({
      files: {
        "src/modules/users/profile/avatar/upload.ts": file({ symbolNames: ["handleUpload", "resizeAvatar"] }),
        "src/modules/users/profile/settings.ts": file({ symbolNames: ["updateSettings"] }),
        "src/storage/s3.ts": file({ symbolNames: ["uploadFile"] }),
      },
    }),
  });

  // Q17: Namespace collision — same filename in different dirs
  queries.push({
    name: "namespace-collision",
    query: "fix validation in the API schema",
    expected: ["src/api/schema/validation.ts"],
    graph: makeGraph({
      files: {
        "src/api/schema/validation.ts": file({ symbolNames: ["validateRequest", "validateResponse"] }),
        "src/forms/schema/validation.ts": file({ symbolNames: ["validateForm", "checkRequired"] }),
        "src/api/routes.ts": file({ symbolNames: ["registerRoutes"] }),
      },
      edges: [{ from: "src/api/routes.ts", to: "src/api/schema/validation.ts", importedNames: ["validateRequest"] }],
    }),
  });

  // Q18: Weak coupling — confidence just above threshold
  queries.push({
    name: "weak-coupling",
    query: "fix the rate limiter middleware",
    expected: ["src/middleware/rate-limiter.ts"],
    graph: makeGraph({
      files: {
        "src/middleware/rate-limiter.ts": file({ symbolNames: ["rateLimiter", "checkQuota"] }),
        "src/middleware/auth.ts": file({ symbolNames: ["authMiddleware"] }),
        "src/config/limits.ts": file({ symbolNames: ["RATE_LIMIT"] }),
      },
      changeCoupling: [
        { fileA: "src/middleware/rate-limiter.ts", fileB: "src/config/limits.ts", coChangeCount: 3, confidence: 0.52 },
      ],
    }),
  });

  // Q19: Strong coupling — confidence near 1.0
  queries.push({
    name: "strong-coupling",
    query: "update the Redis cache TTL",
    expected: ["src/cache/redis.ts"],
    graph: makeGraph({
      files: {
        "src/cache/redis.ts": file({ symbolNames: ["getFromCache", "setCache", "invalidate"] }),
        "src/cache/memory.ts": file({ symbolNames: ["memoryCache"] }),
        "src/config/cache.ts": file({ symbolNames: ["CACHE_TTL"] }),
      },
      changeCoupling: [
        { fileA: "src/cache/redis.ts", fileB: "src/config/cache.ts", coChangeCount: 12, confidence: 0.95 },
      ],
    }),
  });

  // Q20: Test proxy — test name doesn't match source
  queries.push({
    name: "test-proxy-mismatch",
    query: "fix the order total calculation",
    expected: ["src/orders/pricing.ts"],
    graph: makeGraph({
      files: {
        "src/orders/pricing.ts": file({ symbolNames: ["calculateTotal", "applyDiscount"] }),
        "src/orders/checkout.ts": file({ symbolNames: ["processCheckout"] }),
      },
      testMapping: {
        "src/orders/pricing.ts": ["test/integration/order-flow.test.ts"],
      },
    }),
  });

  // Q21: Import-only match — file reachable only via imports field
  queries.push({
    name: "import-only-match",
    query: "fix the logger transport configuration",
    expected: ["src/logging/transports.ts"],
    graph: makeGraph({
      files: {
        "src/logging/transports.ts": file({ symbolNames: ["createTransport"] }),
        "src/logging/index.ts": file({ symbolNames: ["getLogger"] }),
        "src/app.ts": file({ symbolNames: ["bootstrap"] }),
      },
      edges: [
        { from: "src/logging/index.ts", to: "src/logging/transports.ts", importedNames: ["createTransport"] },
        { from: "src/app.ts", to: "src/logging/index.ts", importedNames: ["getLogger"] },
      ],
    }),
  });

  // Q22: Multi-term query (4+ words)
  queries.push({
    name: "multi-term-long-query",
    query: "the websocket connection drops when the server sends a large payload",
    expected: ["src/ws/connection.ts"],
    graph: makeGraph({
      files: {
        "src/ws/connection.ts": file({ symbolNames: ["handleMessage", "closeConnection", "sendPayload"] }),
        "src/ws/server.ts": file({ symbolNames: ["createServer", "broadcast"] }),
        "src/http/server.ts": file({ symbolNames: ["listen", "handleRequest"] }),
      },
    }),
  });

  // Q23: Single-word query
  queries.push({
    name: "single-word-query",
    query: "middleware",
    expected: ["src/middleware/index.ts"],
    graph: makeGraph({
      files: {
        "src/middleware/index.ts": file({ symbolNames: ["applyMiddleware", "compose"] }),
        "src/routes/index.ts": file({ symbolNames: ["registerRoutes"] }),
        "src/middleware/cors.ts": file({ symbolNames: ["corsMiddleware"] }),
      },
    }),
  });

  // Q24: Coupling + BM25 interaction — weak BM25 but strong coupling should boost
  queries.push({
    name: "coupling-boosts-weak-bm25",
    query: "fix the database migration runner",
    expected: ["src/db/migrate.ts"],
    graph: makeGraph({
      files: {
        "src/db/migrate.ts": file({ symbolNames: ["runMigrations", "rollback"] }),
        "src/db/schema.ts": file({ symbolNames: ["createTable", "addColumn"] }),
        "src/db/seed.ts": file({ symbolNames: ["seedData"] }),
      },
      changeCoupling: [{ fileA: "src/db/migrate.ts", fileB: "src/db/schema.ts", coChangeCount: 15, confidence: 0.88 }],
    }),
  });

  // ── Held-out test set (Q25-Q30): not used during parameter tuning ──

  // Q25: Verb-noun bridging — "compilation" should match "compile"
  queries.push({
    name: "verb-noun-compilation",
    purpose: "test",
    query: "compilation errors in the template engine",
    expected: ["src/template/compiler.ts"],
    graph: makeGraph({
      files: {
        "src/template/compiler.ts": file({ symbolNames: ["compileTemplate", "parseExpression"] }),
        "src/template/runtime.ts": file({ symbolNames: ["renderTemplate"] }),
        "src/template/cache.ts": file({ symbolNames: ["getCachedTemplate"] }),
      },
    }),
  });

  // Q26: Importer expansion — consumer should rank higher than provider
  queries.push({
    name: "importer-expansion",
    purpose: "test",
    query: "fix the payment validation",
    expected: ["src/checkout/validate-payment.ts"],
    graph: makeGraph({
      files: {
        "src/checkout/validate-payment.ts": file({ symbolNames: ["validateCard", "checkBalance"] }),
        "src/payments/validator.ts": file({ symbolNames: ["validatePayment", "formatError"] }),
        "src/payments/index.ts": file({ symbolNames: ["processPayment"] }),
      },
      edges: [
        {
          from: "src/checkout/validate-payment.ts",
          to: "src/payments/validator.ts",
          importedNames: ["validatePayment"],
        },
      ],
    }),
  });

  // Q27: JSON-related query — tests serialize/deserialize synonym expansion
  queries.push({
    name: "json-serialization",
    purpose: "test",
    query: "JSON serialization strips null fields",
    expected: ["src/utils/serializer.ts"],
    graph: makeGraph({
      files: {
        "src/utils/serializer.ts": file({ symbolNames: ["serializeToJSON", "stripNulls"] }),
        "src/utils/parser.ts": file({ symbolNames: ["parseJSON"] }),
        "src/api/response.ts": file({ symbolNames: ["formatResponse"] }),
      },
    }),
  });

  // Q28: Mixed path + symbol match — both should contribute
  queries.push({
    name: "mixed-path-symbol",
    purpose: "test",
    query: "fix the error boundary component",
    expected: ["src/components/error-boundary.tsx"],
    graph: makeGraph({
      files: {
        "src/components/error-boundary.tsx": file({ symbolNames: ["ErrorBoundary", "FallbackUI"] }),
        "src/utils/error-handler.ts": file({ symbolNames: ["handleError", "logError"] }),
        "src/hooks/useErrorBoundary.ts": file({ symbolNames: ["useErrorBoundary"] }),
      },
    }),
  });

  // Q29: Connection query — tests "connect/connection" synonym bridging
  queries.push({
    name: "connection-synonym",
    purpose: "test",
    query: "database connection leak in pool cleanup",
    expected: ["src/db/pool.ts"],
    graph: makeGraph({
      files: {
        "src/db/pool.ts": file({ symbolNames: ["createPool", "cleanupConnections", "getConnection"] }),
        "src/db/client.ts": file({ symbolNames: ["connect", "disconnect"] }),
        "src/db/config.ts": file({ symbolNames: ["DATABASE_URL"] }),
      },
    }),
  });

  // Q30: Registration flow — tests "register/registration" synonym
  queries.push({
    name: "registration-synonym",
    purpose: "test",
    query: "user registration email not sent after signup",
    expected: ["src/auth/register.ts"],
    graph: makeGraph({
      files: {
        "src/auth/register.ts": file({ symbolNames: ["registerUser", "sendWelcomeEmail"] }),
        "src/auth/login.ts": file({ symbolNames: ["loginUser", "verifyPassword"] }),
        "src/email/templates.ts": file({ symbolNames: ["renderWelcome"] }),
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

  // Held-out test set: verify that test-purpose queries also pass MRR threshold
  it("held-out test set MRR >= 0.6", () => {
    const testQueries = queries.filter((q) => q.purpose === "test");
    if (testQueries.length === 0) return; // no test queries yet
    const rrValues = testQueries.map((q) => reciprocalRank(resolveEditTargets(q.query, q.graph), q.expected));
    const { mean, ci95 } = bootstrapMRR(rrValues);
    // Lower threshold for held-out (0.6) since these queries weren't used for tuning
    expect(mean).toBeGreaterThanOrEqual(0.6);
    // Log CI for visibility
    console.error(
      `Held-out MRR: ${mean.toFixed(3)} [${ci95[0].toFixed(3)}, ${ci95[1].toFixed(3)}] (n=${testQueries.length})`,
    );
  });

  // Bootstrap confidence interval for full MRR
  it("MRR 95% CI lower bound > 0.5", () => {
    const rrValues = queries.map((q) => reciprocalRank(resolveEditTargets(q.query, q.graph), q.expected));
    const { ci95 } = bootstrapMRR(rrValues);
    expect(ci95[0]).toBeGreaterThan(0.5);
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
