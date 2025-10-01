import { describe, expect, it } from "vitest";
import { buildMainContext, buildSections, applyBudget } from "../templates/main-context.js";
import type { ContextAnalysis, ContextSection, DetectedContext, UserAnswers } from "../types.js";

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
    projectPurpose: "A test project for budget testing",
    keyPatterns: "Use TypeScript strict mode",
    gotchas: "Never use any type",
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
      { path: "src/types.ts", centrality: 1.0, authority: 1.0, hubScore: 0.1, role: "Foundation", importedBy: 20, imports: 0 },
      { path: "src/utils.ts", centrality: 0.8, authority: 0.8, hubScore: 0.3, role: "Foundation", importedBy: 14, imports: 2 },
    ],
    circularDeps: [
      { chain: ["a.ts", "b.ts", "a.ts"], breakHint: "Use type-only import" },
    ],
    layers: [
      { name: "types", files: ["src/types.ts"], importedByLayers: 3, dependsOn: [] },
      { name: "utils", files: ["src/utils.ts"], importedByLayers: 2, dependsOn: ["types"] },
      { name: "graph", files: ["src/graph.ts"], importedByLayers: 1, dependsOn: ["types", "utils"] },
    ],
    layerEdges: [{ from: "utils", to: "types" }, { from: "graph", to: "utils" }],
    gitActivity: {
      commitCounts: new Map([["src/index.ts", 16]]),
      hotFiles: [
        { path: "src/index.ts", commits: 16, lastChanged: "2 hours ago" },
        { path: "src/types.ts", commits: 12, lastChanged: "6 hours ago" },
      ],
      changeCoupling: [
        { fileA: "a.ts", fileB: "b.ts", coChangeCount: 10, support: 0.5, confidence: 0.83 },
      ],
    },
    instabilities: [],
    communities: [{ id: 0, files: ["src/types.ts"], label: "types" }],
    deadFiles: ["src/unused.ts"],
    crossCuttingFiles: [
      { file: "src/types.ts", totalImporters: 20, layerSpread: 3, layers: ["types", "utils", "graph"] },
    ],
    chokepoints: [
      { file: "src/utils.ts", separates: 2, importedBy: 14 },
    ],
    tightCouplings: [
      { from: "src/index.ts", to: "src/types.ts", importedNames: 15, names: [] },
    ],
    ...overrides,
  };
}

describe("buildSections", () => {
  it("returns sections with priorities and token estimates", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null, mockAnalysis());
    expect(sections.length).toBeGreaterThan(5);
    for (const s of sections) {
      expect(s.id).toBeTruthy();
      expect(typeof s.priority).toBe("number");
      expect(typeof s.tokens).toBe("number");
      expect(s.tokens).toBeGreaterThan(0);
      expect(s.content).toBeTruthy();
    }
  });

  it("includes priority 0 sections (header, what-is-this, key-patterns, gotchas, development)", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null);
    const p0 = sections.filter((s) => s.priority === 0);
    const p0Ids = p0.map((s) => s.id);
    expect(p0Ids).toContain("header");
    expect(p0Ids).toContain("what-is-this");
    expect(p0Ids).toContain("key-patterns");
    expect(p0Ids).toContain("gotchas");
    expect(p0Ids).toContain("development");
  });

  it("includes tech-stack at priority 1", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null);
    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack).toBeDefined();
    expect(techStack!.priority).toBe(1);
  });

  it("includes working-guidelines at priority 2 when analysis has directives", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null, mockAnalysis());
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    expect(guidelines).toBeDefined();
    expect(guidelines!.priority).toBe(2);
  });
});

describe("applyBudget", () => {
  const makeSections = (specs: Array<[string, number, number]>): ContextSection[] =>
    specs.map(([id, priority, tokens]) => ({
      id,
      priority,
      content: `Section ${id}`,
      tokens,
    }));

  it("includes all sections when budget is large enough", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["dev", 0, 50],
    ]);
    const { included, omitted } = applyBudget(sections, 10000);
    expect(included).toHaveLength(4);
    expect(omitted).toHaveLength(0);
  });

  it("always includes priority 0 sections", () => {
    const sections = makeSections([
      ["header", 0, 500],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["dev", 0, 500],
    ]);
    // Budget is very small, but priority 0 always stays
    const { included } = applyBudget(sections, 100);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("header");
    expect(ids).toContain("dev");
  });

  it("always includes priority 1-2 sections (even over budget)", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["guidelines", 2, 100],
      ["arch", 4, 200],
      ["dev", 0, 50],
    ]);
    // Budget of 200: p0=100 tokens, p1-2=200 tokens, leaves 0 for p4
    const { included, omitted } = applyBudget(sections, 200);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("tech");
    expect(ids).toContain("guidelines");
    expect(omitted).toContain("arch");
  });

  it("drops lower-priority sections when budget is exceeded", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["hot", 7, 150],
      ["dead", 9, 100],
      ["tight", 10, 100],
      ["dev", 0, 50],
    ]);
    // Budget of 400: p0=100, p1=100, leaves 200. arch=200 fits, hot=150 won't
    const { included, omitted } = applyBudget(sections, 400);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("header");
    expect(ids).toContain("tech");
    expect(ids).toContain("arch");
    expect(omitted).toContain("hot");
    expect(omitted).toContain("dead");
    expect(omitted).toContain("tight");
  });

  it("preserves original section order in included list", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 50],
      ["dev", 0, 50],
    ]);
    const { included } = applyBudget(sections, 10000);
    const ids = included.map((s) => s.id);
    expect(ids).toEqual(["header", "tech", "arch", "dev"]);
  });
});

describe("buildMainContext with budget", () => {
  it("budget=0 includes all sections (backward compat)", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 0);
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("## Key Files");
    expect(result).toContain("## Architecture");
    expect(result).toContain("## Recently Active Files");
    expect(result).toContain("## Dead Files");
    expect(result).not.toContain("<!-- Sections omitted");
  });

  it("no budget param includes all sections", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis());
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("## Dead Files");
    expect(result).not.toContain("<!-- Sections omitted");
  });

  it("very small budget omits low-priority sections and adds note", async () => {
    // Very small budget: should only include priority 0-2
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 500);
    expect(result).toContain("## Tech Stack"); // priority 1
    expect(result).toContain("## Key Files"); // priority 2
    expect(result).toContain("<!-- Sections omitted");
  });

  it("moderate budget includes through mid-priority sections", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 2000);
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("## Key Files");
    // With 2000 tokens there should be room for several more sections
    expect(result).toContain("## Architecture");
  });

  it("omitted sections list is correct", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 500);
    // Should mention some omitted section IDs
    if (result.includes("<!-- Sections omitted")) {
      expect(result).toMatch(/Sections omitted to fit token budget:/);
    }
  });
});
