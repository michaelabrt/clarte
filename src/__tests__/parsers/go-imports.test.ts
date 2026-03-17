import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter } from "../../core/parsers/init";
import { parseImportsAst } from "../../core/parsers/parse-imports";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseImportsAst - Go edge cases", () => {
  it("parses single import", () => {
    const result = parseImportsAst(`import "fmt"`, "go");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("fmt");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses grouped imports", () => {
    const code = `import (
  "os"
  "path/filepath"
  "strings"
)`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.specifier)).toContain("os");
    expect(result.map((r) => r.specifier)).toContain("path/filepath");
    expect(result.map((r) => r.specifier)).toContain("strings");
  });

  it("parses aliased imports (discards alias)", () => {
    const code = `import myalias "github.com/foo/bar"`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("github.com/foo/bar");
  });

  it("parses dot imports", () => {
    const code = `import . "github.com/foo/bar"`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("github.com/foo/bar");
  });

  it("parses blank imports", () => {
    const code = `import _ "github.com/lib/pq"`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("github.com/lib/pq");
  });

  it("handles mixed single and grouped imports", () => {
    const code = `
import "fmt"

import (
  "os"
  "strings"
)`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(3);
  });

  it("handles deeply nested package paths", () => {
    const result = parseImportsAst(`import "github.com/org/project/internal/pkg/utils"`, "go");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("github.com/org/project/internal/pkg/utils");
  });

  it("handles empty file gracefully", () => {
    const result = parseImportsAst("package main", "go");
    expect(result).toHaveLength(0);
  });

  it("handles aliased imports in groups", () => {
    const code = `import (
  myhttp "net/http"
  "fmt"
)`;
    const result = parseImportsAst(code, "go");
    expect(result).toHaveLength(2);
    expect(result.map((r) => r.specifier)).toContain("net/http");
    expect(result.map((r) => r.specifier)).toContain("fmt");
  });
});
