import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter } from "../../core/parsers/init.js";
import { parseImportsAst } from "../../core/parsers/parse-imports.js";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseImportsAst - Python edge cases", () => {
  it("parses plain import with alias", () => {
    const result = parseImportsAst("import numpy as np", "python");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("numpy");
  });

  it("parses from-import with alias", () => {
    const result = parseImportsAst("from os.path import join as pjoin", "python");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("os.path");
    expect(result[0].importedNames).toContain("join");
  });

  it("parses multiple plain imports on one line", () => {
    const result = parseImportsAst("import os, sys, json", "python");
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.specifier)).toEqual(["os", "sys", "json"]);
  });

  it("parses from-import with multiple names", () => {
    const result = parseImportsAst("from pathlib import Path, PurePath", "python");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("Path");
    expect(result[0].importedNames).toContain("PurePath");
  });

  it("parses single-dot relative import", () => {
    const result = parseImportsAst("from . import utils", "python");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe(".");
  });

  it("parses double-dot relative import", () => {
    const result = parseImportsAst("from ..core import Base", "python");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("..core");
  });

  it("marks TYPE_CHECKING imports as type-only", () => {
    const code = `
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .models import User
`;
    const result = parseImportsAst(code, "python");
    const typeImport = result.find((r) => r.specifier === ".models");
    if (!typeImport) throw new Error("expected .models import");
    expect(typeImport.isTypeOnly).toBe(true);
  });

  it("marks typing.TYPE_CHECKING imports as type-only", () => {
    const code = `
import typing

if typing.TYPE_CHECKING:
    from .models import User
`;
    const result = parseImportsAst(code, "python");
    const typeImport = result.find((r) => r.specifier === ".models");
    if (!typeImport) throw new Error("expected .models import");
    expect(typeImport.isTypeOnly).toBe(true);
  });

  it("handles wildcard import", () => {
    const result = parseImportsAst("from module import *", "python");
    expect(result.length).toBeGreaterThanOrEqual(1);
    const entry = result.find((r) => r.specifier === "module");
    expect(entry).toBeDefined();
  });

  it("does not capture __future__ imports (tree-sitter uses future_import_statement)", () => {
    // tree-sitter parses `from __future__ import ...` as future_import_statement
    // not import_from_statement, so the parser doesn't capture it
    const result = parseImportsAst("from __future__ import annotations", "python");
    expect(result).toHaveLength(0);
  });

  it("handles empty file gracefully", () => {
    const result = parseImportsAst("", "python");
    expect(result).toHaveLength(0);
  });

  it("handles file with no imports", () => {
    const result = parseImportsAst("x = 42\nprint(x)", "python");
    expect(result).toHaveLength(0);
  });

  it("handles parenthesized from-imports", () => {
    const code = `from os.path import (
    join,
    dirname,
    basename
)`;
    const result = parseImportsAst(code, "python");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("join");
    expect(result[0].importedNames).toContain("dirname");
    expect(result[0].importedNames).toContain("basename");
  });
});
