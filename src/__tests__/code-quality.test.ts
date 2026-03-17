import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { detectContext } from "../core/detect/detect";
import { buildMainContext } from "../steer/context/main-context";
import type { DetectedContext, UserAnswers } from "../core/types";

// ── Helpers ──────────────────────────────────────────────────────────────

async function makeProject(files: Record<string, string>): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-cq-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return tmpDir;
}

function mockCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 10000,
    sourceFileCount: 20,
    monorepo: null,
    ...overrides,
  };
}

function mockAnswers(overrides?: Partial<UserAnswers>): UserAnswers {
  return {
    ides: ["claude"],
    projectPurpose: "A test project",
    keyPatterns: "",
    gotchas: "",
    generateSnapshot: false,
    snapshotPaths: [],
    stackConfirmed: true,
    stackCorrections: "",
    generatePerPackage: false,
    ...overrides,
  };
}

// ── Multi-line Generic Signature Extraction ──────────────────────────────

describe("multi-line generic signature extraction", () => {
  // We test via generateSnapshot since extractSignatureLine is private.
  // Mock the file system to feed controlled TS content.

  let mockReadFileOr: ReturnType<typeof vi.fn>;
  let mockGlob: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();

    vi.doMock("../core/utils.js", async () => {
      const actual = await vi.importActual<typeof import("../core/utils.js")>("../core/utils.js");
      mockReadFileOr = vi.fn();
      return { ...actual, readFileOr: mockReadFileOr };
    });

    vi.doMock("tinyglobby", () => {
      mockGlob = vi.fn();
      return { glob: mockGlob };
    });

    vi.doMock("../core/graph.js", async () => {
      const actual = await vi.importActual<typeof import("../core/graph.js")>("../core/graph.js");
      return { ...actual, findUsedExports: () => new Set<string>() };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeTsCtx(overrides?: Partial<DetectedContext>): DetectedContext {
    return {
      rootDir: "/test-project",
      language: "typescript",
      hasTypeScript: true,
      packageManager: "npm",
      linter: "none",
      frameworks: [],
      directories: ["src"],
      dependencies: [],
      isGitRepo: false,
      totalSourceBytes: 1000,
      sourceFileCount: 5,
      monorepo: null,
      ...overrides,
    };
  }

  it("extracts multi-line generic function signature", async () => {
    const { generateSnapshot } = await import("../core/snapshot/snapshot.js");
    const tsContent = `export function foo<
  T extends Bar,
  U extends Baz
>(arg: T): Result {
  return doStuff(arg);
}`;

    // biome-ignore lint/suspicious/noExplicitAny: vitest mock return value
    mockGlob.mockResolvedValue(["src/utils.ts"] as any);
    mockReadFileOr.mockResolvedValue(tsContent);

    const result = await generateSnapshot(makeTsCtx(), []);

    expect(result.entries.length).toBe(1);
    const sig = result.entries[0].signature;
    // Should include the full generic params and the closing paren with return type
    expect(sig).toContain("foo<");
    expect(sig).toContain("T extends Bar");
    expect(sig).toContain("U extends Baz");
    expect(sig).toContain(">(arg: T): Result");
    // Should NOT include the function body brace
    expect(sig).not.toContain("return doStuff");
  });

  it("handles generics with constraint braces like T extends { key: V }", async () => {
    const { generateSnapshot } = await import("../core/snapshot/snapshot.js");
    const tsContent = `export function transform<
  T extends { key: string },
  U extends { value: number }
>(input: T): U {
  return convert(input);
}`;

    // biome-ignore lint/suspicious/noExplicitAny: vitest mock return value
    mockGlob.mockResolvedValue(["src/transform.ts"] as any);
    mockReadFileOr.mockResolvedValue(tsContent);

    const result = await generateSnapshot(makeTsCtx(), []);

    expect(result.entries.length).toBe(1);
    const sig = result.entries[0].signature;
    expect(sig).toContain("T extends { key: string }");
    expect(sig).toContain(">(input: T): U");
    expect(sig).not.toContain("convert");
  });

  it("still works for single-line generics", async () => {
    const { generateSnapshot } = await import("../core/snapshot/snapshot.js");
    const tsContent = `export function identity<T>(arg: T): T {
  return arg;
}`;

    // biome-ignore lint/suspicious/noExplicitAny: vitest mock return value
    mockGlob.mockResolvedValue(["src/identity.ts"] as any);
    mockReadFileOr.mockResolvedValue(tsContent);

    const result = await generateSnapshot(makeTsCtx(), []);

    expect(result.entries.length).toBe(1);
    expect(result.entries[0].signature).toBe("export function identity<T>(arg: T): T");
  });
});

// ── Test Framework Priority ────────────────────────────────────────────

describe("test framework priority ordering", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("prefers vitest over jest when both are present", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "test",
        devDependencies: { jest: "^29.0.0", vitest: "^1.0.0" },
      }),
      "tsconfig.json": "{}",
      "src/index.ts": "",
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.testFramework).toBe("Vitest");
  });

  it("prefers jest over mocha when both are present", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "test",
        devDependencies: { mocha: "^10.0.0", jest: "^29.0.0" },
      }),
      "src/index.js": "",
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.testFramework).toBe("Jest");
  });

  it("prefers mocha over playwright", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "test",
        devDependencies: { playwright: "^1.0.0", mocha: "^10.0.0" },
      }),
      "src/index.js": "",
    });

    const ctx = await detectContext(tmpDir);
    expect(ctx.testFramework).toBe("Mocha");
  });
});

