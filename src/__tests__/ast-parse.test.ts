import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter, parseImportsAst, extractSnapshotAst, detectBarrelAst, resolveBarrelExportsAst } from "../ast-parse.js";

beforeAll(async () => {
  await initTreeSitter();
});

// ── JS/TS Import Parsing ─────────────────────────────────────────────────────

describe("parseImportsAst - JS/TS", () => {
  it("parses named imports", () => {
    const result = parseImportsAst(
      `import { foo, bar } from './module';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./module");
    expect(result[0].importedNames).toEqual(["foo", "bar"]);
  });

  it("parses type-only imports", () => {
    const result = parseImportsAst(
      `import type { Baz } from './types';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].isTypeOnly).toBe(true);
    expect(result[0].importedNames).toEqual(["Baz"]);
  });

  it("parses default imports", () => {
    const result = parseImportsAst(
      `import Foo from './foo';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual(["Foo"]);
  });

  it("parses namespace imports", () => {
    const result = parseImportsAst(
      `import * as utils from '../utils';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("../utils");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses side-effect imports", () => {
    const result = parseImportsAst(
      `import './side-effect';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./side-effect");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses require() calls", () => {
    const result = parseImportsAst(
      `const x = require('./cjs');`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./cjs");
  });

  it("parses dynamic import()", () => {
    const result = parseImportsAst(
      `const mod = import('./dynamic');`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./dynamic");
    expect(result[0].isDynamic).toBe(true);
  });

  it("parses re-exports", () => {
    const result = parseImportsAst(
      `export { Foo, Bar } from './reexport';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./reexport");
    expect(result[0].importedNames).toEqual(["Foo", "Bar"]);
  });

  it("parses star re-exports", () => {
    const result = parseImportsAst(
      `export * from './star';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./star");
  });

  it("ignores imports inside comments", () => {
    const result = parseImportsAst(
      `// import { foo } from './commented-out';\nconst x = 1;`,
      "typescript",
    );
    expect(result).toHaveLength(0);
  });

  it("handles multi-line imports", () => {
    const result = parseImportsAst(
      `import {\n  foo,\n  bar,\n  // baz\n  qux\n} from './module';`,
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual(["foo", "bar", "qux"]);
  });
});

// ── Python Import Parsing ────────────────────────────────────────────────────

describe("parseImportsAst - Python", () => {
  it("parses from-import statements", () => {
    const result = parseImportsAst(
      `from os.path import join, dirname`,
      "python",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("os.path");
    expect(result[0].importedNames).toEqual(["join", "dirname"]);
  });

  it("parses relative imports", () => {
    const result = parseImportsAst(
      `from . import utils`,
      "python",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe(".");
  });

  it("parses double-dot relative imports", () => {
    const result = parseImportsAst(
      `from ..core import Base`,
      "python",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("..core");
  });

  it("parses plain import statements", () => {
    const result = parseImportsAst(
      `import json\nimport os, sys`,
      "python",
    );
    expect(result).toHaveLength(3);
    expect(result[0].specifier).toBe("json");
    expect(result[1].specifier).toBe("os");
    expect(result[2].specifier).toBe("sys");
  });

  it("detects TYPE_CHECKING imports as type-only", () => {
    const result = parseImportsAst(
      `from typing import TYPE_CHECKING\nif TYPE_CHECKING:\n    from .models import User\n`,
      "python",
    );
    const typeOnlyImport = result.find(i => i.specifier === ".models");
    expect(typeOnlyImport).toBeDefined();
    expect(typeOnlyImport!.isTypeOnly).toBe(true);
  });
});

// ── Go Import Parsing ────────────────────────────────────────────────────────

describe("parseImportsAst - Go", () => {
  it("parses single imports", () => {
    const result = parseImportsAst(
      `package main\nimport "fmt"`,
      "go",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("fmt");
  });

  it("parses grouped imports", () => {
    const result = parseImportsAst(
      `package main\nimport (\n  "os"\n  "path/filepath"\n)`,
      "go",
    );
    expect(result).toHaveLength(2);
    expect(result[0].specifier).toBe("os");
    expect(result[1].specifier).toBe("path/filepath");
  });

  it("handles aliased imports", () => {
    const result = parseImportsAst(
      `package main\nimport (\n  myalias "github.com/foo/bar"\n)`,
      "go",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("github.com/foo/bar");
  });
});

// ── Rust Import Parsing ──────────────────────────────────────────────────────

describe("parseImportsAst - Rust", () => {
  it("parses simple use declarations", () => {
    const result = parseImportsAst(
      `use crate::graph::ImportGraph;`,
      "rust",
    );
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual(["ImportGraph"]);
  });

  it("parses grouped use declarations", () => {
    const result = parseImportsAst(
      `use crate::types::{Language, HubFile};`,
      "rust",
    );
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("Language");
    expect(result[0].importedNames).toContain("HubFile");
  });

  it("parses mod declarations", () => {
    const result = parseImportsAst(
      `mod config;`,
      "rust",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("config");
  });
});

// ── Java Import Parsing ──────────────────────────────────────────────────────

describe("parseImportsAst - Java", () => {
  it("parses standard imports", () => {
    const result = parseImportsAst(
      `import com.example.Foo;`,
      "java",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("com.example.Foo");
    expect(result[0].importedNames).toEqual(["Foo"]);
  });

  it("parses wildcard imports", () => {
    const result = parseImportsAst(
      `import com.example.util.*;`,
      "java",
    );
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("com.example.util.*");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses static imports", () => {
    const result = parseImportsAst(
      `import static com.example.Bar.method;`,
      "java",
    );
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual(["method"]);
  });
});

// ── JS/TS Snapshot Extraction ────────────────────────────────────────────────

describe("extractSnapshotAst - JS/TS", () => {
  it("extracts exported interfaces", () => {
    const result = extractSnapshotAst(
      `export interface User {\n  name: string;\n  age: number;\n}`,
      "src/types.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("interface");
    expect(result[0].signature).toContain("interface User");
  });

  it("extracts exported type aliases", () => {
    const result = extractSnapshotAst(
      `export type Status = 'active' | 'inactive';`,
      "src/types.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("type");
    expect(result[0].signature).toContain("type Status");
  });

  it("extracts exported function signatures", () => {
    const result = extractSnapshotAst(
      `export function greet(name: string): string {\n  return "Hello " + name;\n}`,
      "src/utils.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("function");
    expect(result[0].signature).toContain("greet(name: string): string");
    expect(result[0].signature).not.toContain("return");
  });

  it("extracts exported arrow functions", () => {
    const result = extractSnapshotAst(
      `export const add = (a: number, b: number): number => a + b;`,
      "src/utils.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("function");
  });

  it("detects hooks from path", () => {
    const result = extractSnapshotAst(
      `export function useAuth(): boolean {\n  return true;\n}`,
      "src/hooks/useAuth.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("hook");
  });

  it("extracts enums", () => {
    const result = extractSnapshotAst(
      `export enum Color { Red, Green, Blue }`,
      "src/types.ts",
      "typescript",
    );
    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("type");
    expect(result[0].signature).toContain("enum Color");
  });

  it("skips non-function const exports", () => {
    const result = extractSnapshotAst(
      `export const API_URL = "https://example.com";`,
      "src/config.ts",
      "typescript",
    );
    expect(result).toHaveLength(0);
  });
});

// ── Barrel file detection ────────────────────────────────────────────────────

describe("detectBarrelAst", () => {
  it("detects barrel files", () => {
    const result = detectBarrelAst(
      `export { Foo } from './foo';\nexport { Bar } from './bar';\nexport * from './baz';`,
    );
    expect(result.isBarrel).toBe(true);
    expect(result.reExportCount).toBe(3);
  });

  it("rejects non-barrel files", () => {
    const result = detectBarrelAst(
      `export function foo() {}\nexport const bar = 1;\nexport class Baz {}`,
    );
    expect(result.isBarrel).toBe(false);
    expect(result.reExportCount).toBe(0);
  });
});

describe("resolveBarrelExportsAst", () => {
  it("resolves named re-exports", () => {
    const result = resolveBarrelExportsAst(
      `export { Foo, Bar } from './foo';\nexport * from './bar';`,
    );
    expect(result.namedExports.get("Foo")).toBe("./foo");
    expect(result.namedExports.get("Bar")).toBe("./foo");
    expect(result.starExports.has("./bar")).toBe(true);
  });
});
