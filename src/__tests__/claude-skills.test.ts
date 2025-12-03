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

function mockAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [
      { path: "src/index.ts", centrality: 1.0, importedBy: 5, imports: 3 },
      { path: "src/utils.ts", centrality: 0.8, importedBy: 4, imports: 1 },
    ],
    circularDeps: [],
    layers: [
      { name: "types", files: ["src/types.ts"], importedByLayers: 3, dependsOn: [] },
      { name: "utils", files: ["src/utils.ts"], importedByLayers: 2, dependsOn: ["types"] },
    ],
    layerEdges: [{ from: "utils", to: "types" }],
    gitActivity: null,
    instabilities: [],
    communities: [],
    ...overrides,
  };
}

describe("buildClaudeSkills", () => {
  it("generates script-based skills from package.json scripts", async () => {
    const scripts = { test: "vitest run", build: "tsup", dev: "tsup --watch" };
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers(), undefined, scripts);
    const names = skills.map((s) => s.name);
    expect(names).toContain("test");
    expect(names).toContain("build");
    expect(names).toContain("dev");
  });

  it("script skills are disable-model-invocation", async () => {
    const scripts = { test: "vitest run" };
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers(), undefined, scripts);
    const testSkill = skills.find((s) => s.name === "test");
    expect(testSkill?.disableModelInvocation).toBe(true);
  });

  it("generates architecture skill when analysis has hub files", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers(), mockAnalysis());
    const archSkill = skills.find((s) => s.name === "architecture");
    expect(archSkill).toBeDefined();
    expect(archSkill!.body).toContain("src/index.ts");
    expect(archSkill!.allowedTools).toBe("Read, Grep, Glob");
  });

  it("skips architecture skill when no analysis", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers());
    const archSkill = skills.find((s) => s.name === "architecture");
    expect(archSkill).toBeUndefined();
  });

  it("uses correct run command for pnpm", async () => {
    const scripts = { test: "vitest run" };
    const skills = await buildClaudeSkills(mockCtx({ packageManager: "pnpm" }), mockAnswers(), undefined, scripts);
    const testSkill = skills.find((s) => s.name === "test");
    expect(testSkill?.body).toContain("pnpm test");
  });

  it("generates clarte-refresh skill with disableModelInvocation=true", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers());
    const refreshSkill = skills.find((s) => s.name === "clarte-refresh");
    expect(refreshSkill).toBeDefined();
    expect(refreshSkill!.disableModelInvocation).toBe(true);
    expect(refreshSkill!.allowedTools).toBe("Bash");
    expect(refreshSkill!.body).toContain("--refresh-snapshot");
  });

  it("generates clarte-file skill with --format=json reference", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers());
    const fileSkill = skills.find((s) => s.name === "clarte-file");
    expect(fileSkill).toBeDefined();
    expect(fileSkill!.body).toContain("--format=json");
    expect(fileSkill!.allowedTools).toBe("Bash");
  });

  it("generates clarte-impact skill with --diff reference", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers());
    const impactSkill = skills.find((s) => s.name === "clarte-impact");
    expect(impactSkill).toBeDefined();
    expect(impactSkill!.body).toContain("--diff");
    expect(impactSkill!.allowedTools).toBe("Bash");
  });

  it("always generates all three clarte skills regardless of analysis", async () => {
    const skills = await buildClaudeSkills(mockCtx(), mockAnswers());
    const clarteSkills = skills.filter((s) => s.name.startsWith("clarte-"));
    expect(clarteSkills).toHaveLength(3);
    expect(clarteSkills.map((s) => s.name)).toEqual(["clarte-refresh", "clarte-file", "clarte-impact"]);
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
});