// ── Python Dev Commands ────────────────────────────────────────────────

describe("Python dev commands", () => {
  it("includes Django runserver command", async () => {
    const ctx = mockCtx({
      language: "python",
      packageManager: "pip",
      frameworks: [{ name: "Django" }],
    });

    const result = await buildMainContext(ctx, mockAnswers(), null);
    expect(result).toContain("python manage.py runserver");
  });

  it("includes FastAPI uvicorn command", async () => {
    const ctx = mockCtx({
      language: "python",
      packageManager: "pip",
      frameworks: [{ name: "FastAPI" }],
    });

    const result = await buildMainContext(ctx, mockAnswers(), null);
    expect(result).toContain("uvicorn app.main:app --reload");
  });

  it("includes Flask run command", async () => {
    const ctx = mockCtx({
      language: "python",
      packageManager: "pip",
      frameworks: [{ name: "Flask" }],
    });

    const result = await buildMainContext(ctx, mockAnswers(), null);
    expect(result).toContain("flask run");
  });

  it("includes poetry run prefix for Poetry projects", async () => {
    const ctx = mockCtx({
      language: "python",
      packageManager: "poetry",
      frameworks: [{ name: "Django" }],
    });

    const result = await buildMainContext(ctx, mockAnswers(), null);
    expect(result).toContain("poetry run python manage.py runserver");
    expect(result).toContain("poetry install");
  });

  it("includes pytest command when pytest is detected", async () => {
    const ctx = mockCtx({
      language: "python",
      packageManager: "pip",
      frameworks: [{ name: "Flask" }, { name: "pytest" }],
    });

    const result = await buildMainContext(ctx, mockAnswers(), null);
    expect(result).toContain("pytest");
  });
});

// ── Python Linter/Formatter Detection ───────────────────────────────────

describe("Python linter/formatter detection", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("detects Black from pyproject.toml [tool.black] section", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n\n[tool.black]\nline-length = 88\n`,
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("Black");
  });

  it("detects Black from requirements.txt", async () => {
    tmpDir = await makeProject({
      "requirements.txt": "black==23.1.0\nflask>=2.0\n",
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("Black");
  });

  it("detects isort from pyproject.toml [tool.isort] section", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n\n[tool.isort]\nprofile = "black"\n`,
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("isort");
  });

  it("detects mypy from mypy.ini file", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n`,
      "mypy.ini": "[mypy]\nstrict = true\n",
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("mypy");
  });

  it("detects mypy from setup.cfg [mypy] section", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n`,
      "setup.cfg": "[mypy]\nstrict = true\n",
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("mypy");
  });

  it("detects flake8 from .flake8 file", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n`,
      ".flake8": "[flake8]\nmax-line-length = 120\n",
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("flake8");
  });

  it("detects flake8 from setup.cfg [flake8] section", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": `[project]\nname = "test"\n`,
      "setup.cfg": "[flake8]\nmax-line-length = 120\n",
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("flake8");
  });

  it("detects multiple Python tools at once", async () => {
    tmpDir = await makeProject({
      "requirements.txt": "black==23.1.0\nisort==5.12.0\nmypy==1.5.0\n",
      "pyproject.toml": `[project]\nname = "test"\n`,
      "src/main.py": "print('hello')\n",
    });

    const ctx = await detectContext(tmpDir);
    const fwNames = ctx.frameworks.map((f) => f.name);
    expect(fwNames).toContain("Black");
    expect(fwNames).toContain("isort");
    expect(fwNames).toContain("mypy");
  });
});
