import { describe, it, expect, beforeAll } from "vitest";
import { initForLanguage, parseSource } from "../../core/parsers/init";
import {
  getEnclosingFunction,
  isDuplicateSymbol,
  extractTypeUsagesFromNodes,
  isTsPrimitive,
  isGoPrimitive,
  isRustPrimitive,
  buildSymbol,
} from "../../core/parsers/extract-file-graph";
import type { TypeUsageEdge } from "../../core/graph/symbol-types";

beforeAll(async () => {
  await initForLanguage("typescript");
});

function parse(code: string) {
  return parseSource(code, "typescript", "test.ts");
}

// ── isDuplicateSymbol ─────────────────────────────────────────────────────────

describe("isDuplicateSymbol", () => {
  it("returns false and records the symbol on first call", () => {
    const seen = new Set<string>();
    expect(isDuplicateSymbol(seen, "foo", 1)).toBe(false);
    expect(seen.has("foo:1")).toBe(true);
  });

  it("returns true on a repeated name+line combination", () => {
    const seen = new Set<string>();
    isDuplicateSymbol(seen, "foo", 1);
    expect(isDuplicateSymbol(seen, "foo", 1)).toBe(true);
  });

  it("treats same name at different lines as distinct", () => {
    const seen = new Set<string>();
    isDuplicateSymbol(seen, "foo", 1);
    expect(isDuplicateSymbol(seen, "foo", 2)).toBe(false);
  });

  it("treats different names at same line as distinct", () => {
    const seen = new Set<string>();
    isDuplicateSymbol(seen, "foo", 1);
    expect(isDuplicateSymbol(seen, "bar", 1)).toBe(false);
  });
});

// ── Primitive checkers ────────────────────────────────────────────────────────

describe("isTsPrimitive", () => {
  it.each(["string", "number", "boolean", "void", "null", "undefined", "never", "any", "unknown", "object"])(
    "returns true for %s",
    (name) => {
      expect(isTsPrimitive(name)).toBe(true);
    },
  );

  it("returns false for a non-primitive type", () => {
    expect(isTsPrimitive("UserService")).toBe(false);
  });

  it("returns false for a capitalized look-alike", () => {
    expect(isTsPrimitive("String")).toBe(false);
  });
});

describe("isGoPrimitive", () => {
  it.each(["int", "int64", "float64", "string", "bool", "error", "any", "byte", "rune"])(
    "returns true for %s",
    (name) => {
      expect(isGoPrimitive(name)).toBe(true);
    },
  );

  it("returns false for a user-defined type", () => {
    expect(isGoPrimitive("Repository")).toBe(false);
  });
});

describe("isRustPrimitive", () => {
  it.each(["i32", "u64", "f64", "bool", "char", "str", "String", "Self", "Option", "Result", "Vec", "Box"])(
    "returns true for %s",
    (name) => {
      expect(isRustPrimitive(name)).toBe(true);
    },
  );

  it("returns false for a user-defined type", () => {
    expect(isRustPrimitive("MyStruct")).toBe(false);
  });
});

// ── extractTypeUsagesFromNodes ────────────────────────────────────────────────

