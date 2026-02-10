import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolveTestCommand, generateRunTestScript } from "../hooks/generate-scripts.js";
import type { DetectedContext } from "../types/detection.js";

function makeCtx(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
    ...overrides,
  };
}

describe("resolveTestCommand", () => {
  it("returns npm run test for npm projects", () => {
    expect(resolveTestCommand(makeCtx())).toBe("npm run test");
  });

  it("returns pnpm test for pnpm projects", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "pnpm" }))).toBe("pnpm test");
  });

  it("returns yarn test for yarn projects", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "yarn" }))).toBe("yarn test");
  });

  it("returns bun run test for bun projects", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "bun" }))).toBe("bun run test");
  });

  it("returns pytest for pip+pytest", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "pip", testFramework: "pytest" }))).toBe("pytest");
  });

  it("returns poetry run pytest for poetry+pytest", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "poetry", testFramework: "pytest" }))).toBe(
      "poetry run pytest",
    );
  });

  it("returns cargo test for cargo", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "cargo" }))).toBe("cargo test");
  });

  it("returns go test for go", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "go" }))).toBe("go test ./...");
  });

  it("returns null for pip without pytest", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "pip" }))).toBeNull();
  });

  it("returns null for unknown package manager", () => {
    expect(resolveTestCommand(makeCtx({ packageManager: "none" }))).toBeNull();
  });
});

describe("generateRunTestScript", () => {
  let tmpDir: string;

  async function setupTmpDir(pkg: Record<string, unknown>, files?: Record<string, string>): Promise<string> {
    tmpDir = await mkdtemp(path.join(tmpdir(), "clarte-test-"));
    await writeFile(path.join(tmpDir, "package.json"), JSON.stringify(pkg));
    for (const [name, content] of Object.entries(files ?? {})) {
      await writeFile(path.join(tmpDir, name), content);
    }
    return tmpDir;
  }

  async function readScript(): Promise<string> {
    return readFile(path.join(tmpDir, ".clarte/scripts/run-test.sh"), "utf-8");
  }

  afterEach(async () => {
    if (tmpDir) await rm(tmpDir, { recursive: true, force: true });
  });

  it("generates --grep for mocha projects", async () => {
    await setupTmpDir({ scripts: { test: "mocha" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, packageManager: "npm", testFramework: "Mocha" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("--grep");
    expect(script).not.toContain("Compiling");
  });

  it("generates -t for vitest projects", async () => {
    await setupTmpDir({ scripts: { test: "vitest run" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, testFramework: "Vitest" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("-t '$1'");
  });

  it("generates -t for jest projects", async () => {
    await setupTmpDir({ scripts: { test: "jest" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, testFramework: "Jest" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("-t '$1'");
  });

  it("generates -k for pytest projects", async () => {
    await setupTmpDir({});
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, packageManager: "pip", testFramework: "pytest" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("-k '$1'");
  });

  it("returns null for unknown frameworks", async () => {
    await setupTmpDir({ scripts: { test: "tap" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, testFramework: "Tap" }));
    expect(result).toBeNull();
  });

  it("returns null when no test framework detected", async () => {
    await setupTmpDir({ scripts: { test: "echo test" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir }));
    expect(result).toBeNull();
  });

  it("includes compile step when mocharc spec points to build dir", async () => {
    await setupTmpDir(
      { scripts: { test: "pnpm run compile && mocha", compile: "gulp clean && tsc" } },
      { ".mocharc.json": JSON.stringify({ spec: ["./build/compiled/test/**/*.test.js"] }) },
    );
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, packageManager: "pnpm", testFramework: "Mocha" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("pnpm run compile");
    expect(script).toContain("Compiling");
    expect(script).toContain("--grep");
  });

  it("includes compile step when test script has slow compile", async () => {
    await setupTmpDir({ scripts: { test: "tsc && jest", build: "tsc" } });
    const result = await generateRunTestScript(tmpDir, makeCtx({ rootDir: tmpDir, testFramework: "Jest" }));
    expect(result).toBe(".clarte/scripts/run-test.sh");
    const script = await readScript();
    expect(script).toContain("npm run build");
    expect(script).toContain("Compiling");
  });
});
