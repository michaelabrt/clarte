import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { extractFilePaths, validateContextPaths } from "../check.js";
import type { ProjectConfig } from "../types.js";

describe("extractFilePaths", () => {
  it("extracts backtick-quoted file paths with slashes and valid extensions", () => {
    const content = "Check `src/foo.ts` and `lib/bar.js` for details.";
    expect(extractFilePaths(content)).toEqual(["src/foo.ts", "lib/bar.js"]);
  });

  it("ignores paths without slashes (bare names)", () => {
    const content = "Run `npm` or use `string` here.";
    expect(extractFilePaths(content)).toEqual([]);
  });

  it("ignores paths without valid extensions", () => {
    const content = "See `src/readme.txt` and `lib/data.csv` for info.";
    expect(extractFilePaths(content)).toEqual([]);
  });

  it("extracts various supported extensions", () => {
    const content = [
      "`src/types.ts`",
      "`src/app.tsx`",
      "`src/main.js`",
      "`src/app.jsx`",
      "`app/main.py`",
      "`cmd/server.go`",
      "`src/lib.rs`",
      "`src/Main.java`",
      "`config/settings.json`",
      "`docs/README.md`",
      "`config/app.yaml`",
      "`config/app.yml`",
      "`config/Cargo.toml`",
    ].join(" ");

    const paths = extractFilePaths(content);
    expect(paths).toEqual([
      "src/types.ts",
      "src/app.tsx",
      "src/main.js",
      "src/app.jsx",
      "app/main.py",
      "cmd/server.go",
      "src/lib.rs",
      "src/Main.java",
      "config/settings.json",
      "docs/README.md",
      "config/app.yaml",
      "config/app.yml",
      "config/Cargo.toml",
    ]);
  });

  it("deduplicates repeated paths", () => {
    const content = "Both `src/foo.ts` and again `src/foo.ts` are important.";
    expect(extractFilePaths(content)).toEqual(["src/foo.ts"]);
  });

  it("ignores backtick content with spaces", () => {
    const content = "Use `run some command` and `src/foo.ts` here.";
    expect(extractFilePaths(content)).toEqual(["src/foo.ts"]);
  });

  it("handles markdown table rows with paths", () => {
    const content = "| `src/types.ts` | 20 files | stable |";
    expect(extractFilePaths(content)).toEqual(["src/types.ts"]);
  });

  it("returns empty array for content with no backtick paths", () => {
    const content = "This is just regular text without any file references.";
    expect(extractFilePaths(content)).toEqual([]);
  });
});

describe("validateContextPaths", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-check-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  const baseConfig: ProjectConfig = {
    ides: ["claude"],
    projectPurpose: "test",
    keyPatterns: "",
    gotchas: "",
    generateSnapshot: false,
    snapshotPaths: [],
    stackCorrections: "",
    generatePerPackage: false,
  };

  it("returns null when context file does not exist", async () => {
    const result = await validateContextPaths(tmpDir, baseConfig);
    expect(result).toBeNull();
  });

  it("returns no broken paths when all referenced files exist", async () => {
    // Create the context file and the referenced files
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/types.ts"), "export type X = {};");
    await fs.writeFile(path.join(tmpDir, "src/utils.ts"), "export function x() {}");

    const contextContent = "Key files: `src/types.ts` and `src/utils.ts`.";
    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), contextContent);

    const result = await validateContextPaths(tmpDir, baseConfig);
    expect(result).not.toBeNull();
    expect(result!.broken).toEqual([]);
    expect(result!.file).toBe(".claude/rules/clarte.md");
  });

  it("reports missing files as broken references", async () => {
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src/types.ts"), "export type X = {};");

    const contextContent = "Key files: `src/types.ts` and `src/old-file.ts` and `src/removed.ts`.";
    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), contextContent);

    const result = await validateContextPaths(tmpDir, baseConfig);
    expect(result).not.toBeNull();
    expect(result!.broken).toEqual(["src/old-file.ts", "src/removed.ts"]);
    expect(result!.file).toBe(".claude/rules/clarte.md");
  });

  it("uses the correct context filename based on IDE target", async () => {
    const config: ProjectConfig = { ...baseConfig, ides: ["generic"] };
    const contextContent = "See `src/missing.ts` for details.";
    await fs.writeFile(path.join(tmpDir, "CONTEXT.md"), contextContent);

    const result = await validateContextPaths(tmpDir, config);
    expect(result).not.toBeNull();
    expect(result!.file).toBe("CONTEXT.md");
    expect(result!.broken).toEqual(["src/missing.ts"]);
  });

  it("falls back to claude when ides array is empty", async () => {
    const config: ProjectConfig = { ...baseConfig, ides: [] };
    const contextContent = "See `src/missing.ts` for details.";
    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), contextContent);

    const result = await validateContextPaths(tmpDir, config);
    expect(result).not.toBeNull();
    expect(result!.file).toBe(".claude/rules/clarte.md");
  });
});