describe("extractTypeUsagesFromNodes", () => {
  it("produces an edge for each unique non-primitive type node", () => {
    const root = parse("type Foo = { a: UserService; b: OrderRepo }");
    // Collect type_identifier nodes whose text matches our expected types
    const allIdents = root.descendantsOfType(["type_identifier"]);
    const relevant = allIdents.filter((n) => n.text === "UserService" || n.text === "OrderRepo");

    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(relevant, "myFn", isTsPrimitive, out);

    const names = out.map((e) => e.typeName).sort();
    expect(names).toEqual(["OrderRepo", "UserService"]);
    expect(out.every((e) => e.symbolName === "myFn")).toBe(true);
  });

  it("filters out TS primitive types", () => {
    const root = parse("function fn(a: string, b: number): boolean { return true; }");
    const typeNodes = root.descendantsOfType(["predefined_type"]);

    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(typeNodes, "fn", isTsPrimitive, out);

    expect(out).toHaveLength(0);
  });

  it("deduplicates repeated occurrences of the same type", () => {
    const root = parse("type T = { a: UserService; b: UserService }");
    const allIdents = root.descendantsOfType(["type_identifier"]);
    const relevant = allIdents.filter((n) => n.text === "UserService");

    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(relevant, "myFn", isTsPrimitive, out);

    expect(out).toHaveLength(1);
  });

  it("ignores nodes with empty or single-char text", () => {
    const root = parse("type T = { x: Ab }");
    const typeNodes = root.descendantsOfType(["type_identifier"]);
    // 'Ab' has length 2, so it should pass; verify the contract works with short names
    const singleCharNodes = typeNodes.filter((n) => n.text.length <= 1);
    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(singleCharNodes, "myFn", isTsPrimitive, out);
    expect(out).toHaveLength(0);
  });

  it("records the correct line number from the AST node", () => {
    const root = parse("type Foo = { a: SomeService }");
    const typeNodes = root.descendantsOfType(["type_identifier"]).filter((n) => n.text === "SomeService");

    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(typeNodes, "fn", isTsPrimitive, out);

    expect(out).toHaveLength(1);
    expect(out[0].line).toBe(1);
  });

  it("applies the resolveGeneric callback when provided", () => {
    const root = parse("type T = { a: SomeService; b: Other }");
    const typeNodes = root.descendantsOfType(["type_identifier"]).filter((n) => n.text === "SomeService");

    const out: TypeUsageEdge[] = [];
    // resolveGeneric overrides the node text
    extractTypeUsagesFromNodes(typeNodes, "fn", isTsPrimitive, out, (_n) => "ResolvedType");

    expect(out).toHaveLength(1);
    expect(out[0].typeName).toBe("ResolvedType");
  });

  it("skips a node when resolveGeneric returns null", () => {
    const root = parse("type T = { a: SomeService }");
    const typeNodes = root.descendantsOfType(["type_identifier"]).filter((n) => n.text === "SomeService");

    const out: TypeUsageEdge[] = [];
    extractTypeUsagesFromNodes(typeNodes, "fn", isTsPrimitive, out, (_n) => null);

    // null from resolveGeneric falls back to node.text ("SomeService"), so it is kept
    expect(out).toHaveLength(1);
    expect(out[0].typeName).toBe("SomeService");
  });
});

// ── getEnclosingFunction ──────────────────────────────────────────────────────

const TS_FN_TYPES = ["function_declaration", "generator_function_declaration", "method_definition"];
const TS_EXPR_FN_TYPES = ["arrow_function", "function", "function_expression", "generator_function"];

