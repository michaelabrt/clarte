import { describe, it, expect } from "vitest";
import { resolveEditTargets, tokenizeQuery } from "../cli/resolve-targets.js";
import { formatEditDirective } from "../cli/format-directive.js";
import type { PersistedGraph } from "../types/persisted-graph.js";
import { PERSISTED_GRAPH_VERSION } from "../types/persisted-graph.js";

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

function makeFileRecord(overrides?: Record<string, unknown>) {
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

// ── tokenizeQuery ────────────────────────────────────────────────────

describe("tokenizeQuery", () => {
  it("splits on spaces and strips stop words", () => {
    expect(tokenizeQuery("fix the auth bug in login")).toEqual(["auth", "login"]);
  });

  it("splits on path separators", () => {
    expect(tokenizeQuery("src/services/auth.ts")).toEqual(["src", "services", "auth", "ts"]);
  });

  it("returns empty for all stop words", () => {
    expect(tokenizeQuery("fix the bug")).toEqual([]);
  });

  it("drops single-character tokens", () => {
    expect(tokenizeQuery("a b cd")).toEqual(["cd"]);
  });

  it("deduplicates repeated keywords", () => {
    expect(tokenizeQuery("auth auth auth login")).toEqual(["auth", "login"]);
  });

  it("filters common programming terms", () => {
    expect(tokenizeQuery("default values in array column")).toEqual([]);
  });

  it("preserves discriminative function-name verbs", () => {
    expect(tokenizeQuery("parse the imports")).toEqual(["parse", "imports"]);
  });

  it("still suppresses generic getter/setter verbs", () => {
    expect(tokenizeQuery("get user data")).toEqual(["user", "data"]);
  });

  it("emits compound token when a stop word is stripped from a camelCase identifier", () => {
    // "use" is a stop word; "context" survives. Compound "usecontext" added because signal was lost.
    const result = tokenizeQuery("useContext");
    expect(result).toContain("context");
    expect(result).toContain("usecontext");
  });

  it("emits compound token for get-prefixed camelCase identifier", () => {
    // "get" is a stop word; "buffer" survives. Compound "getbuffer" should be added.
    const result = tokenizeQuery("getBuffer");
    expect(result).toContain("buffer");
    expect(result).toContain("getbuffer");
  });

  it("does not emit compound when no stop words are removed", () => {
    // "AbstractSqlite": neither "abstract" nor "sqlite" are stop words - no compound added.
    const result = tokenizeQuery("AbstractSqlite");
    expect(result).toContain("abstract");
    expect(result).toContain("sqlite");
    expect(result).not.toContain("abstractsqlite");
  });

  it("does not emit compound when no stop words are removed from multi-part identifier", () => {
    // "encodeJwtPart": "encode", "jwt", "part" - none are stop words.
    const result = tokenizeQuery("encodeJwtPart");
    expect(result).toContain("encode");
    expect(result).toContain("jwt");
    expect(result).toContain("part");
    expect(result).not.toContain("encodejwtpart");
  });

  it("does not emit compound for single-word term", () => {
    // "context" is a single word with no camelCase split - no compound generated.
    const result = tokenizeQuery("context");
    expect(result).toEqual(["context"]);
  });

  it("does not emit compound when the whole lowercased part is shorter than 4 chars", () => {
    // "isA" splits to ["is", "A"], lowered ["is", "a"]. validParts filters length >= 2:
    // "a" is only 1 char so validParts = ["is"], filtered removes stop word "is" leaving [].
    // The compound would be "isa" (3 chars) which is < 4, so it is not emitted.
    const result = tokenizeQuery("isA");
    expect(result).toEqual([]);
  });
});

// ── resolveEditTargets ───────────────────────────────────────────────

describe("resolveEditTargets", () => {
  it("returns empty array for empty query", () => {
    const graph = makeGraph({ files: { "src/auth.ts": makeFileRecord() } });
    expect(resolveEditTargets("", graph)).toEqual([]);
  });

  it("returns empty array for query with only stop words", () => {
    const graph = makeGraph({ files: { "src/auth.ts": makeFileRecord() } });
    expect(resolveEditTargets("fix the bug", graph)).toEqual([]);
  });

  it("matches file by basename keyword", () => {
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/utils.ts": makeFileRecord(),
      },
    });
    expect(resolveEditTargets("auth module", graph)).toEqual(["src/auth.ts"]);
  });

  it("matches file by directory name", () => {
    const graph = makeGraph({
      files: {
        "src/services/login.ts": makeFileRecord(),
        "src/utils/helpers.ts": makeFileRecord(),
      },
    });
    expect(resolveEditTargets("services issue", graph)).toEqual(["src/services/login.ts"]);
  });

  it("includes co-change partners above confidence threshold", () => {
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/session.ts": makeFileRecord(),
        "src/unrelated.ts": makeFileRecord(),
      },
      changeCoupling: [
        { fileA: "src/auth.ts", fileB: "src/session.ts", confidence: 0.8, coChangeCount: 5 },
        { fileA: "src/auth.ts", fileB: "src/unrelated.ts", confidence: 0.3, coChangeCount: 2 },
      ],
    });
    const targets = resolveEditTargets("auth problem", graph);
    expect(targets).toContain("src/auth.ts");
    expect(targets).toContain("src/session.ts");
    expect(targets).not.toContain("src/unrelated.ts");
  });

  it("respects maxTargets limit", () => {
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {};
    for (let i = 0; i < 10; i++) {
      files[`src/auth-${i}.ts`] = makeFileRecord();
    }
    const graph = makeGraph({ files });
    const targets = resolveEditTargets("auth", graph, 3);
    expect(targets).toHaveLength(3);
  });

  it("ranks exact basename match higher than partial", () => {
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/auth-helpers.ts": makeFileRecord(),
      },
    });
    const targets = resolveEditTargets("auth", graph);
    expect(targets[0]).toBe("src/auth.ts");
  });

  it("returns empty array when no files match", () => {
    const graph = makeGraph({
      files: {
        "src/database.ts": makeFileRecord(),
        "src/server.ts": makeFileRecord(),
      },
    });
    expect(resolveEditTargets("auth login", graph)).toEqual([]);
  });

  it("handles co-change partner on fileB side", () => {
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/config.ts": makeFileRecord(),
      },
      changeCoupling: [{ fileA: "src/config.ts", fileB: "src/auth.ts", confidence: 0.6, coChangeCount: 3 }],
    });
    const targets = resolveEditTargets("auth", graph);
    expect(targets).toContain("src/auth.ts");
    expect(targets).toContain("src/config.ts");
  });

  it("does not let symbol-rich files drown out precise path matches", () => {
    const graph = makeGraph({
      files: {
        "src/database/connections/sqlite.ts": makeFileRecord({ symbolNames: ["connect"] }),
        "src/driver.ts": makeFileRecord({
          symbolNames: Array.from({ length: 40 }, (_, i) => `method${i}Sqlite`),
        }),
      },
    });
    const targets = resolveEditTargets("sqlite", graph);
    expect(targets[0]).toBe("src/database/connections/sqlite.ts");
  });

  it("matches barrel file by re-exported names", () => {
    const graph = makeGraph({
      files: {
        "src/types/index.ts": makeFileRecord(),
        "src/types/graph.ts": makeFileRecord({ symbolNames: ["GraphNode"] }),
      },
      edges: [{ from: "src/app.ts", to: "src/types/index.ts", importedNames: ["GraphNode"] }],
    });
    const targets = resolveEditTargets("GraphNode missing", graph);
    expect(targets).toContain("src/types/index.ts");
  });

  it("matches file by defined symbol name", () => {
    const graph = makeGraph({
      files: {
        "src/runner.ts": makeFileRecord({ symbolNames: ["AbstractSqliteQueryRunner"] }),
        "src/logger.ts": makeFileRecord({ symbolNames: ["ConsoleLogger"] }),
      },
    });
    const targets = resolveEditTargets("sqlite query runner", graph);
    expect(targets[0]).toBe("src/runner.ts");
  });
});

