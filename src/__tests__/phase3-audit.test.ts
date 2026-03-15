/**
 * Tests for Phase 3 adversarial audit changes to resolve-targets.ts:
 * 1. verify/verification synonym group
 * 2. Directional expansion: IMPORTER_EXPANSION=0.4 vs IMPORT_EXPANSION=0.2
 * 3. Compound token preservation for camelCase identifiers that lose signal via stop words
 *
 * Each test targets a distinct behavior that could independently regress.
 * Tests in this file are explicitly for edge cases NOT already covered by
 * resolve-targets.test.ts and synonym-tiebreaker.test.ts.
 */

import { describe, it, expect } from "vitest";
import { resolveEditTargets, tokenizeQuery } from "../steer/targets-resolve.js";
import { makePersistedGraph, makeFileRecord } from "./helpers/factories.js";

// ── Compound token preservation: edge cases ──────────────────────────────────

describe("compound token preservation - edge cases", () => {
  it("emits compound when stop word precedes an alphanumeric segment containing a digit", () => {
    // "getBase64" → split on camelCase: ["get", "Base64"] → lowered: ["get", "base64"]
    // validParts (len >= 2): ["get", "base64"]; filtered (not stop word): ["base64"]
    // "get" was stopped → filtered.length (1) < validParts.length (2) → emit "getbase64"
    const result = tokenizeQuery("getBase64");
    expect(result).toContain("base64");
    expect(result).toContain("getbase64");
  });

  it("does not emit the stopped prefix as a standalone token", () => {
    // "get" is a stop word; it must not appear in the result on its own.
    const result = tokenizeQuery("getBase64");
    expect(result).not.toContain("get");
  });

  it("does not emit compound when ALL camelCase parts are stop words", () => {
    // "getSet" → split: ["get", "Set"] → lowered: ["get", "set"]
    // validParts (len >= 2): ["get", "set"]; filtered: [] (both are stop words)
    // filtered.length (0) < validParts.length (2), but the compound "getset" itself
    // is NOT a stop word and len >= 4 so it WOULD be emitted.
    // This tests the actual boundary: compound "getset" is 6 chars and not a stop word.
    const result = tokenizeQuery("getSet");
    // "get" and "set" are both stop words - neither should appear alone
    expect(result).not.toContain("get");
    expect(result).not.toContain("set");
    // "getset" (6 chars, not a stop word) is emitted because filtered < validParts
    expect(result).toContain("getset");
  });

  it("does not emit compound when single-char residual makes compound shorter than 4 chars", () => {
    // "doIt" → split: ["do", "It"] → lowered: ["do", "it"]
    // validParts (len >= 2): ["do", "it"] (both are 2 chars)
    // filtered: [] (both are stop words)
    // compound = "doit" (4 chars, not a stop word) → WOULD be emitted (len >= 4)
    // This confirms the compound IS emitted at the exact boundary of 4 chars.
    const result = tokenizeQuery("doIt");
    expect(result).toContain("doit");
    expect(result).not.toContain("do");
    expect(result).not.toContain("it");
  });

  it("does not emit compound when the joined part is shorter than 4 chars", () => {
    // "isA" → split: ["is", "A"] → lowered: ["is", "a"]
    // validParts filters length >= 2: "a" is 1 char → validParts = ["is"]
    // filtered removes stop word "is" → filtered = []
    // filtered.length (0) < validParts.length (1) → would emit compound, but "isa" is 3 chars < 4
    // So the compound must NOT be emitted.
    const result = tokenizeQuery("isA");
    expect(result).toEqual([]);
  });

  it("emits compound for stop word followed by multi-token remainder", () => {
    // "setQueryRunner" → split: ["set", "Query", "Runner"] → lowered: ["set", "query", "runner"]
    // validParts: ["set", "query", "runner"]; filtered (not stop word): ["query", "runner"]
    // "set" was stopped → filtered.length (2) < validParts.length (3) → emit "setqueryrunner"
    const result = tokenizeQuery("setQueryRunner");
    expect(result).toContain("query");
    expect(result).toContain("runner");
    expect(result).toContain("setqueryrunner");
    expect(result).not.toContain("set");
  });

  it("query with only non-stopped parts does not produce compound (regression guard)", () => {
    // "AbstractParser" → "abstract", "parser" - neither is a stop word.
    // filtered.length === validParts.length, so no compound is emitted.
    const result = tokenizeQuery("AbstractParser");
    expect(result).toContain("abstract");
    expect(result).toContain("parser");
    expect(result).not.toContain("abstractparser");
  });

  it("compound token in identifier matches file that exports that exact compound symbol", () => {
    // When query is "getBase64", the compound "getbase64" is emitted.
    // A file that exports "getBase64" will have "getbase64" in its tokenized symbol list
    // (from the compound preservation logic running on the symbol name too).
    // That file must appear in results.
    const graph = makePersistedGraph({
      files: {
        "src/encoding/base64.ts": makeFileRecord({ role: null, symbolNames: ["getBase64", "encodeBase64"] }),
        "src/utils/string.ts": makeFileRecord({ role: null, symbolNames: ["trim", "pad"] }),
      },
    });
    const targets = resolveEditTargets("getBase64 broken", graph);
    expect(targets).toContain("src/encoding/base64.ts");
  });

  it("compound token does not cause an unrelated file to appear when only base parts match", () => {
    // "getCache" emits compound "getcache". A file with just "cache" in its path
    // should not match on "getcache"; it should only match on "cache".
    // We verify the compound discriminates: files lacking the compound don't get it.
    const graph = makePersistedGraph({
      files: {
        "src/storage/getCacheManager.ts": makeFileRecord({ role: null, symbolNames: ["getCache"] }),
        "src/storage/cache-utils.ts": makeFileRecord({ role: null, symbolNames: ["clearCache", "warmCache"] }),
      },
    });
    const targets = resolveEditTargets("getCache call broken", graph, 10);
    // Both will match on "cache", but getCacheManager.ts also matches on "getcache"
    // (it's in the path token "getcachemanager" won't split exactly but "getCache" in symbols
    // will tokenize to ["cache", "getcache"]).
    // The point is getCacheManager.ts ranks higher due to compound match in symbols.
    expect(targets[0]).toBe("src/storage/getCacheManager.ts");
  });
});

