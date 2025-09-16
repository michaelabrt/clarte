import { describe, expect, it } from "vitest";
import { buildClaudeSkills, renderClaudeSkill } from "../templates/claude-skills.js";
import type { ClaudeSkill, ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";

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
    ide: "claude",
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

function mockAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [
      { path: "src/index.ts", centrality: 1.0, importedBy: 5, imports: 3 },
      { path: "src/utils.ts", centrality: 0.8, importedBy: 4, imports: 1 },
    ],
    circularDeps: [],
    layers: [
      { name: "types", files: ["src/types.ts"], importedByLayers: 3 },
      { name: "utils", files: ["src/utils.ts"], importedByLayers: 2 },
    ],
    gitActivity: null,
    instabilities: [],
    communities: [],
    ...overrides,
  };
}

describe("buildClaudeSkills", () => {
  it("generates script-based skills from package.json scripts", () => {
    const scripts = { test: "vitest run", build: "tsup", dev: "tsup --watch" };
    const skills = buildClaudeSkills(mockCtx(), mockAnswers(), undefined, scripts);
    const names = skills.map((s) => s.name);
    expect(names).toContain("test");
    expect(names).toContain("build");
    expect(names).toContain("dev");
  });

  it("script skills are disable-model-invocation", () => {
    const scripts = { test: "vitest run" };
    const skills = buildClaudeSkills(mockCtx(), mockAnswers(), undefined, scripts);
    const testSkill = skills.find((s) => s.name === "test");
    expect(testSkill?.disableModelInvocation).toBe(true);
  });

  it("generates architecture skill when analysis has hub files", () => {
    const skills = buildClaudeSkills(mockCtx(), mockAnswers(), mockAnalysis());
    const archSkill = skills.find((s) => s.name === "architecture");
    expect(archSkill).toBeDefined();
    expect(archSkill!.body).toContain("src/index.ts");
    expect(archSkill!.allowedTools).toBe("Read, Grep, Glob");
  });

  it("skips architecture skill when no analysis", () => {
    const skills = buildClaudeSkills(mockCtx(), mockAnswers());
    const archSkill = skills.find((s) => s.name === "architecture");
    expect(archSkill).toBeUndefined();
  });

  it("skips script skills when no scripts provided", () => {
    const skills = buildClaudeSkills(mockCtx(), mockAnswers(), mockAnalysis());
    const scriptSkills = skills.filter((s) => s.disableModelInvocation);
    expect(scriptSkills).toHaveLength(0);
  });

  it("uses correct run command for pnpm", () => {
    const scripts = { test: "vitest run" };
    const skills = buildClaudeSkills(
      mockCtx({ packageManager: "pnpm" }),
      mockAnswers(),
      undefined,
      scripts,
    );
    const testSkill = skills.find((s) => s.name === "test");
    expect(testSkill?.body).toContain("pnpm test");
  });
});

describe("renderClaudeSkill", () => {
  it("produces valid YAML frontmatter", () => {
    const skill: ClaudeSkill = {
      name: "test",
      description: "Run tests",
      disableModelInvocation: true,
      body: "# Run tests\n\nRun: `npm test`",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).toMatch(/^---\n/);
    expect(rendered).toContain("description: Run tests");
    expect(rendered).toContain("disable-model-invocation: true");
    expect(rendered).toContain("---\n\n# Run tests");
  });

  it("includes allowed-tools when specified", () => {
    const skill: ClaudeSkill = {
      name: "arch",
      description: "Explore architecture",
      disableModelInvocation: false,
      allowedTools: "Read, Grep, Glob",
      body: "# Architecture",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).toContain("allowed-tools: Read, Grep, Glob");
    expect(rendered).not.toContain("disable-model-invocation");
  });

  it("omits disable-model-invocation when false", () => {
    const skill: ClaudeSkill = {
      name: "arch",
      description: "Explore architecture",
      disableModelInvocation: false,
      body: "# Architecture",
    };
    const rendered = renderClaudeSkill(skill);
    expect(rendered).not.toContain("disable-model-invocation");
  });
});
