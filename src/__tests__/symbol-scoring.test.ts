import { describe, it, expect, beforeAll } from "vitest";
import { initForLanguage, parseSource } from "../core/parsers/init.js";
import {
  tokenizeBody,
  extractSymbolBodiesFromRoot,
  extractSymbolStartLines,
  extractIntraFileCalls,
} from "../core/parsers/extract-symbols.js";

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
    const tokens = bodies.get("normalizeDefault")!;
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
    const tokens = bodies.get("process")!;
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
    const tokens = bodies.get("convert")!;
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
    const tokens = bodies.get("handleError")!;
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
    const tokens = bodies.get("tiny")!;
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
    expect(bodies.get("processUser")!).toContain("name");
  });

  it("handles function expressions (S6)", () => {
    const root = parse(`
      const helper = function(data) {
        return data.column;
      };
    `);
    const bodies = extractSymbolBodiesFromRoot(root, "typescript");
    expect(bodies.has("helper")).toBe(true);
    expect(bodies.get("helper")!).toContain("column");
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
    const classTokens = bodies.get("Driver")!;
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
    const tokens = bodies.get("repeat")!;
    // Should appear once despite three usages
    const valueCount = tokens.filter((t) => t === "value").length;
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
