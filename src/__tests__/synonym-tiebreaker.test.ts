/**
 * Tests for Phase 2 changes:
 * - Synonym expansion in BM25F (expandQuerySynonyms behavior via public API)
 * - Semantic tiebreakers (import direction, betweenness, importedByCount)
 *
 * Each test targets a distinct behavior that could independently regress.
 */

import { describe, it, expect } from "vitest";
import { resolveEditTargets } from "../steer/targets-resolve";
import type { PersistedGraph } from "../core/types/persisted-graph";
import { PERSISTED_GRAPH_VERSION } from "../core/types/persisted-graph";

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

function makeFile(overrides?: Record<string, unknown>) {
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

// ── Synonym expansion (via public resolveEditTargets) ─────────────────────────

describe("synonym expansion", () => {
  it("query 'auth' finds file with 'authentication' in path", () => {
    // "auth" → expands to ["authentication", "authorize", "authorization"]
    const graph = makeGraph({
      files: {
        "src/authentication/service.ts": makeFile(),
        "src/payments/gateway.ts": makeFile(),
      },
    });
    const targets = resolveEditTargets("auth problem", graph);
    expect(targets).toContain("src/authentication/service.ts");
    expect(targets).not.toContain("src/payments/gateway.ts");
  });

  it("synonym match scores lower than direct match", () => {
    // "auth" directly matches "src/auth.ts" (path token, full weight).
    // "auth" also expands to "authentication" which matches "src/authentication/module.ts"
    // but at SYNONYM_DISCOUNT (0.3x) weight. Direct match must rank above synonym match.
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFile(),
        "src/authentication/module.ts": makeFile(),
      },
    });
    const targets = resolveEditTargets("auth issue", graph);
    expect(targets[0]).toBe("src/auth.ts");
  });

  it("query 'crypto' finds file with 'encrypt' in symbols", () => {
    // "crypto" → synonyms include "encrypt", "decrypt", "hash", "hmac"
    const graph = makeGraph({
      files: {
        "src/security/cipher.ts": makeFile({ symbolNames: ["encryptPayload", "decryptPayload"] }),
        "src/utils/string.ts": makeFile({ symbolNames: ["trim", "pad"] }),
      },
    });
    const targets = resolveEditTargets("crypto rotation broken", graph);
    expect(targets).toContain("src/security/cipher.ts");
  });

  it("query 'db' finds file containing 'database' in path", () => {
    // "db" → synonyms include "database", "datastore"
    const graph = makeGraph({
      files: {
        "src/database/connection.ts": makeFile(),
        "src/server/middleware.ts": makeFile(),
      },
    });
    const targets = resolveEditTargets("db pool exhausted", graph);
    expect(targets).toContain("src/database/connection.ts");
  });

  it("query 'err' finds file with 'exception' in symbols", () => {
    // "err" → synonyms include "error", "exception", "fault"
    const graph = makeGraph({
      files: {
        "src/core/exception-handler.ts": makeFile({ symbolNames: ["catchException", "rethrow"] }),
        "src/utils/helpers.ts": makeFile({ symbolNames: ["sleep", "retry"] }),
      },
    });
    const targets = resolveEditTargets("err propagation", graph);
    expect(targets).toContain("src/core/exception-handler.ts");
  });

  it("stop-word synonym is not added as expansion term", () => {
    // "cfg" group: ["cfg", "config", "configuration", "settings"]
    // "config" is a stop word → skipped during expansion.
    // "configuration" is not a stop word → added as expansion.
    // "src/config/loader.ts" has path token "config" (a stop word) - tokenizeQuery strips it,
    // so it never appears in the df lookup and won't match via synonym either.
    const graph = makeGraph({
      files: {
        // path token is "config" (stop word - won't be scored)
        "src/config/loader.ts": makeFile(),
        // path token is "configuration" (valid expansion of "cfg")
        "src/configuration/schema.ts": makeFile(),
      },
    });
    const targets = resolveEditTargets("cfg loading", graph);
    expect(targets).toContain("src/configuration/schema.ts");
    expect(targets).not.toContain("src/config/loader.ts");
  });

  it("query term already in query is not re-added as synonym expansion", () => {
    // "auth" and "authentication" are in the same group.
    // When both appear in the query, neither should be added as expansion of the other
    // (they're already in original terms list, excluded by `!terms.includes(syn)`).
    // "authorize" and "authorization" are the only valid expansions.
    const graph = makeGraph({
      files: {
        "src/auth/module.ts": makeFile({ symbolNames: ["authenticate"] }),
        "src/authentication/module.ts": makeFile({ symbolNames: ["authenticate"] }),
        // path tokens: "zz", "module" - cannot match auth/authentication synonyms
        "src/zz/module.ts": makeFile({ symbolNames: ["process"] }),
      },
    });
    const targets = resolveEditTargets("auth authentication", graph);
    expect(targets).toContain("src/auth/module.ts");
    expect(targets).toContain("src/authentication/module.ts");
    expect(targets).not.toContain("src/zz/module.ts");
  });

  it("query with no synonym group returns only direct matches", () => {
    // "runner" is not in any synonym group - no expansion occurs.
    // Direct path/symbol match should still work.
    const graph = makeGraph({
      files: {
        "src/runner/task-runner.ts": makeFile({ symbolNames: ["TaskRunner", "run"] }),
        "src/scheduler/cron.ts": makeFile({ symbolNames: ["schedule", "cron"] }),
      },
    });
    const targets = resolveEditTargets("runner task", graph);
    expect(targets[0]).toBe("src/runner/task-runner.ts");
  });

  it("query 'api' expands to 'endpoint' synonym only (S3: tightened groups)", () => {
    // After S3: "api" → synonyms include "endpoint" only (not "route", "handler").
    // "route" and "handler" are in a separate group.
    const graph = makeGraph({
      files: {
        "src/endpoint/user.ts": makeFile({ symbolNames: ["createUser", "getUser"] }),
        "src/handler/payment.ts": makeFile({ symbolNames: ["processPayment"] }),
        "src/utils/format.ts": makeFile({ symbolNames: ["formatDate"] }),
      },
    });
    const targets = resolveEditTargets("api broken", graph);
    expect(targets).toContain("src/endpoint/user.ts");
    expect(targets).not.toContain("src/handler/payment.ts");
    expect(targets).not.toContain("src/utils/format.ts");
  });

  it("query 'cache' expands to 'memoize'", () => {
    // "cache" → synonyms include "memoize", "memo"
    const graph = makeGraph({
      files: {
        "src/utils/memoize.ts": makeFile({ symbolNames: ["memoizeResult", "clearMemo"] }),
        "src/utils/logger.ts": makeFile({ symbolNames: ["log", "warn"] }),
      },
    });
    const targets = resolveEditTargets("cache performance", graph);
    expect(targets).toContain("src/utils/memoize.ts");
  });

  it("multiple query terms from different synonym groups both expand independently", () => {
    // "auth" expands to authentication/authorize/authorization
    // "db" expands to database/datastore
    const graph = makeGraph({
      files: {
        "src/authentication/service.ts": makeFile(),
        "src/database/users.ts": makeFile(),
        "src/utils/helpers.ts": makeFile(),
      },
    });
    const targets = resolveEditTargets("auth db integration", graph);
    expect(targets).toContain("src/authentication/service.ts");
    expect(targets).toContain("src/database/users.ts");
    expect(targets).not.toContain("src/utils/helpers.ts");
  });
});