// ── test-file proxy scoring ──────────────────────────────────────────

describe("test-file proxy scoring", () => {
  it("finds source file via its test file path", () => {
    const graph = makeGraph({
      files: {
        "src/driver/sqlite/SqliteQueryRunner.ts": makeFileRecord(),
        "src/utils/helpers.ts": makeFileRecord(),
        "test/driver/sqlite/SqliteQueryRunner.test.ts": makeFileRecord(),
      },
      testMapping: {
        "src/driver/sqlite/SqliteQueryRunner.ts": ["test/driver/sqlite/SqliteQueryRunner.test.ts"],
      },
    });
    const targets = resolveEditTargets("sqlite query runner", graph);
    expect(targets).toContain("src/driver/sqlite/SqliteQueryRunner.ts");
  });

  it("does not include the test file itself in results", () => {
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "test/auth.test.ts": makeFileRecord(),
      },
      testMapping: {
        "src/auth.ts": ["test/auth.test.ts"],
      },
    });
    const targets = resolveEditTargets("auth", graph);
    expect(targets).not.toContain("test/auth.test.ts");
  });

  it("does not override a higher direct BM25F score", () => {
    const graph = makeGraph({
      files: {
        "src/auth/login.ts": makeFileRecord({ symbolNames: ["authenticate", "validateToken"] }),
        "test/auth/login.test.ts": makeFileRecord(),
      },
      testMapping: {
        "src/auth/login.ts": ["test/auth/login.test.ts"],
      },
    });
    const targets = resolveEditTargets("auth login", graph);
    expect(targets[0]).toBe("src/auth/login.ts");
  });

  it("boosts source file when test matches but source does not", () => {
    // Source file has an opaque name; its test file encodes the feature
    const graph = makeGraph({
      files: {
        "src/core/processor.ts": makeFileRecord(),
        "src/utils.ts": makeFileRecord(),
        "test/core/markdown-renderer.test.ts": makeFileRecord(),
      },
      testMapping: {
        "src/core/processor.ts": ["test/core/markdown-renderer.test.ts"],
      },
    });
    const targets = resolveEditTargets("markdown renderer", graph);
    expect(targets).toContain("src/core/processor.ts");
  });
});

