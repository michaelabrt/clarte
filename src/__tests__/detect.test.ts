import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach } from "vitest";
import { detectContext, enrichFrameworksWithUsage, summarizeDetection, SECONDARY_LANGUAGE_THRESHOLD } from "../detect.js";
import type { DetectedContext, DetectedFramework } from "../types.js";

/** Create a temporary project directory with the given file tree. */
async function makeProject(
  files: Record<string, string>,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-test-"));
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

  it("detects a Python project with frameworks from pyproject.toml", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": [
        "[project]",
        'name = "myapp"',
        'version = "1.0.0"',
        "dependencies = [",
        '  "django>=4.2",',
        '  "celery>=5.0",',
        '  "pydantic>=2.0",',
        "]",
        "",
      ].join("\n"),
      "app.py": "import django\n",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("python");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Django");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Celery");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Pydantic");
  });

  it("detects Python frameworks from poetry pyproject.toml", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": [
        "[tool.poetry.dependencies]",
        'python = "^3.11"',
        'fastapi = "^0.100"',
        'sqlalchemy = "^2.0"',
        "",
      ].join("\n"),
      "poetry.lock": "# lock",
      "main.py": "import fastapi\n",
    });

    const ctx = await detectContext(tmpDir);

    expect(ctx.language).toBe("python");
    expect(ctx.packageManager).toBe("poetry");
    expect(ctx.frameworks.map((f) => f.name)).toContain("FastAPI");
    expect(ctx.frameworks.map((f) => f.name)).toContain("SQLAlchemy");
    // python itself should not appear as a dependency
    expect(ctx.dependencies).not.toContain("python");
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

  // ── CI provider expansion ───────────────────────────────────────────────

  it("detects Vercel CI", async () => {
    tmpDir = await makeProject({
      "vercel.json": '{ "buildCommand": "npm run build" }',
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Vercel");
  });

  it("detects Netlify CI", async () => {
    tmpDir = await makeProject({
      "netlify.toml": "[build]\ncommand = \"npm run build\"\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Netlify");
  });

  it("detects Render CI", async () => {
    tmpDir = await makeProject({
      "render.yaml": "services:\n  - type: web\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Render");
  });

  it("detects Railway CI from railway.json", async () => {
    tmpDir = await makeProject({
      "railway.json": '{ "build": {} }',
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Railway");
  });

  it("detects Railway CI from railway.toml", async () => {
    tmpDir = await makeProject({
      "railway.toml": "[build]\ncommand = \"npm run build\"\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Railway");
  });

  it("detects Fly.io CI", async () => {
    tmpDir = await makeProject({
      "fly.toml": "app = \"my-app\"\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Fly.io");
  });

  it("detects Bitbucket Pipelines CI", async () => {
    tmpDir = await makeProject({
      "bitbucket-pipelines.yml": "pipelines:\n  default:\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Bitbucket Pipelines");
  });

  it("detects Azure DevOps CI", async () => {
    tmpDir = await makeProject({
      "azure-pipelines.yml": "trigger:\n  - main\n",
      "package.json": JSON.stringify({ name: "test" }),
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.ciProvider).toBe("Azure DevOps");
  });

  // ── Java build tool detection ───────────────────────────────────────────

  it("detects Maven from pom.xml", async () => {
    tmpDir = await makeProject({
      "pom.xml": [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project>',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <groupId>com.example</groupId>',
        '  <artifactId>myapp</artifactId>',
        '  <version>1.2.3</version>',
        '</project>',
      ].join("\n"),
      "src/main/java/App.java": "public class App {}",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.language).toBe("java");
    const maven = ctx.frameworks.find((f) => f.name === "Maven");
    expect(maven).toBeDefined();
    expect(maven?.version).toBe("1.2.3");
  });

  it("detects Gradle from build.gradle", async () => {
    tmpDir = await makeProject({
      "build.gradle": "plugins { id 'java' }\n",
      "src/main/java/App.java": "public class App {}",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.language).toBe("java");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Gradle");
  });

  it("detects Gradle from build.gradle.kts", async () => {
    tmpDir = await makeProject({
      "build.gradle.kts": "plugins { java }\n",
      "src/main/java/App.java": "public class App {}",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.language).toBe("java");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Gradle");
  });

  // ── Bun configuration detection ────────────────────────────────────────

  it("detects bunfig.toml as Bun framework entry", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({ name: "test", dependencies: {} }),
      "bun.lockb": "",
      "bunfig.toml": '[install]\nauto = "force"\n',
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.packageManager).toBe("bun");
    expect(ctx.frameworks.map((f) => f.name)).toContain("Bun");
  });

  it("does not add Bun framework without bunfig.toml", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({ name: "test", dependencies: {} }),
      "bun.lockb": "",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.packageManager).toBe("bun");
    expect(ctx.frameworks.map((f) => f.name)).not.toContain("Bun");
  });

  // ── Python tool detection ──────────────────────────────────────────────

  it("detects mypy from [tool.mypy] in pyproject.toml", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": [
        "[project]",
        'name = "myapp"',
        "dependencies = []",
        "",
        "[tool.mypy]",
        "strict = true",
      ].join("\n"),
      "main.py": "x = 1\n",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.frameworks.map((f) => f.name)).toContain("mypy");
  });

  it("detects Black from [tool.black] in pyproject.toml", async () => {
    tmpDir = await makeProject({
      "pyproject.toml": [
        "[project]",
        'name = "myapp"',
        "dependencies = []",
        "",
        "[tool.black]",
        "line-length = 88",
      ].join("\n"),
      "main.py": "x = 1\n",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.frameworks.map((f) => f.name)).toContain("Black");
  });

  it("detects flake8 from .flake8 file", async () => {
    tmpDir = await makeProject({
      "requirements.txt": "flask\n",
      ".flake8": "[flake8]\nmax-line-length = 120\n",
      "main.py": "x = 1\n",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.frameworks.map((f) => f.name)).toContain("flake8");
  });

  // ── npm workspaces detection ──────────────────────────────────────────

  it("detects npm native workspaces monorepo", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "my-monorepo",
        workspaces: ["packages/*"],
        dependencies: {},
      }),
      "packages/core/package.json": JSON.stringify({ name: "@mono/core", dependencies: {} }),
      "packages/core/src/index.ts": "export const x = 1;\n",
      "packages/ui/package.json": JSON.stringify({ name: "@mono/ui", dependencies: {} }),
      "packages/ui/src/index.ts": "export const y = 2;\n",
      "tsconfig.json": "{}",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.monorepo).not.toBeNull();
    expect(ctx.monorepo!.type).toBe("npm-workspaces");
    expect(ctx.monorepo!.packages.length).toBe(2);
  });

  it("detects npm workspaces with packages object format", async () => {
    tmpDir = await makeProject({
      "package.json": JSON.stringify({
        name: "my-monorepo",
        workspaces: { packages: ["libs/*"] },
        dependencies: {},
      }),
      "libs/shared/package.json": JSON.stringify({ name: "@mono/shared", dependencies: {} }),
      "libs/shared/src/index.ts": "export const z = 3;\n",
      "tsconfig.json": "{}",
    });
    const ctx = await detectContext(tmpDir);
    expect(ctx.monorepo).not.toBeNull();
    expect(ctx.monorepo!.type).toBe("npm-workspaces");
    expect(ctx.monorepo!.packages.length).toBe(1);
  });

  // ── Maven parent version extraction ───────────────────────────────────

  it("extracts Maven version from parent when no project version", async () => {
    tmpDir = await makeProject({
      "pom.xml": `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.1</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
</project>`,
      "src/main/java/App.java": "public class App {}",
    });
    const ctx = await detectContext(tmpDir);
    const maven = ctx.frameworks.find((f) => f.name === "Maven");
    expect(maven).toBeDefined();
    expect(maven!.version).toBe("3.2.1");
  });

  it("prefers project version over parent version in Maven", async () => {
    tmpDir = await makeProject({
      "pom.xml": `<?xml version="1.0"?>
<project>
  <parent>
    <groupId>org.springframework.boot</groupId>
    <artifactId>spring-boot-starter-parent</artifactId>
    <version>3.2.1</version>
  </parent>
  <groupId>com.example</groupId>
  <artifactId>my-app</artifactId>
  <version>1.0.0</version>
</project>`,
      "src/main/java/App.java": "public class App {}",
    });
    const ctx = await detectContext(tmpDir);
    const maven = ctx.frameworks.find((f) => f.name === "Maven");
    expect(maven).toBeDefined();
    expect(maven!.version).toBe("1.0.0");
  });
});

// ── SECONDARY_LANGUAGE_THRESHOLD ─────────────────────────────────────────────

describe("SECONDARY_LANGUAGE_THRESHOLD", () => {
  it("exports the threshold as 0.15", () => {
    expect(SECONDARY_LANGUAGE_THRESHOLD).toBe(0.15);
  });

  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("includes language at exactly 15% as secondary", async () => {
    // 20 total files: 17 TS + 3 Python = 15% Python
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "test" }),
      "tsconfig.json": "{}",
    };
    for (let i = 0; i < 17; i++) {
      files[`src/mod${i}.ts`] = `export const x${i} = ${i};`;
    }
    for (let i = 0; i < 3; i++) {
      files[`scripts/s${i}.py`] = `x = ${i}`;
    }
    tmpDir = await makeProject(files);
    const ctx = await detectContext(tmpDir);
    expect(ctx.secondaryLanguages).toContain("python");
  });

  it("excludes language below 15% from secondary", async () => {
    // 21 total files: 18 TS + 3 Python = 14.3% Python (< 15%)
    const files: Record<string, string> = {
      "package.json": JSON.stringify({ name: "test" }),
      "tsconfig.json": "{}",
    };
    for (let i = 0; i < 18; i++) {
      files[`src/mod${i}.ts`] = `export const x${i} = ${i};`;
    }
    for (let i = 0; i < 3; i++) {
      files[`scripts/s${i}.py`] = `x = ${i}`;
    }
    tmpDir = await makeProject(files);
    const ctx = await detectContext(tmpDir);
    expect(ctx.secondaryLanguages ?? []).not.toContain("python");
  });
});

// ── enrichFrameworksWithUsage ───────────────────────────────────────────────

describe("enrichFrameworksWithUsage", () => {
  it("keeps all frameworks and annotates import counts", () => {
    const frameworks: DetectedFramework[] = [
      { name: "React", version: "18.0.0" },
      { name: "Express", version: "4.0.0" },
    ];
    const counts = new Map([["react", 10]]);

    const result = enrichFrameworksWithUsage(frameworks, counts);

    expect(result.find((f) => f.name === "React")?.importCount).toBe(10);
    expect(result.find((f) => f.name === "Express")?.importCount).toBe(0);
    expect(result.map((f) => f.name)).toContain("Express");
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
