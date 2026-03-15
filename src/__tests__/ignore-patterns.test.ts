import { describe, expect, it } from "vitest";
import { IGNORE_DIRS, IGNORE_GLOBS, IGNORE_DIRS_SET } from "../core/config/ignore-patterns.js";

describe("IGNORE_DIRS", () => {
  it("is a non-empty array of strings", () => {
    expect(IGNORE_DIRS.length).toBeGreaterThan(0);
    for (const dir of IGNORE_DIRS) {
      expect(typeof dir).toBe("string");
    }
  });

  it("includes common ignored directories", () => {
    expect(IGNORE_DIRS).toContain("node_modules");
    expect(IGNORE_DIRS).toContain("dist");
    expect(IGNORE_DIRS).toContain(".git");
    expect(IGNORE_DIRS).toContain("__pycache__");
    expect(IGNORE_DIRS).toContain("vendor");
    expect(IGNORE_DIRS).toContain("target");
  });

  it("includes clarte's own directory", () => {
    expect(IGNORE_DIRS).toContain(".clarte");
  });
});

describe("IGNORE_GLOBS", () => {
  it("derives glob patterns from IGNORE_DIRS", () => {
    for (const dir of IGNORE_DIRS) {
      expect(IGNORE_GLOBS).toContain(`**/${dir}/**`);
    }
  });

  it("includes OS junk directories", () => {
    expect(IGNORE_GLOBS).toContain("**/.Trash/**");
    expect(IGNORE_GLOBS).toContain("**/Library/**");
  });

  it("has more entries than IGNORE_DIRS (due to OS junk dirs)", () => {
    expect(IGNORE_GLOBS.length).toBeGreaterThan(IGNORE_DIRS.length);
  });
});

describe("IGNORE_DIRS_SET", () => {
  it("is a Set containing the same elements as IGNORE_DIRS", () => {
    expect(IGNORE_DIRS_SET.size).toBe(IGNORE_DIRS.length);
    for (const dir of IGNORE_DIRS) {
      expect(IGNORE_DIRS_SET.has(dir)).toBe(true);
    }
  });

  it("supports fast lookups", () => {
    expect(IGNORE_DIRS_SET.has("node_modules")).toBe(true);
    expect(IGNORE_DIRS_SET.has("src")).toBe(false);
  });
});