// ── offline scoring ───────────────────────────────────────────────────

describe("offline scoring - known queries", () => {
  it("sqlite acronym query finds query runner", () => {
    const graph = makeGraph({
      files: {
        "src/driver/sqlite/SqliteQueryRunner.ts": makeFileRecord({
          symbolNames: ["SqliteQueryRunner", "runQuery", "connect"],
        }),
        "src/platform/platform.ts": makeFileRecord({ symbolNames: ["getPlatform"] }),
        "src/util/StringUtils.ts": makeFileRecord({ symbolNames: ["simpleEnumToString", "titleCase"] }),
      },
      edges: [
        {
          from: "src/app.ts",
          to: "src/driver/sqlite/SqliteQueryRunner.ts",
          importedNames: ["SqliteQueryRunner"],
        },
      ],
    });
    const targets = resolveEditTargets("sqlite query runner check constraint fails", graph, 3);
    expect(targets).toContain("src/driver/sqlite/SqliteQueryRunner.ts");
  });

  it("enum helper query finds string utils", () => {
    const graph = makeGraph({
      files: {
        "src/util/StringUtils.ts": makeFileRecord({ symbolNames: ["simpleEnumToString", "titleCase"] }),
        "src/driver/Driver.ts": makeFileRecord({ symbolNames: ["connect", "disconnect"] }),
      },
    });
    const targets = resolveEditTargets("simpleEnumToString returns wrong value", graph, 3);
    expect(targets[0]).toBe("src/util/StringUtils.ts");
  });
});

// ── BM25F true field combination ─────────────────────────────────────

describe("BM25F scoring behavior", () => {
  it("term in both path and symbols scores higher than term in only one field", () => {
    // File A: term appears in both path and symbols
    // File B: term appears only in symbols
    const graph = makeGraph({
      files: {
        "src/auth/auth.ts": makeFileRecord({ symbolNames: ["authenticate", "authToken"] }),
        "src/core/session.ts": makeFileRecord({ symbolNames: ["authenticate", "authToken"] }),
      },
    });
    const targets = resolveEditTargets("auth", graph);
    // auth.ts has "auth" in both path and symbols; session.ts only in symbols
    expect(targets[0]).toBe("src/auth/auth.ts");
  });

  it("short document (3-token path) is not over-penalized relative to longer paths", () => {
    // With b=0.4 (vs default 0.75), short documents should score comparably
    // File A: short path "src/auth.ts" (3 tokens: src, auth, ts)
    // File B: long path with "auth" in a deep directory (many tokens)
    // Both have the query term "auth" in path, no synonym matches
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/services/internal/auth-helper-utils.ts": makeFileRecord(),
      },
    });

    const targets = resolveEditTargets("auth", graph);
    // Short exact match should score at least as well as the longer path match
    // (b=0.4 means less length normalization penalty for short docs)
    expect(targets).toContain("src/auth.ts");
    expect(targets[0]).toBe("src/auth.ts");
  });

  it("term appearing in both path and symbols combines pseudo-tf before saturation", () => {
    // True BM25F: weighted pseudo-tf combines across fields before saturation.
    // File with term in path AND symbols should outscore file with term in symbols only.
    const graph = makeGraph({
      files: {
        // "cache" appears in path tokens AND as a symbol
        "src/cache/handler.ts": makeFileRecord({ symbolNames: ["cache", "cacheResult"] }),
        // "cache" appears only in symbols
        "src/core/engine.ts": makeFileRecord({ symbolNames: ["cache", "cacheResult"] }),
      },
    });

    const targets = resolveEditTargets("cache", graph);
    // cache/handler.ts has "cache" in both path (from directory) and symbols
    // engine.ts has "cache" only in symbols
    expect(targets[0]).toBe("src/cache/handler.ts");
  });

  it("path match beats single symbol match due to PATH_WEIGHT > SYMBOL_WEIGHT", () => {
    // Path tokens are weighted 1.5x vs 1.0x for symbols.
    // A file with a term in the path should beat one with a single symbol match.
    const graph = makeGraph({
      files: {
        "src/cache.ts": makeFileRecord({ symbolNames: ["initStore"] }),
        "src/core/storage.ts": makeFileRecord({
          // Single "cache" in symbols via camelCase split, no path match
          symbolNames: ["cacheManager"],
        }),
      },
    });

    const targets = resolveEditTargets("cache", graph);
    // cache.ts: path pseudo-tf = 1.5 * 1/norm. storage.ts: symbol pseudo-tf = 1.0 * 1/norm.
    // PATH_WEIGHT (1.5) > SYMBOL_WEIGHT (1.0), so path match wins.
    expect(targets[0]).toBe("src/cache.ts");
  });
});

