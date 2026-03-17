import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter } from "../../core/parsers/init";
import { parseImportsAst } from "../../core/parsers/parse-imports";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseImportsAst - Java edge cases", () => {
  it("parses standard import", () => {
    const result = parseImportsAst("import com.example.Foo;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("com.example.Foo");
    expect(result[0].importedNames).toEqual(["Foo"]);
  });

  it("parses wildcard import", () => {
    const result = parseImportsAst("import com.example.util.*;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("com.example.util.*");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses static import", () => {
    const result = parseImportsAst("import static com.example.Bar.method;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("method");
  });

  it("parses static wildcard import", () => {
    const result = parseImportsAst("import static com.example.Bar.*;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses inner class import", () => {
    const result = parseImportsAst("import com.example.Outer.Inner;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("Inner");
  });

  it("handles multiple imports", () => {
    const code = `
import java.util.List;
import java.util.Map;
import java.io.IOException;
`;
    const result = parseImportsAst(code, "java");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.importedNames[0])).toEqual(["List", "Map", "IOException"]);
  });

  it("handles deeply nested package path", () => {
    const result = parseImportsAst("import com.very.deep.package.hierarchy.ClassName;", "java");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("com.very.deep.package.hierarchy.ClassName");
    expect(result[0].importedNames).toEqual(["ClassName"]);
  });

  it("handles empty file gracefully", () => {
    const result = parseImportsAst("", "java");
    expect(result).toHaveLength(0);
  });

  it("handles file with only package declaration", () => {
    const result = parseImportsAst("package com.example;", "java");
    expect(result).toHaveLength(0);
  });

  it("preserves order of imports", () => {
    const code = `
import java.util.List;
import java.io.File;
import java.util.Map;
`;
    const result = parseImportsAst(code, "java");
    expect(result[0].importedNames).toEqual(["List"]);
    expect(result[1].importedNames).toEqual(["File"]);
    expect(result[2].importedNames).toEqual(["Map"]);
  });
});
