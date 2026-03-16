import { describe, it, expect, beforeAll } from "vitest";
import { initTreeSitter } from "../../core/parsers/init.js";
import { parseImportsAst } from "../../core/parsers/parse-imports.js";

beforeAll(async () => {
  await initTreeSitter();
});

describe("parseImportsAst - Rust edge cases", () => {
  it("parses simple use declaration", () => {
    const result = parseImportsAst("use crate::graph::ImportGraph;", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("ImportGraph");
  });

  it("parses grouped use declarations", () => {
    const result = parseImportsAst("use crate::types::{Language, HubFile};", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("Language");
    expect(result[0].importedNames).toContain("HubFile");
  });

  it("parses wildcard imports", () => {
    const result = parseImportsAst("use crate::prelude::*;", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toEqual([]);
  });

  it("parses self in group", () => {
    const result = parseImportsAst("use std::io::{self, Read};", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("self");
    expect(result[0].importedNames).toContain("Read");
  });

  it("parses mod declarations", () => {
    const result = parseImportsAst("mod config;", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toContain("mod::config");
  });

  it("ignores inline mod blocks", () => {
    const code = `mod tests {
  use super::*;
  fn test_it() {}
}`;
    // The inline mod block should be ignored; the use inside it should be parsed
    const result = parseImportsAst(code, "rust");
    // The outer `mod tests { ... }` should NOT produce a mod:: import
    const modImports = result.filter((r) => r.specifier.startsWith("mod::tests"));
    expect(modImports).toHaveLength(0);
  });

  it("parses super:: paths", () => {
    const result = parseImportsAst("use super::utils;", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].specifier).toContain("super");
  });

  it("parses crate:: paths", () => {
    const result = parseImportsAst("use crate::config::Settings;", "rust");
    expect(result).toHaveLength(1);
    expect(result[0].importedNames).toContain("Settings");
  });

  it("handles empty file gracefully", () => {
    const result = parseImportsAst("", "rust");
    expect(result).toHaveLength(0);
  });

  it("handles file with no imports", () => {
    const result = parseImportsAst('fn main() { println!("hello"); }', "rust");
    expect(result).toHaveLength(0);
  });

  it("parses multiple use declarations", () => {
    const code = `
use std::collections::HashMap;
use std::fs;
use crate::types::Config;
`;
    const result = parseImportsAst(code, "rust");
    expect(result).toHaveLength(3);
  });

  it("captures use declarations inside non-test inline mod blocks", () => {
    const code = `
mod utils {
    use crate::types::Config;
}
mod tests {
    use super::*;
}
`;
    const result = parseImportsAst(code, "rust");
    // Should capture crate::types::Config from mod utils, but NOT super::* from mod tests
    expect(result.some((r) => r.specifier.includes("crate::types"))).toBe(true);
    expect(result.some((r) => r.specifier.includes("super"))).toBe(false);
  });
});
