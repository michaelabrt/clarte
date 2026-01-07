import { describe, expect, it } from "vitest";
import { getExtensionsForLanguage, SECONDARY_LANGUAGE_THRESHOLD } from "../detect/languages.js";

describe("SECONDARY_LANGUAGE_THRESHOLD", () => {
  it("is 15%", () => {
    expect(SECONDARY_LANGUAGE_THRESHOLD).toBe(0.15);
  });
});

describe("getExtensionsForLanguage", () => {
  it("returns .ts and .tsx for typescript", () => {
    expect(getExtensionsForLanguage("typescript")).toEqual([".ts", ".tsx"]);
  });

  it("returns .js, .jsx, .mjs for javascript", () => {
    expect(getExtensionsForLanguage("javascript")).toEqual([".js", ".jsx", ".mjs"]);
  });

  it("returns .py for python", () => {
    expect(getExtensionsForLanguage("python")).toEqual([".py"]);
  });

  it("returns .go for go", () => {
    expect(getExtensionsForLanguage("go")).toEqual([".go"]);
  });

  it("returns .rs for rust", () => {
    expect(getExtensionsForLanguage("rust")).toEqual([".rs"]);
  });

  it("returns .java for java", () => {
    expect(getExtensionsForLanguage("java")).toEqual([".java"]);
  });

  it("returns fallback extensions for other/unknown languages", () => {
    const exts = getExtensionsForLanguage("other");
    expect(exts.length).toBeGreaterThan(1);
    expect(exts).toContain(".ts");
    expect(exts).toContain(".py");
    expect(exts).toContain(".go");
  });
});
