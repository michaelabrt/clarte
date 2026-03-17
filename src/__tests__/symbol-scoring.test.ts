import { describe, it, expect, beforeAll } from "vitest";
import { initForLanguage, parseSource } from "../core/parsers/init";
import {
  tokenizeBody,
  extractSymbolBodiesFromRoot,
  extractSymbolStartLines,
  extractIntraFileCalls,
} from "../core/parsers/extract-symbols";
import { computeSymbolAuthority } from "../core/graph/persist";
import type { EdgeRecord, FileRecord } from "../core/types/persisted-graph";

beforeAll(async () => {
  await initForLanguage("typescript");
});

function parse(code: string) {
  return parseSource(code, "typescript", "test.ts");
}

// ── tokenizeBody ─────────────────────────────────────────────────────────────

describe("tokenizeBody", () => {
  it("splits camelCase and lowercases", () => {
    expect(tokenizeBody("normalizeDefault")).toEqual(["normalize", "default"]);
  });

  it("splits on non-alphanumeric", () => {
    expect(tokenizeBody("user_name")).toEqual(["user", "name"]);
  });

  it("filters tokens shorter than 2 chars", () => {
    expect(tokenizeBody("a")).toEqual([]);
    // "iO" splits to ["i", "O"], both length 1 after lowercase, both filtered
    expect(tokenizeBody("iO")).toEqual([]);
    // "xPos" splits to ["x", "Pos"], "x" filtered, "pos" kept
    expect(tokenizeBody("xPos")).toEqual(["pos"]);
  });

  it("handles PascalCase", () => {
    expect(tokenizeBody("UserCreateRequest")).toEqual(["user", "create", "request"]);
  });

  it("returns empty for empty input", () => {
    expect(tokenizeBody("")).toEqual([]);
  });
});

// ── extractSymbolBodiesFromRoot ──────────────────────────────────────────────

