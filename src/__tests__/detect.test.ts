import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { detectContext, enrichFrameworksWithUsage, summarizeDetection } from "../detect.js";
import type { DetectedContext, DetectedFramework } from "../types.js";

/** Create a temporary project directory with the given file tree. */
async function makeProject(
  files: Record<string, string>,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "codebrief-test-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return tmpDir;
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ── detectContext ────────────────────────────────────────────────────────────

describe("detectContext", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("detects a TypeScript + npm project", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "test",
        dependencies: { react: "^18.0.0" },
        devDependencies: { vitest: "^1.0.0" },
      }),
      "tsconfig.json": "{}",
      "src/index.ts": "export const x = 1;",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("typescript");
    expect(ctx.hasTypeScript).toBe(true);
    expect(ctx.packageManager).toBe("npm");
    expect(ctx.frameworks.map((f) => f.name)).toContain("React");
    expect(ctx.testFramework).toBe("Vitest");
    expect(ctx.sourceFileCount).toBeGreaterThanOrEqual(1);
  });

  it("detects JavaScript when no tsconfig present", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({ name: "test", dependencies: {} }),
      "src/app.js": "console.log('hi');",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("javascript");
    expect(ctx.hasTypeScript).toBe(false);
  });

  it("detects pnpm from lockfile", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({ name: "test" }),
      "pnpm-lock.yaml": "lockfileVersion: 9\n",
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.packageManager).toBe("pnpm");
  });

  it("detects a Go project", async () => {
    tmpDir = await makeProject({
      "go.mod": "module example.com/test\n\ngo 1.21\n",
      "main.go": "package main\nfunc main() {}\n",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("go");
    expect(ctx.packageManager).toBe("go");
    expect(ctx.linter).toBe("gofmt");
  });

  it("detects a Python project with frameworks from requirements.txt", async () => {
    tmpDir = await makeProject({
      "requirements.txt": "flask==2.3.0\nsqlalchemy>=1.4\npytest\n",
      "app.py": "from flask import Flask\n",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("python");
    expect(ctx.packageManager).toBe("pip");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Flask");
    expect(ctx.frameworks.map((f) => f.name)).toContain("SQLAlchemy");
  });

  it("returns 'other' language for empty project", async () => {
    tmpDir = await makeProject({
      "README.md": "# Hello\n",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("other");
    expect(ctx.packageManager).toBe("none");
    expect(ctx.frameworks).toEqual([]);
  });

  it("detects biome linter", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({ name: "test" }),
      "biome.json": "{}",
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.linter).toBe("biome");
  });

  it("deduplicates frameworks with multiple dep names", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "test",
        dependencies: { "@angular/core": "^17.0.0", angular: "^1.8.0" },
      }),
    });

    const ctx = await detectContext(tmpDir);
    const angularCount = ctx.frameworks.filter((f) => f.name === "Angular").length;
    expect(angularCount).toBe(1);
  });

  it("discovers nested src/ directories", async () => {
    tmpDir = await makeProject({
      "src/components/Button.tsx": "",
      "src/utils/helpers.ts": "",
      "src/hooks/useAuth.ts": "",
      "package.json": JSON.stringify({ name: "test" }),
      "tsconfig.json": "{}",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.directories).toContain("src");
    expect(ctx.directories).toContain("src/components");
    expect(ctx.directories).toContain("src/hooks");
  });

  it("detects GitHub Actions CI", async () => {
    tmpDir = await makeProject({
      ".github/workflows/ci.yml": "name: CI\n",
      "package.json": JSON.stringify({ name: "test" }),
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("GitHub Actions");
  });
});

// ── enrichFrameworksWithUsage ───────────────────────────────────────────────

describe("enrichFrameworksWithUsage", () => {
  it("filters out frameworks with zero imports", () => {
    const frameworks: DetectedFramework[] = [
      { name: "React", version: "18.0.0" },
      { name: "Express", version: "4.0.0" },
    ];
    const counts = new Map([["react", 10]]);

    const result = enrichFrameworksWithUsage(frameworks, counts);

    expect(result.find((f) => f.name === "React")?.importCount).toBe(10);
    expect(result.map((f) => f.name)).not.toContain("Express");
  });

  it("sums counts across multiple dep names for same framework", () => {
    const frameworks: DetectedFramework[] = [{ name: "Angular" }];
    const counts = new Map([
      ["angular", 2],
      ["@angular/core", 8],
    ]);

    const result = enrichFrameworksWithUsage(frameworks, counts);
    expect(result[0].importCount).toBe(10);
  });
});

// ── summarizeDetection ──────────────────────────────────────────────────────

describe("summarizeDetection", () => {
  const base: DetectedContext = {
    rootDir: "/tmp",
    language: "other",
    hasTypeScript: false,
    packageManager: "none",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
  };

  it("summarizes a full stack", () => {
    const ctx: DetectedContext = {
      ...base,
      language: "typescript",
      hasTypeScript: true,
      packageManager: "npm",
      linter: "eslint",
      frameworks: [{ name: "React", version: "18.0.0" }],
    };

    const summary = summarizeDetection(ctx);
    expect(summary).toBe("React + TypeScript + Eslint + npm");
  });

  it("returns empty string for unknown project", () => {
    expect(summarizeDetection(base)).toBe("");
  });
});
