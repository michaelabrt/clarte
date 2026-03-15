import { describe, expect, it, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  renderProjectInfoSections,
  getProjectName,
  resetProjectNameCache,
} from "../steer/context/sections/project-info.js";
import type { DetectedContext, UserAnswers } from "../core/types.js";

function makeCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test-project",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "biome",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 5000,
    sourceFileCount: 10,
    monorepo: null,
    ...overrides,
  };
}

const defaultAnswers: UserAnswers = {
  ides: ["claude"],
  projectPurpose: "A CLI tool",
  keyPatterns: "Conventional commits",
  gotchas: "No default exports",
  generateSnapshot: true,
  snapshotPaths: ["src/"],
  stackConfirmed: true,
  stackCorrections: "",
  generatePerPackage: false,
};

describe("renderProjectInfoSections", () => {
  it("returns sections with correct ids", async () => {
    const ctx = makeCtx();
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test-project");

    const ids = sections.map((s) => s.id);
    expect(ids).toContain("header");
    expect(ids).toContain("tech-stack");
    expect(ids).toContain("development");
  });

  it("header contains project name", async () => {
    const ctx = makeCtx();
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "my-app");

    const header = sections.find((s) => s.id === "header");
    expect(header?.content).toContain("# my-app");
  });

  it("header includes description when projectPurpose is set", async () => {
    const ctx = makeCtx();
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const header = sections.find((s) => s.id === "header");
    expect(header?.content).toContain("A CLI tool");
  });

  it("header omits description when projectPurpose is empty", async () => {
    const ctx = makeCtx();
    const answers = { ...defaultAnswers, projectPurpose: "" };
    const sections = await renderProjectInfoSections(ctx, answers, "test");

    const header = sections.find((s) => s.id === "header");
    expect(header?.content).toBe("# test");
  });

  it("includes framework info in tech stack", async () => {
    const ctx = makeCtx({
      frameworks: [
        { name: "React", version: "18.2.0", importCount: 25 },
        { name: "Vitest", version: "1.0.0", importCount: 0 },
      ],
    });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack?.content).toContain("React");
    expect(techStack?.content).toContain("18.2.0");
    expect(techStack?.content).toContain("used in 25 files");
    expect(techStack?.content).toContain("config-only");
  });

  it("includes TypeScript in tech stack when hasTypeScript", async () => {
    const ctx = makeCtx({ hasTypeScript: true });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack?.content).toContain("TypeScript");
  });

  it("includes linter in tech stack", async () => {
    const ctx = makeCtx({ linter: "biome" });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack?.content).toContain("Biome");
    expect(techStack?.content).toContain("linter/formatter");
  });

  it("includes package manager in tech stack", async () => {
    const ctx = makeCtx({ packageManager: "pnpm" });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack?.content).toContain("pnpm");
    expect(techStack?.content).toContain("package manager");
  });


  it("all sections have positive token estimates", async () => {
    const ctx = makeCtx();
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    for (const section of sections) {
      expect(section.tokens).toBeGreaterThan(0);
    }
  });

  it("development section includes npm commands for npm projects", async () => {
    const ctx = makeCtx({ packageManager: "npm" });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const dev = sections.find((s) => s.id === "development");
    expect(dev?.content).toContain("npm install");
  });

  it("development section includes check-tests directive when testFramework is set", async () => {
    const ctx = makeCtx({ testFramework: "Vitest" });
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const dev = sections.find((s) => s.id === "development");
    expect(dev?.content).toContain(".clarte/scripts/check-tests.sh");
  });

  it("development section omits check-tests directive when no testFramework", async () => {
    const ctx = makeCtx();
    const sections = await renderProjectInfoSections(ctx, defaultAnswers, "test");

    const dev = sections.find((s) => s.id === "development");
    expect(dev?.content).not.toContain("check-tests");
  });
});

describe("getProjectName", () => {
  let tmpDir: string;

  beforeEach(async () => {
    resetProjectNameCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-projinfo-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("reads name from package.json", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "my-pkg" }));

    const ctx = makeCtx({ rootDir: tmpDir });
    const name = await getProjectName(ctx);
    expect(name).toBe("my-pkg");
  });

  it("falls back to directory name when no manifest found", async () => {
    const ctx = makeCtx({ rootDir: tmpDir });
    const name = await getProjectName(ctx);
    // tmpDir ends with a random suffix, but first char should be uppercased
    expect(name.length).toBeGreaterThan(0);
    expect(name[0]).toBe(name[0].toUpperCase());
  });

  it("caches result for same rootDir", async () => {
    await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "cached-name" }));

    const ctx = makeCtx({ rootDir: tmpDir });
    const name1 = await getProjectName(ctx);
    // Remove file to prove cache is used
    await fs.unlink(path.join(tmpDir, "package.json"));
    const name2 = await getProjectName(ctx);
    expect(name1).toBe("cached-name");
    expect(name2).toBe("cached-name");
  });
});

describe("resetProjectNameCache", () => {
  it("clears the cached project name", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-projinfo-"));
    try {
      await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "first" }));
      const ctx = makeCtx({ rootDir: tmpDir });

      await getProjectName(ctx);
      resetProjectNameCache();

      // Change the file
      await fs.writeFile(path.join(tmpDir, "package.json"), JSON.stringify({ name: "second" }));
      const name = await getProjectName(ctx);
      expect(name).toBe("second");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