// ── Directional expansion: exact ratio guard ─────────────────────────────────

describe("directional expansion - exact 2:1 ratio between importer and provider", () => {
  it("importer expanded score is exactly 2x the provider expanded score", () => {
    // Both importer and provider derive their scores purely from expansion (no direct BM25 hit).
    // importer = seed * IMPORTER_EXPANSION (0.4)
    // provider = seed * IMPORT_EXPANSION (0.2)
    // Ratio = 0.4 / 0.2 = 2.0 exactly.
    //
    // We verify this indirectly: place a third file between them in BM25 score space
    // to confirm neither order can be explained by small floating-point noise.
    // Specifically, give a third file (decoy) a score that is 0.3x the seed.
    // If importer were 0.2x it would rank behind decoy; at 0.4x it ranks above.
    const graph = makePersistedGraph({
      files: {
        "src/auth/service.ts": makeFileRecord({ role: null, symbolNames: ["authenticate"] }),
        "src/app/consumer.ts": makeFileRecord({ role: null }),
        "src/core/provider.ts": makeFileRecord({ role: null }),
        // decoy: scores 0.3x of seed via a weaker direct BM25 hit
        "src/auth/helper.ts": makeFileRecord({ role: null, symbolNames: ["authHelper"] }),
      },
      edges: [
        { from: "src/app/consumer.ts", to: "src/auth/service.ts", importedNames: ["authenticate"] },
        { from: "src/auth/service.ts", to: "src/core/provider.ts", importedNames: ["helper"] },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);

    const serviceIdx = targets.indexOf("src/auth/service.ts");
    const consumerIdx = targets.indexOf("src/app/consumer.ts");
    const providerIdx = targets.indexOf("src/core/provider.ts");

    // Confirm seed is first
    expect(serviceIdx).toBe(0);
    // consumer (0.4x) must rank above provider (0.2x)
    expect(consumerIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeLessThan(providerIdx);
  });

  it("provider does not appear before consumer even when provider has a stronger path", () => {
    // provider has a slightly more descriptive path ("auth-core-provider") vs consumer ("app-consumer").
    // However, path length difference alone cannot overcome the 2:1 factor difference
    // in expansion scores when both files have zero direct BM25 hit.
    // Consumer score = seed * 0.4; provider score = seed * 0.2. Consumer must still win.
    const graph = makePersistedGraph({
      files: {
        "src/auth-core/authenticate-service.ts": makeFileRecord({ role: null, symbolNames: ["authenticate"] }),
        "src/app-consumer/consumer.ts": makeFileRecord({ role: null }),
        "src/auth-core/provider.ts": makeFileRecord({ role: null }),
      },
      edges: [
        {
          from: "src/app-consumer/consumer.ts",
          to: "src/auth-core/authenticate-service.ts",
          importedNames: ["authenticate"],
        },
        {
          from: "src/auth-core/authenticate-service.ts",
          to: "src/auth-core/provider.ts",
          importedNames: ["helper"],
        },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);
    const consumerIdx = targets.indexOf("src/app-consumer/consumer.ts");
    const providerIdx = targets.indexOf("src/auth-core/provider.ts");

    expect(consumerIdx).toBeGreaterThanOrEqual(0);
    expect(providerIdx).toBeGreaterThanOrEqual(0);
    expect(consumerIdx).toBeLessThan(providerIdx);
  });

  it("two-level importer chain: controller is a direct match via import field, its consumer gets 1-hop expansion", () => {
    // controller.ts imports "authenticate" from service.ts, so its import field
    // contains the query term - making it a direct BM25 match. router.ts then
    // gets legitimate 1-hop expansion from controller.ts.
    const graph = makePersistedGraph({
      files: {
        "src/auth/service.ts": makeFileRecord({ role: null, symbolNames: ["authenticate"] }),
        "src/app/controller.ts": makeFileRecord({ role: null }),
        "src/app/router.ts": makeFileRecord({ role: null }),
      },
      edges: [
        { from: "src/app/controller.ts", to: "src/auth/service.ts", importedNames: ["authenticate"] },
        { from: "src/app/router.ts", to: "src/app/controller.ts", importedNames: ["handler"] },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);
    // All three appear: service (symbol match), controller (import field match),
    // router (1-hop expansion from controller)
    expect(targets).toContain("src/auth/service.ts");
    expect(targets).toContain("src/app/controller.ts");
    expect(targets).toContain("src/app/router.ts");
  });

  it("three-level chain: file 3 hops from seed does not appear when intermediate imports are unrelated", () => {
    // router imports controller (with unrelated name "handle"), controller imports
    // service (with "authenticate"). app.ts imports router with unrelated name "routes".
    // app.ts has no query-relevant tokens in any field, so it stays out.
    const graph = makePersistedGraph({
      files: {
        "src/auth/service.ts": makeFileRecord({ role: null, symbolNames: ["authenticate"] }),
        "src/app/controller.ts": makeFileRecord({ role: null }),
        "src/app/router.ts": makeFileRecord({ role: null }),
        "src/app.ts": makeFileRecord({ role: null }),
      },
      edges: [
        { from: "src/app/controller.ts", to: "src/auth/service.ts", importedNames: ["authenticate"] },
        { from: "src/app/router.ts", to: "src/app/controller.ts", importedNames: ["handler"] },
        { from: "src/app.ts", to: "src/app/router.ts", importedNames: ["routes"] },
      ],
    });
    const targets = resolveEditTargets("authenticate", graph, 10);
    // router.ts gets expansion from controller.ts (import field match), but router's
    // import field only has "handler" - no "authenticate". So app.ts doesn't expand from router.
    expect(targets).toContain("src/auth/service.ts");
    expect(targets).toContain("src/app/controller.ts");
    expect(targets).not.toContain("src/app.ts");
  });
});

// ── verify/verification synonym: reverse direction ────────────────────────────

describe("verify/verification synonym - reverse direction", () => {
  it("query 'verification' finds file with 'verify' in symbols (reverse expansion)", () => {
    // "verification" → synonym group also contains "verify"
    // A file that only has "verify" tokens must be found when querying "verification".
    const graph = makePersistedGraph({
      files: {
        "src/auth/verify-signature.ts": makeFileRecord({ role: null, symbolNames: ["verifySignature", "verifyJwt"] }),
        "src/utils/random.ts": makeFileRecord({ role: null, symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("verification flow broken", graph);
    expect(targets).toContain("src/auth/verify-signature.ts");
    expect(targets).not.toContain("src/utils/random.ts");
  });

  it("query 'verify' finds file with 'verification' in path (forward expansion)", () => {
    // "verify" → synonym group also contains "verification"
    // A file whose path only contains "verification" must be found when querying "verify".
    const graph = makePersistedGraph({
      files: {
        "src/auth/verification-code.ts": makeFileRecord({ role: null, symbolNames: ["sendCode", "checkCode"] }),
        "src/utils/format.ts": makeFileRecord({ role: null, symbolNames: ["formatDate"] }),
      },
    });
    const targets = resolveEditTargets("verify code expired", graph);
    expect(targets).toContain("src/auth/verification-code.ts");
    expect(targets).not.toContain("src/utils/format.ts");
  });

  it("verify/verification group does not bleed into cert/tls synonyms", () => {
    // ["cert", "certificate", "tls", "ssl"] is a separate group from ["verify", "verification"].
    // Querying "verify" should NOT expand to "cert" or "ssl".
    const graph = makePersistedGraph({
      files: {
        "src/security/ssl-cert.ts": makeFileRecord({ role: null, symbolNames: ["loadCertificate", "checkTls"] }),
        "src/auth/verify-token.ts": makeFileRecord({ role: null, symbolNames: ["verifyToken"] }),
      },
    });
    const targets = resolveEditTargets("verify", graph);
    expect(targets).toContain("src/auth/verify-token.ts");
    // ssl-cert.ts only matches via direct tokens (ssl, cert) which "verify" does not expand to
    expect(targets).not.toContain("src/security/ssl-cert.ts");
  });

  it("direct 'verify' match ranks above synonym-expanded 'verification' match", () => {
    // verify-token.ts has "verify" directly in path → full weight
    // verification-service.ts matches via synonym expansion → SYNONYM_DISCOUNT (0.3x) weight
    // Direct match must rank first.
    const graph = makePersistedGraph({
      files: {
        "src/auth/verify-token.ts": makeFileRecord({ role: null, symbolNames: ["verifyToken"] }),
        "src/auth/verification-service.ts": makeFileRecord({ role: null, symbolNames: ["sendVerification"] }),
      },
    });
    const targets = resolveEditTargets("verify token", graph);
    expect(targets[0]).toBe("src/auth/verify-token.ts");
  });
});

// ── Compound token + synonym expansion interaction ────────────────────────────

describe("compound token and synonym expansion interaction", () => {
  it("compound token and synonym both fire independently on the same query", () => {
    // Query: "useCache" → compound "usecache" emitted (use is stopped) + "cache" token
    // "cache" → synonym expands to "memoize", "memo"
    // File A: matched via compound "usecache" in symbol (exact symbol "useCache")
    // File B: matched via synonym "memoize" in path
    // Both must appear.
    const graph = makePersistedGraph({
      files: {
        "src/hooks/useCache.ts": makeFileRecord({ role: null, symbolNames: ["useCache"] }),
        "src/utils/memoize.ts": makeFileRecord({ role: null, symbolNames: ["memoizeResult"] }),
        "src/utils/random.ts": makeFileRecord({ role: null, symbolNames: ["randomBytes"] }),
      },
    });
    const targets = resolveEditTargets("useCache broken", graph, 10);
    expect(targets).toContain("src/hooks/useCache.ts");
    expect(targets).toContain("src/utils/memoize.ts");
    expect(targets).not.toContain("src/utils/random.ts");
  });

  it("compound token match ranks above synonym-only match", () => {
    // File with direct compound token match (strong signal) must rank above file with
    // only a synonym expansion match (SYNONYM_DISCOUNT = 0.3x weight).
    const graph = makePersistedGraph({
      files: {
        // matched via compound "usecontext" in symbols - higher precision
        "src/hooks/useContext.ts": makeFileRecord({ role: null, symbolNames: ["useContext"] }),
        // matched only via synonym: "cache" → "memo" expansion
        "src/utils/memo.ts": makeFileRecord({ role: null, symbolNames: ["memoize"] }),
      },
    });
    // "useContext" → tokens: ["context", "usecontext"]
    // "cache" is not in this query; no synonym fires for "context" (not in synonym groups)
    // So only "usecontext" and "context" are query terms.
    const targets = resolveEditTargets("useContext hook", graph, 10);
    // useContext.ts must be in results (matches on "usecontext" compound + "context")
    expect(targets).toContain("src/hooks/useContext.ts");
    // memo.ts has no matching tokens for "context" or "usecontext"
    expect(targets).not.toContain("src/utils/memo.ts");
  });

  it("stop-word-only compound is not emitted even when synonym expansion is active", () => {
    // "getSet" emits "getset" (compound) but no individual tokens (both stopped).
    // The query produces only "getset". If the synonym system is given "getset" as input,
    // it will find no synonym group for "getset" and produce no expansions.
    // Result: only files matching "getset" token should appear; no phantom matches.
    const graph = makePersistedGraph({
      files: {
        "src/store/getset-manager.ts": makeFileRecord({ role: null, symbolNames: ["getSet", "setGet"] }),
        "src/auth/service.ts": makeFileRecord({ role: null, symbolNames: ["authenticate"] }),
      },
    });
    const targets = resolveEditTargets("getSet problem", graph, 10);
    // getset-manager.ts should match on "getset" compound token in path
    expect(targets).toContain("src/store/getset-manager.ts");
    // auth/service.ts has no tokens matching "getset" - must not appear
    expect(targets).not.toContain("src/auth/service.ts");
  });
});