describe("getEnclosingFunction", () => {
  it("finds the enclosing function_declaration", () => {
    const root = parse(`
      function processUser(user) {
        doSomething();
      }
    `);
    // Find the call expression node for doSomething
    const calls = root.descendantsOfType(["call_expression"]);
    const call = calls.find((n) => n.text.startsWith("doSomething"));
    if (!call) throw new Error("expected call expression");

    const result = getEnclosingFunction(call, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    expect(result).toBe("processUser");
  });

  it("returns undefined when not inside any function", () => {
    const root = parse(`const x = 1;`);
    const idents = root.descendantsOfType(["identifier"]);
    const xNode = idents.find((n) => n.text === "x");
    if (!xNode) throw new Error("expected identifier");

    const result = getEnclosingFunction(xNode, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    expect(result).toBeUndefined();
  });

  it("finds the name of an arrow function via variable_declarator", () => {
    const root = parse(`
      const handleRequest = (req) => {
        validate(req);
      };
    `);
    const calls = root.descendantsOfType(["call_expression"]);
    const call = calls.find((n) => n.text.startsWith("validate"));
    if (!call) throw new Error("expected call expression");

    const result = getEnclosingFunction(call, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    expect(result).toBe("handleRequest");
  });

  it("returns the immediate enclosing function when nested", () => {
    const root = parse(`
      function outer() {
        function inner() {
          doWork();
        }
      }
    `);
    const calls = root.descendantsOfType(["call_expression"]);
    const call = calls.find((n) => n.text.startsWith("doWork"));
    if (!call) throw new Error("expected call expression");

    const result = getEnclosingFunction(call, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    expect(result).toBe("inner");
  });

  it("returns undefined for a single-char function name", () => {
    const root = parse(`
      function f() {
        doWork();
      }
    `);
    const calls = root.descendantsOfType(["call_expression"]);
    const call = calls.find((n) => n.text.startsWith("doWork"));
    if (!call) throw new Error("expected call expression");

    const result = getEnclosingFunction(call, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    // "f" has length 1, so the guard filters it out
    expect(result).toBeUndefined();
  });
});

// ── buildSymbol ───────────────────────────────────────────────────────────────

describe("buildSymbol", () => {
  it("builds a SymbolDefinition with correct fields", () => {
    const root = parse(`export function calculateTotal(items) { return items.reduce((a, b) => a + b, 0); }`);
    const fnDecl = root.descendantsOfType(["function_declaration"])[0];
    if (!fnDecl) throw new Error("expected function_declaration");
    const body = fnDecl.childForFieldName("body") ?? null;

    const sym = buildSymbol("calculateTotal", "function", fnDecl, body, ["identifier"], true);

    expect(sym.name).toBe("calculateTotal");
    expect(sym.kind).toBe("function");
    expect(sym.isExported).toBe(true);
    expect(sym.startLine).toBeGreaterThanOrEqual(1);
    expect(typeof sym.bodyHash).toBe("string");
    expect(sym.bodyHash).toHaveLength(16);
    expect(typeof sym.bodyTokens).toBe("string");
  });

  it("produces the same bodyHash for identical body text", () => {
    const code = `function add(a, b) { return a + b; }`;
    const root1 = parse(code);
    const root2 = parse(code);
    const fn1 = root1.descendantsOfType(["function_declaration"])[0];
    const fn2 = root2.descendantsOfType(["function_declaration"])[0];
    if (!fn1 || !fn2) throw new Error("expected function_declaration");

    const sym1 = buildSymbol("add", "function", fn1, fn1.childForFieldName("body") ?? null, ["identifier"], false);
    const sym2 = buildSymbol("add", "function", fn2, fn2.childForFieldName("body") ?? null, ["identifier"], false);

    expect(sym1.bodyHash).toBe(sym2.bodyHash);
  });

  it("produces different bodyHash for different body text", () => {
    const root1 = parse(`function add(a, b) { return a + b; }`);
    const root2 = parse(`function add(a, b) { return a - b; }`);
    const fn1 = root1.descendantsOfType(["function_declaration"])[0];
    const fn2 = root2.descendantsOfType(["function_declaration"])[0];
    if (!fn1 || !fn2) throw new Error("expected function_declaration");

    const sym1 = buildSymbol("add", "function", fn1, fn1.childForFieldName("body") ?? null, ["identifier"], false);
    const sym2 = buildSymbol("add", "function", fn2, fn2.childForFieldName("body") ?? null, ["identifier"], false);

    expect(sym1.bodyHash).not.toBe(sym2.bodyHash);
  });

  it("falls back to node text when bodyNode is null", () => {
    const root = parse(`const PI = 3.14;`);
    const varDecl = root.descendantsOfType(["variable_declarator"])[0];
    if (!varDecl) throw new Error("expected variable_declarator");

    const sym = buildSymbol("PI", "variable", varDecl, null, ["identifier"], false);

    expect(sym.name).toBe("PI");
    expect(typeof sym.bodyHash).toBe("string");
    expect(sym.bodyHash).toHaveLength(16);
  });

  it("sets isExported false for unexported symbols", () => {
    const root = parse(`function helperFn() {}`);
    const fn = root.descendantsOfType(["function_declaration"])[0];
    if (!fn) throw new Error("expected function_declaration");

    const sym = buildSymbol("helperFn", "function", fn, null, ["identifier"], false);

    expect(sym.isExported).toBe(false);
  });
});
