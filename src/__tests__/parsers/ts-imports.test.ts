import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter } from "../../core/parsers/init";
import { parseImportsAst } from "../../core/parsers/parse-imports";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseImportsAst - TypeScript edge cases", () => {
  it("parses mixed default + named imports", () => {
    const result = parseImportsAst(`import Foo, { bar, baz } from './module';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./module");
    expect(result[0].importedNames).toContain("Foo");
    expect(result[0].importedNames).toContain("bar");
    expect(result[0].importedNames).toContain("baz");
  });

  it("parses aliased named imports", () => {
    const result = parseImportsAst(`import { foo as bar } from './module';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("foo");
  });

  it("parses re-exports with aliases", () => {
    const result = parseImportsAst(`export { Foo as Bar } from './module';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./module");
  });

  it("parses star re-exports", () => {
    const result = parseImportsAst(`export * from './all';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./all");
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses type-only re-exports", () => {
    const result = parseImportsAst(`export type { Baz } from './types';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].isTypeOnly).toBe(true);
  });

  it("parses dynamic import expressions", () => {
    const result = parseImportsAst(`const mod = import('./dynamic');`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./dynamic");
    expect(result[0].isDynamic).toBe(true);
  });

  it("deduplicates require() calls to the same module", () => {
    const code = `
const a = require('./shared');
const b = require('./shared');
const c = require('./other');
    `;
    const result = parseImportsAst(code, "typescript");
    const shared = result.filter((r) => r.specifier === "./shared");
    expect(shared).toHaveLength(1);
    expect(result.filter((r) => r.specifier === "./other")).toHaveLength(1);
  });

  it("handles scoped package imports", () => {
    const result = parseImportsAst(`import { something } from '@scope/package-name';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("@scope/package-name");
  });

  it("handles deeply nested relative paths", () => {
    const result = parseImportsAst(`import { x } from '../../../utils/helpers';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("../../../utils/helpers");
  });

  it("handles multiple import statements from same module", () => {
    const code = `
import { a } from './module';
import { b } from './module';
    `;
    const result = parseImportsAst(code, "typescript");
    expect(result).toHaveLength(2);
  });

  it("parses multi-line import statements", () => {
    const code = `import {
  alpha,
  beta,
  gamma,
  delta
} from './greek';`;
    const result = parseImportsAst(code, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual(["alpha", "beta", "gamma", "delta"]);
  });

  it("handles single-quoted specifiers", () => {
    const result = parseImportsAst(`import { x } from './single';`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./single");
  });

  it("handles double-quoted specifiers", () => {
    const result = parseImportsAst(`import { x } from "./double";`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./double");
  });

  it("parses require without destructuring", () => {
    const result = parseImportsAst(`const mod = require('./cjs');`, "typescript");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toBe("./cjs");
  });

  it("handles empty file gracefully", () => {
    const result = parseImportsAst("", "typescript");
    expect(result).toHaveLength(0);
  });

  it("handles file with no imports", () => {
    const result = parseImportsAst("const x = 42;\nconsole.log(x);", "typescript");
    expect(result).toHaveLength(0);
  });
});