// ── BM25F import field ────────────────────────────────────────────────

describe("BM25F import field", () => {
  it("finds a file whose own path/symbols do not match but whose imports do", () => {
    // handler.ts has no path/symbol overlap with "form validation"
    // but it imports from validators/form-validator.ts with importedNames ["validateForm"]
    const graph = makeGraph({
      files: {
        "src/handler.ts": makeFileRecord(),
        "src/validators/form-validator.ts": makeFileRecord({ symbolNames: ["validateForm"] }),
        "src/unrelated.ts": makeFileRecord(),
      },
      edges: [
        {
          from: "src/handler.ts",
          to: "src/validators/form-validator.ts",
          importedNames: ["validateForm"],
        },
      ],
    });
    const targets = resolveEditTargets("form validation", graph);
    expect(targets).toContain("src/handler.ts");
  });

  it("a file matching via path, symbols AND imports scores higher than one matching only path and symbols", () => {
    // Both files match "form" via path. File A also has "form" in its imports via importedNames.
    const graph = makeGraph({
      files: {
        "src/form-handler.ts": makeFileRecord({ symbolNames: ["handleForm"] }),
        "src/form-render.ts": makeFileRecord({ symbolNames: ["renderForm"] }),
        "src/validators/form-validator.ts": makeFileRecord({ symbolNames: ["validateForm"] }),
      },
      edges: [
        {
          from: "src/form-handler.ts",
          to: "src/validators/form-validator.ts",
          importedNames: ["validateForm"],
        },
      ],
    });
    const targets = resolveEditTargets("form", graph, 3);
    // form-handler.ts matches path + symbols + imports; form-render.ts matches only path + symbols
    expect(targets.indexOf("src/form-handler.ts")).toBeLessThan(targets.indexOf("src/form-render.ts"));
  });

  it("strong path match ranks above a file that matches only via imports", () => {
    // auth.ts: "auth" appears in the path itself (strong signal)
    // consumer.ts: no path/symbol overlap with "auth", but imports from auth.ts
    const graph = makeGraph({
      files: {
        "src/auth.ts": makeFileRecord(),
        "src/consumer.ts": makeFileRecord(),
      },
      edges: [{ from: "src/consumer.ts", to: "src/auth.ts", importedNames: ["authenticate"] }],
    });
    const targets = resolveEditTargets("auth", graph, 2);
    expect(targets[0]).toBe("src/auth.ts");
  });
});

// ── formatEditDirective ──────────────────────────────────────────────

describe("formatEditDirective", () => {
  it("returns empty string for empty targets", () => {
    expect(formatEditDirective([])).toBe("");
  });

  it("formats single target", () => {
    const result = formatEditDirective(["src/auth.ts"]);
    expect(result).toBe(
      "Likely edit targets based on dependency analysis: `src/auth.ts`. Start editing after confirming the relevant code.",
    );
  });

  it("formats multiple targets", () => {
    const result = formatEditDirective(["src/auth.ts", "src/session.ts"]);
    expect(result).toContain("`src/auth.ts`");
    expect(result).toContain("`src/session.ts`");
    expect(result).toMatch(/^Likely edit targets/);
    expect(result).toMatch(/Start editing after confirming/);
  });
});