describe("extractSymbolBodiesFromRoot", () => {
  it("extracts body tokens for function declarations", () => {
    const root = parse(`
      function normalizeDefault(column, value) {
        if (column.type === "simple-enum") {
          return value;
        }
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    expect(bodies.has("normalizeDefault")).toBe(true);
    const tokens = bodies.get("normalizeDefault");
    expect(tokens).toBeDefined();
    expect(tokens).toContain("column");
    expect(tokens).toContain("type");
    expect(tokens).toContain("value");
  });

  it("collects property_identifier nodes", () => {
    const root = parse(`
      function process(data) {
        return data.result.value;
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    const tokens = bodies.get("process");
    expect(tokens).toBeDefined();
    // property_identifier captures "result" and "value" from member expressions
    expect(tokens).toContain("result");
    expect(tokens).toContain("value");
  });

  it("collects type_identifier from body", () => {
    const root = parse(`
      function convert(input: UserRequest): UserResponse {
        const mapped: MappedType = {} as MappedType;
        return mapped;
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    const tokens = bodies.get("convert");
    expect(tokens).toBeDefined();
    // S5: type annotations from parameters and return type
    expect(tokens).toContain("user");
    expect(tokens).toContain("request");
    expect(tokens).toContain("response");
  });

  it("collects string_fragment tokens within bounds (S4)", () => {
    const root = parse(`
      function handleError(err) {
        throw new Error("user not found");
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    const tokens = bodies.get("handleError");
    expect(tokens).toBeDefined();
    expect(tokens).toContain("user");
    expect(tokens).toContain("found");
  });

  it("filters short string fragments (S4)", () => {
    const root = parse(`
      function tiny() {
        const x = "ab";
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    const tokens = bodies.get("tiny");
    expect(tokens).toBeDefined();
    // "ab" is length 2, below the 4-char minimum for string_fragment
    expect(tokens).not.toContain("ab");
  });

  it("handles arrow functions assigned to const", () => {
    const root = parse(`
      export const processUser = (user) => {
        return user.name.toLowerCase();
      };
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    expect(bodies.has("processUser")).toBe(true);
    const processUserTokens = bodies.get("processUser");
    expect(processUserTokens).toBeDefined();
    expect(processUserTokens).toContain("name");
  });

  it("handles function expressions (S6)", () => {
    const root = parse(`
      const helper = function(data) {
        return data.column;
      };
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    expect(bodies.has("helper")).toBe(true);
    const helperTokens = bodies.get("helper");
    expect(helperTokens).toBeDefined();
    expect(helperTokens).toContain("column");
  });

  it("handles class methods", () => {
    const root = parse(`
      class Driver {
        loadTables() {
          return this.connection.query("SELECT");
        }
        normalizeDefault(col) {
          return col.defaultValue;
        }
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    // Class itself gets tokens from all method bodies
    expect(bodies.has("Driver")).toBe(true);
    const classTokens = bodies.get("Driver");
    expect(classTokens).toBeDefined();
    expect(classTokens).toContain("connection");
    expect(classTokens).toContain("default");
    // Individual methods also captured
    expect(bodies.has("loadTables")).toBe(true);
    expect(bodies.has("normalizeDefault")).toBe(true);
  });

  it("filters computed property names (I4)", () => {
    const root = parse(`
      class Iter {
        [Symbol.iterator]() {
          return this.items;
        }
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    // Computed property name should be filtered; only "Iter" class indexed
    expect(bodies.has("Iter")).toBe(true);
    // The computed method shouldn't appear as its own entry
    expect(bodies.has("[Symbol.iterator]")).toBe(false);
    expect(bodies.has("Symbol")).toBe(false);
  });

  it("deduplicates tokens", () => {
    const root = parse(`
      function repeat() {
        const x = value + value + value;
      }
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    const tokens = bodies.get("repeat");
    expect(tokens).toBeDefined();
    // Should appear once despite three usages
    const valueCount = (tokens || []).filter((t) => t === "value").length;
    expect(valueCount).toBe(1);
  });
});

// ── extractSymbolStartLines ──────────────────────────────────────────────────

describe("extractSymbolStartLines", () => {
  it("returns 1-based line numbers", () => {
    const root = parse(`function foo() {}
function bar() {}
class Baz {}`);
    const lines = extractSymbolStartLines(root, "typescript");
    expect(lines.get("foo")).toBe(1);
    expect(lines.get("bar")).toBe(2);
    expect(lines.get("Baz")).toBe(3);
  });

  it("handles arrow functions", () => {
    const root = parse(`const handler = () => {};`);
    const lines = extractSymbolStartLines(root, "typescript");
    expect(lines.has("handler")).toBe(true);
    expect(lines.get("handler")).toBe(1);
  });
});

// ── extractIntraFileCalls ────────────────────────────────────────────────────

describe("extractIntraFileCalls", () => {
  it("detects direct function calls", () => {
    const root = parse(`
      function helper() { return 1; }
      function main() { return helper(); }
    `);
    const symbols = new Set(["helper", "main"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    expect(calls).toEqual([{ caller: "main", callee: "helper" }]);
  });

  it("detects this.method() calls in classes", () => {
    const root = parse(`
      class Driver {
        loadTables() { return this.normalize(); }
        normalize() { return 1; }
      }
    `);
    const symbols = new Set(["Driver", "loadTables", "normalize"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    expect(calls.some((c) => c.caller === "loadTables" && c.callee === "normalize")).toBe(true);
  });

  it("detects new_expression calls", () => {
    const root = parse(`
      class Builder {}
      function create() { return new Builder(); }
    `);
    const symbols = new Set(["Builder", "create"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    expect(calls.some((c) => c.caller === "create" && c.callee === "Builder")).toBe(true);
  });

  it("filters top-level calls (I5)", () => {
    const root = parse(`
      function setup() {}
      setup();
    `);
    const symbols = new Set(["setup"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    // Top-level call has no enclosing function name, should be filtered
    expect(calls.length).toBe(0);
  });

  it("only emits edges where both caller and callee are in symbolNames", () => {
    const root = parse(`
      function known() { unknown(); }
      function unknown() { known(); }
    `);
    // Only "known" is in the symbol set
    const symbols = new Set(["known"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    expect(calls.length).toBe(0);
  });

  it("deduplicates edges", () => {
    const root = parse(`
      function a() { b(); b(); }
      function b() { return 1; }
    `);
    const symbols = new Set(["a", "b"]);
    const calls = extractIntraFileCalls(root, "typescript", symbols);
    expect(calls.length).toBe(1);
  });
});

// ── computeSymbolAuthority ───────────────────────────────────────────────────

describe("computeSymbolAuthority", () => {
  function makeFile(overrides: Partial<FileRecord> = {}): FileRecord {
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

  it("cross-file imports count more than intra-file callers (I7)", () => {
    const files: Record<string, FileRecord> = {
      "a.ts": makeFile({ symbolNames: ["foo", "bar"] }),
    };
    const edges: EdgeRecord[] = [
      { from: "b.ts", to: "a.ts", importedNames: ["foo"] },
      { from: "c.ts", to: "a.ts", importedNames: ["foo"] },
    ];
    const intraCalls = new Map([["a.ts", [{ caller: "bar", callee: "foo" }]]]);
    const result = computeSymbolAuthority(edges, files, intraCalls);
    const auth = result.get("a.ts");
    expect(auth).toBeDefined();
    // foo: 2 cross-file imports (weight 2.0) + 1 intra-file caller (weight 0.3) = 2.3
    // bar: 0 imports + 0 callers = 0 (not in result because it has no callers)
    // foo should be the max (1.0 after normalization)
    expect(auth?.foo).toBe(1);
  });

  it("type-only edges discounted at 0.3x (S7)", () => {
    const files: Record<string, FileRecord> = {
      "a.ts": makeFile({ symbolNames: ["Foo", "Bar"] }),
    };
    const edges: EdgeRecord[] = [
      { from: "b.ts", to: "a.ts", importedNames: ["Foo"], isTypeOnly: true },
      { from: "c.ts", to: "a.ts", importedNames: ["Bar"] },
    ];
    const result = computeSymbolAuthority(edges, files, new Map());
    const auth = result.get("a.ts");
    expect(auth).toBeDefined();
    // Bar has weight 1.0 (runtime import), Foo has weight 0.3 (type-only)
    // After max normalization: Bar = 1.0, Foo = 0.3
    expect(auth?.Bar).toBe(1);
    expect(auth?.Foo).toBe(0.3);
  });

  it("normalizes per-file to [0,1]", () => {
    const files: Record<string, FileRecord> = {
      "a.ts": makeFile({ symbolNames: ["x", "y"] }),
    };
    const edges: EdgeRecord[] = [
      { from: "b.ts", to: "a.ts", importedNames: ["x"] },
      { from: "c.ts", to: "a.ts", importedNames: ["x"] },
      { from: "d.ts", to: "a.ts", importedNames: ["x"] },
      { from: "e.ts", to: "a.ts", importedNames: ["y"] },
    ];
    const result = computeSymbolAuthority(edges, files, new Map());
    const auth = result.get("a.ts");
    expect(auth).toBeDefined();
    // x: 3 imports → 1.0, y: 1 import → 0.333
    expect(auth?.x).toBe(1);
    expect(auth?.y).toBeCloseTo(0.333, 2);
  });
});

// ── Grammar check (S6) ──────────────────────────────────────────────────────

describe("grammar check (S6)", () => {
  it("function expression node type is handled", () => {
    // Verify that const f = function() {} is captured regardless of
    // whether tree-sitter reports "function" or "function_expression"
    const root = parse(`const myFunc = function(data) { return data.value; };`);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    expect(bodies.has("myFunc")).toBe(true);
    const lines = extractSymbolStartLines(root, "typescript");
    expect(lines.has("myFunc")).toBe(true);
  });

  it("generator function expression is handled", () => {
    const root = parse(`const gen = function*(items) { yield items.next; };`);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    // generator_function may or may not be captured depending on grammar;
    // at minimum it should not throw
    if (bodies.has("gen")) {
      expect(bodies.get("gen")).toContain("items");
    }
  });
});

// ── Symbol BM25+ scoring (integration) ──────────────────────────────────────
// These tests verify the scoring logic from the PROMPT_SCRIPT by reimplementing
// the same algorithm here. The PROMPT_SCRIPT is a string template so we can't
// import from it directly.

describe("symbol BM25+ scoring logic", () => {
  // Reimplement the PROMPT_SCRIPT's symBM25 for testing
  const SYM_K1 = 1.2;
  const SYM_B = 0.4;
  const SYM_DELTA = 1.0;
  const NAME_W = 0.5;
  const AUTH_W = 0.3;

  function symBM25(
    tokens: string[],
    terms: string[],
    discount: number,
    symN: number,
    symDf: Map<string, number>,
    avgBL: number,
  ): number {
    let sc = 0;
    for (const t of terms) {
      const tf = tokens.filter((tok) => tok === t).length;
      if (tf === 0) continue;
      const df = symDf.get(t) || 1;
      const idf = Math.log((symN - df + 0.5) / (df + 0.5) + 1);
      const normTf = tf / (1 - SYM_B + SYM_B * (tokens.length / Math.max(avgBL, 1)));
      sc += discount * idf * ((normTf * (SYM_K1 + 1)) / (normTf + SYM_K1) + SYM_DELTA);
    }
    return sc;
  }

  function scoreSymbol(
    bodyTokens: string[],
    nameTokens: string[],
    queryTerms: string[],
    authority: number,
    symN: number,
    symDf: Map<string, number>,
    avgBL: number,
  ): number {
    const bodyScore = symBM25(bodyTokens, queryTerms, 1, symN, symDf, avgBL);
    const nameScore = symBM25(nameTokens, queryTerms, 1, symN, symDf, avgBL);
    return bodyScore + NAME_W * nameScore + AUTH_W * authority;
  }

  // Build corpus stats from a set of symbol bodies
  function buildCorpus(symbols: Record<string, string[]>) {
    let symN = 0;
    const symDf = new Map<string, number>();
    let totalLen = 0;
    for (const toks of Object.values(symbols)) {
      symN++;
      totalLen += toks.length;
      const seen = new Set(toks);
      for (const t of seen) symDf.set(t, (symDf.get(t) || 0) + 1);
    }
    return { symN, symDf, avgBL: symN > 0 ? totalLen / symN : 1 };
  }

  it("normalizeDefault ranks high when body matches query tokens that name doesn't", () => {
    const bodies: Record<string, string[]> = {
      normalizeDefault: ["column", "type", "simple", "enum", "value", "normalize", "default"],
      createConnection: ["driver", "options", "host", "port", "create", "connection"],
      loadTables: ["query", "table", "schema", "load", "tables"],
    };
    const { symN, symDf, avgBL } = buildCorpus(bodies);
    const query = ["sqlite", "check", "constraint", "simple", "enum", "array"];

    const scoreND = scoreSymbol(bodies.normalizeDefault, ["normalize", "default"], query, 0, symN, symDf, avgBL);
    const scoreCC = scoreSymbol(bodies.createConnection, ["create", "connection"], query, 0, symN, symDf, avgBL);
    const scoreLT = scoreSymbol(bodies.loadTables, ["load", "tables"], query, 0, symN, symDf, avgBL);

    // normalizeDefault body has "simple" and "enum" matching the query
    expect(scoreND).toBeGreaterThan(scoreCC);
    expect(scoreND).toBeGreaterThan(scoreLT);
  });

  it("delta term ensures short function bodies get non-zero scores (S1)", () => {
    // A very short function body with one matching token
    const bodies: Record<string, string[]> = {
      tiny: ["column"],
      large: ["column", "data", "result", "item", "value", "key", "options", "config"],
    };
    const { symN, symDf, avgBL } = buildCorpus(bodies);
    const query = ["column"];

    const scoreTiny = symBM25(bodies.tiny, query, 1, symN, symDf, avgBL);
    const scoreLarge = symBM25(bodies.large, query, 1, symN, symDf, avgBL);

    // Both should score > 0 (delta ensures minimum contribution)
    expect(scoreTiny).toBeGreaterThan(0);
    expect(scoreLarge).toBeGreaterThan(0);
    // Without delta, tiny would be penalized by length normalization (dl < avgdl).
    // With delta, the gap between tiny and large is smaller.
  });

  it("IDF downweights ubiquitous terms", () => {
    // "value" appears in every function, "normalize" appears in one
    const bodies: Record<string, string[]> = {
      fn1: ["value", "data", "normalize"],
      fn2: ["value", "data", "process"],
      fn3: ["value", "data", "transform"],
    };
    const { symN, symDf, avgBL } = buildCorpus(bodies);

    // Score for "normalize" (rare) vs "value" (ubiquitous)
    const scoreNormalize = symBM25(bodies.fn1, ["normalize"], 1, symN, symDf, avgBL);
    const scoreValue = symBM25(bodies.fn1, ["value"], 1, symN, symDf, avgBL);

    // "normalize" has higher IDF (appears in 1/3 docs) than "value" (appears in 3/3)
    expect(scoreNormalize).toBeGreaterThan(scoreValue);
  });

  it("additive combination: authority boosts but doesn't override content", () => {
    const bodies: Record<string, string[]> = {
      relevant: ["sqlite", "column", "enum"],
      important: ["driver", "options", "host"],
    };
    const { symN, symDf, avgBL } = buildCorpus(bodies);
    const query = ["sqlite", "column", "enum"];

    // relevant: high body match, low authority
    const scoreRelevant = scoreSymbol(bodies.relevant, ["relevant"], query, 0.1, symN, symDf, avgBL);
    // important: no body match, high authority
    const scoreImportant = scoreSymbol(bodies.important, ["important"], query, 1.0, symN, symDf, avgBL);

    // Content match should win over pure authority
    expect(scoreRelevant).toBeGreaterThan(scoreImportant);
  });

  it("synonym expansion propagates to body matching (S2)", () => {
    const bodies: Record<string, string[]> = {
      authHandler: ["auth", "session", "token", "verify"],
      dataHandler: ["data", "process", "transform"],
    };
    const { symN, symDf, avgBL } = buildCorpus(bodies);

    // Direct query: "authentication" - after synonym expansion, "auth" should match
    const directTerms = ["authentication"];
    const synonymTerms = ["auth", "authorize", "authorization"];

    const scoreAuth =
      symBM25(bodies.authHandler, directTerms, 1, symN, symDf, avgBL) +
      symBM25(bodies.authHandler, synonymTerms, 0.3, symN, symDf, avgBL);
    const scoreData =
      symBM25(bodies.dataHandler, directTerms, 1, symN, symDf, avgBL) +
      symBM25(bodies.dataHandler, synonymTerms, 0.3, symN, symDf, avgBL);

    // authHandler should score higher because "auth" matches via synonym expansion
    expect(scoreAuth).toBeGreaterThan(scoreData);
  });
});