// ── Semantic tiebreakers ──────────────────────────────────────────────────────

describe("semantic tiebreakers", () => {
  it("tiebreaker 1: pure consumer (only imports) ranks above pure provider (only imported)", () => {
    // Both files have the same single path token "jwt" and same path length (3 tokens),
    // so BM25 scores are equal. Tiebreaker should prefer the pure consumer.
    // Use identical-length paths to force equal BM25 scores.
    const graph = makeGraph({
      files: {
        "src/jwt-use.ts": makeFile(),
        "src/jwt-lib.ts": makeFile(),
        "src/other.ts": makeFile(),
      },
      edges: [
        // jwt-use.ts is a pure consumer: imports from other, not imported by anything
        { from: "src/jwt-use.ts", to: "src/other.ts", importedNames: ["helper"] },
        // jwt-lib.ts is a pure provider: imported by other, imports nothing
        { from: "src/other.ts", to: "src/jwt-lib.ts", importedNames: ["provide"] },
      ],
    });
    const targets = resolveEditTargets("jwt", graph);
    const consumerIdx = targets.indexOf("src/jwt-use.ts");
    const providerIdx = targets.indexOf("src/jwt-lib.ts");
    expect(consumerIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeLessThan(providerIdx);
  });

  it("tiebreaker 2: higher betweenness wins when import direction is tied", () => {
    // Both files are pure providers (imported, never import). Same path length → equal BM25.
    // File with higher betweenness should rank first.
    const graph = makeGraph({
      files: {
        "src/jwt-low.ts": makeFile({ betweenness: 0.1 }),
        "src/jwt-big.ts": makeFile({ betweenness: 0.8 }),
        "src/other.ts": makeFile(),
      },
      edges: [
        { from: "src/other.ts", to: "src/jwt-low.ts", importedNames: ["low"] },
        { from: "src/other.ts", to: "src/jwt-big.ts", importedNames: ["high"] },
      ],
    });
    const targets = resolveEditTargets("jwt", graph);
    const lowIdx = targets.indexOf("src/jwt-low.ts");
    const bigIdx = targets.indexOf("src/jwt-big.ts");
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(lowIdx).toBeGreaterThanOrEqual(0);
    expect(bigIdx).toBeLessThan(lowIdx);
  });

  it("tiebreaker 3: higher importedByCount wins when betweenness is tied", () => {
    // Both files are pure providers. Same betweenness → fall through to importedByCount.
    const graph = makeGraph({
      files: {
        "src/jwt-few.ts": makeFile({ betweenness: 0.5, importedByCount: 2 }),
        "src/jwt-lot.ts": makeFile({ betweenness: 0.5, importedByCount: 12 }),
        "src/other.ts": makeFile(),
      },
      edges: [
        { from: "src/other.ts", to: "src/jwt-few.ts", importedNames: ["few"] },
        { from: "src/other.ts", to: "src/jwt-lot.ts", importedNames: ["many"] },
      ],
    });
    const targets = resolveEditTargets("jwt", graph);
    const fewIdx = targets.indexOf("src/jwt-few.ts");
    const lotIdx = targets.indexOf("src/jwt-lot.ts");
    expect(lotIdx).toBeGreaterThanOrEqual(0);
    expect(fewIdx).toBeGreaterThanOrEqual(0);
    expect(lotIdx).toBeLessThan(fewIdx);
  });

  it("tiebreaker 4: path lexicographic order is deterministic when all other factors tied", () => {
    // Identical BM25 scores (same path structure), no edges (same import direction status),
    // same betweenness and importedByCount. Final sort must be by path ascending.
    const graph = makeGraph({
      files: {
        "src/jwt-zzz.ts": makeFile(),
        "src/jwt-aaa.ts": makeFile(),
        "src/jwt-mmm.ts": makeFile(),
      },
    });
    const first = resolveEditTargets("jwt", graph, 10);
    const second = resolveEditTargets("jwt", graph, 10);
    expect(first).toEqual(second);
    expect(first[0]).toBe("src/jwt-aaa.ts");
    expect(first[1]).toBe("src/jwt-mmm.ts");
    expect(first[2]).toBe("src/jwt-zzz.ts");
  });

  it("file that both imports and is imported is not treated as pure consumer", () => {
    // Pure consumer: only imports (importSources ∧ ¬importTargets) → tiebreaker returns true
    // Bridge file: both imports AND is imported (importSources ∧ importTargets) → tiebreaker returns false
    // Use identical path lengths to force equal BM25 scores.
    // Pure consumer must rank above the bridge.
    const graph = makeGraph({
      files: {
        "src/jwt-end.ts": makeFile(), // pure consumer: only in importSources
        "src/jwt-mid.ts": makeFile(), // bridge: in both importSources and importTargets
        "src/lib.ts": makeFile(),
        "src/app.ts": makeFile(),
      },
      edges: [
        // jwt-end only imports (pure consumer)
        { from: "src/jwt-end.ts", to: "src/lib.ts", importedNames: ["x"] },
        // jwt-mid both imports and is imported (bridge)
        { from: "src/jwt-mid.ts", to: "src/lib.ts", importedNames: ["x"] },
        { from: "src/app.ts", to: "src/jwt-mid.ts", importedNames: ["y"] },
      ],
    });
    const targets = resolveEditTargets("jwt", graph);
    const consumerIdx = targets.indexOf("src/jwt-end.ts");
    const bridgeIdx = targets.indexOf("src/jwt-mid.ts");
    expect(consumerIdx).toBeGreaterThanOrEqual(0);
    expect(bridgeIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeLessThan(bridgeIdx);
  });

  it("tiebreaker does not affect ordering when BM25 scores differ", () => {
    // File with term in BOTH path and symbols scores higher than one with only path match.
    // Higher betweenness on the lower-BM25 file must not override score difference.
    const graph = makeGraph({
      files: {
        "src/cache/handler.ts": makeFile({ betweenness: 0.1, symbolNames: ["cache", "cacheResult"] }),
        "src/cache-util.ts": makeFile({ betweenness: 0.9 }),
      },
    });
    const targets = resolveEditTargets("cache", graph);
    expect(targets[0]).toBe("src/cache/handler.ts");
  });
});

// ── Synonym expansion edge cases ──────────────────────────────────────────────

describe("synonym expansion edge cases", () => {
  it("expanded synonyms are deduplicated when multiple query terms share a common expansion", () => {
    // "log" and "logger" are in the same group: ["log", "logger", "logging"]
    // query "log logger": "log" wants to expand to ["logger","logging"] but "logger" is already
    // in original terms (excluded); "logger" wants to expand to ["log","logging"] but "log" is
    // already in original terms (excluded).
    // Result: only "logging" is in the expanded set, added exactly once.
    const graph = makeGraph({
      files: {
        "src/logging/service.ts": makeFile({ symbolNames: ["LoggingService", "writeLog"] }),
        "src/utils/format.ts": makeFile({ symbolNames: ["formatDate"] }),
      },
    });
    const targets = resolveEditTargets("log logger broken", graph);
    expect(targets).toContain("src/logging/service.ts");
    expect(targets).not.toContain("src/utils/format.ts");
  });

  it("synonym expansion does not add query terms already present as direct terms", () => {
    // "jwt" and "token" are in the same group: ["jwt", "jsonwebtoken", "token"]
    // Both appear in query → neither added as expansion of the other.
    // Only "jsonwebtoken" should be in expanded set.
    const graph = makeGraph({
      files: {
        "src/auth/jwt-token-validator.ts": makeFile({ symbolNames: ["validateToken", "signJwt"] }),
        "src/utils/random.ts": makeFile({ symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("jwt token invalid", graph);
    expect(targets[0]).toBe("src/auth/jwt-token-validator.ts");
  });

  it("synonym 'ws' expands to 'websocket'/'socket' and finds matching file", () => {
    // "ws" → synonyms include "websocket", "socket"
    const graph = makeGraph({
      files: {
        "src/transport/websocket-server.ts": makeFile({ symbolNames: ["WebSocketServer", "broadcast"] }),
        "src/transport/http-server.ts": makeFile({ symbolNames: ["HttpServer", "listen"] }),
      },
    });
    const targets = resolveEditTargets("ws connection dropped", graph);
    expect(targets).toContain("src/transport/websocket-server.ts");
  });

  it("synonym 'jwt' expands to 'token' and finds token file when no jwt file exists", () => {
    // "jwt" → synonyms include "jsonwebtoken", "token"
    // No direct path/symbol match for "jwt"; must rely on synonym expansion.
    const graph = makeGraph({
      files: {
        "src/auth/token-service.ts": makeFile({ symbolNames: ["refreshToken", "revokeToken"] }),
        "src/utils/random.ts": makeFile({ symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("jwt refresh broken", graph);
    expect(targets).toContain("src/auth/token-service.ts");
  });

  it("empty query returns empty even if synonym groups exist", () => {
    // tokenizeQuery returns [] for empty/stop-word-only input, so expansion never runs.
    const graph = makeGraph({
      files: { "src/auth.ts": makeFile() },
    });
    expect(resolveEditTargets("fix the bug", graph)).toEqual([]);
  });

  it("synonym for 'schema' finds 'validator' in path", () => {
    // "schema" → synonyms include "validate", "validator", "validation"
    const graph = makeGraph({
      files: {
        "src/core/validator.ts": makeFile({ symbolNames: ["validate", "ValidationError"] }),
        "src/core/parser.ts": makeFile({ symbolNames: ["parse", "ParseError"] }),
      },
    });
    const targets = resolveEditTargets("schema broken", graph);
    expect(targets).toContain("src/core/validator.ts");
  });

  it("synonym for 'mock' expands to 'stub'/'fake'/'spy'", () => {
    // "mock" → synonyms include "stub", "fake", "spy"
    const graph = makeGraph({
      files: {
        "src/testing/fake-http-client.ts": makeFile({ symbolNames: ["FakeHttpClient", "stubResponse"] }),
        "src/core/real-http-client.ts": makeFile({ symbolNames: ["HttpClient", "request"] }),
      },
    });
    const targets = resolveEditTargets("mock http client", graph);
    expect(targets).toContain("src/testing/fake-http-client.ts");
  });

  it("query 'verify' expands to 'verification'", () => {
    // "verify" → synonyms include "verification"
    const graph = makeGraph({
      files: {
        "src/auth/verification-service.ts": makeFile({ symbolNames: ["sendVerification", "checkCode"] }),
        "src/utils/random.ts": makeFile({ symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("verify email broken", graph);
    expect(targets).toContain("src/auth/verification-service.ts");
  });

  it("query 'verification' expands to 'verify'", () => {
    // "verification" → synonyms include "verify"
    const graph = makeGraph({
      files: {
        "src/auth/verify-token.ts": makeFile({ symbolNames: ["verifySignature", "verifyExpiry"] }),
        "src/utils/random.ts": makeFile({ symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("verification flow failing", graph);
    expect(targets).toContain("src/auth/verify-token.ts");
  });

  it("verify/verification synonym does not expand to unrelated terms", () => {
    // Confirm the synonym group is ["verify", "verification"] only - no leakage into cert/tls.
    // A file with only "cert" path tokens should NOT appear when querying "verify".
    const graph = makeGraph({
      files: {
        "src/auth/verification-service.ts": makeFile({ symbolNames: ["sendVerificationEmail"] }),
        "src/security/cert-loader.ts": makeFile({ symbolNames: ["loadCert"] }),
      },
    });
    const targets = resolveEditTargets("verify email", graph);
    expect(targets).toContain("src/auth/verification-service.ts");
    // cert-loader has no verify/verification tokens; should not appear via verify synonym alone
    expect(targets).not.toContain("src/security/cert-loader.ts");
  });
});

// ── Directional import graph expansion ───────────────────────────────────────

describe("directional import expansion", () => {
  it("consumer (importer) of a BM25 match gets a higher boost than a provider (import)", () => {
    // Setup: matched-file is the BM25 hit.
    // consumer imports matched-file (importer, gets IMPORTER_EXPANSION = 0.4x).
    // provider is imported by matched-file (import, gets IMPORT_EXPANSION = 0.2x).
    // consumer must rank above provider in the results.
    const graph = makeGraph({
      files: {
        "src/auth/matched-file.ts": makeFile({ symbolNames: ["authenticate"] }),
        "src/app/consumer.ts": makeFile(),
        "src/core/provider.ts": makeFile(),
      },
      edges: [
        // consumer imports matched-file → consumer is an importer of the match
        { from: "src/app/consumer.ts", to: "src/auth/matched-file.ts", importedNames: ["authenticate"] },
        // matched-file imports provider → provider is an import of the match
        { from: "src/auth/matched-file.ts", to: "src/core/provider.ts", importedNames: ["helper"] },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);
    const matchIdx = targets.indexOf("src/auth/matched-file.ts");
    const consumerIdx = targets.indexOf("src/app/consumer.ts");
    const providerIdx = targets.indexOf("src/core/provider.ts");

    // Both expanded files should appear
    expect(consumerIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThanOrEqual(0);

    // Consumer must rank above provider (higher expansion factor = higher score)
    expect(consumerIdx).toBeLessThan(providerIdx);

    // Match itself must be first
    expect(matchIdx).toBe(0);
  });

  it("consumer expanded score is 0.4x of BM25 seed, provider is 0.2x", () => {
    // With only one file in the corpus the BM25 score is computable, but the
    // ratio between consumer and provider can be verified indirectly: consumer
    // gets 2x the boost of provider, so in a three-file graph (match, consumer,
    // provider) the consumer MUST rank between match and provider.
    const graph = makeGraph({
      files: {
        "src/cache/store.ts": makeFile({ symbolNames: ["CacheStore", "invalidate"] }),
        "src/api/handler.ts": makeFile(),
        "src/core/backend.ts": makeFile(),
      },
      edges: [
        { from: "src/api/handler.ts", to: "src/cache/store.ts", importedNames: ["invalidate"] },
        { from: "src/cache/store.ts", to: "src/core/backend.ts", importedNames: ["persist"] },
      ],
    });
    const targets = resolveEditTargets("cache invalidate", graph, 10);
    const storeIdx = targets.indexOf("src/cache/store.ts");
    const handlerIdx = targets.indexOf("src/api/handler.ts");
    const backendIdx = targets.indexOf("src/core/backend.ts");

    expect(storeIdx).toBe(0);
    expect(handlerIdx).toBeGreaterThan(storeIdx);
    expect(backendIdx).toBeGreaterThan(handlerIdx);
  });

  it("expansion does not override a higher direct BM25 score on the neighbor", () => {
    // consumer has both "auth" in its own path AND is an importer of the match.
    // Its direct BM25 score should win over the expansion-derived score.
    const graph = makeGraph({
      files: {
        "src/auth/service.ts": makeFile({ symbolNames: ["authenticate"] }),
        "src/auth/middleware.ts": makeFile({ symbolNames: ["authMiddleware"] }),
        "src/core/provider.ts": makeFile(),
      },
      edges: [
        { from: "src/auth/middleware.ts", to: "src/auth/service.ts", importedNames: ["authenticate"] },
        { from: "src/auth/service.ts", to: "src/core/provider.ts", importedNames: ["helper"] },
      ],
    });
    const targets = resolveEditTargets("authenticate auth", graph, 10);
    // Both service and middleware score directly on BM25; provider only via expansion.
    // Provider must rank last among these three.
    const providerIdx = targets.indexOf("src/core/provider.ts");
    const serviceIdx = targets.indexOf("src/auth/service.ts");
    const middlewareIdx = targets.indexOf("src/auth/middleware.ts");

    expect(serviceIdx).toBeGreaterThanOrEqual(0);
    expect(middlewareIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThan(Math.max(serviceIdx, middlewareIdx));
  });

  it("importer of a non-matching file is not expanded", () => {
    // Only direct BM25 matches seed expansion. A file that imports a non-matching file
    // should not appear in results through expansion.
    const graph = makeGraph({
      files: {
        "src/auth/service.ts": makeFile({ symbolNames: ["authenticate"] }),
        "src/unrelated/helper.ts": makeFile({ symbolNames: ["doSomething"] }),
        "src/app/main.ts": makeFile(),
      },
      edges: [
        // main imports helper (not a BM25 match), so main should not be expanded
        { from: "src/app/main.ts", to: "src/unrelated/helper.ts", importedNames: ["doSomething"] },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);
    expect(targets).toContain("src/auth/service.ts");
    expect(targets).not.toContain("src/app/main.ts");
  });
});
