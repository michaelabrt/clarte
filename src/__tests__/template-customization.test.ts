import { describe, expect, it } from "vitest";
import { buildSections, resetProjectNameCache } from "../templates/main-context.js";
import { buildAiderContext } from "../templates/aider-context.js";
import { renderArchitectureSections } from "../templates/sections/architecture.js";
import type { ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";

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
      {
        path: "src/types.ts",
        centrality: 1.0,
        authority: 1.0,
        hubScore: 0.1,
        role: "Foundation",
        importedBy: 20,
        imports: 0,
      },
      {
        path: "src/utils.ts",
        centrality: 0.8,
        authority: 0.8,
        hubScore: 0.3,
        role: "Foundation",
        importedBy: 14,
        imports: 2,
      },
    ],
    circularDeps: [{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"], severity: 0.5, breakHint: "Extract shared type" }],
    layers: [
      { name: "types", files: ["src/types.ts"], importedByLayers: 3, dependsOn: [] },
      { name: "utils", files: ["src/utils.ts"], importedByLayers: 2, dependsOn: ["types"] },
      { name: "graph", files: ["src/graph.ts"], importedByLayers: 1, dependsOn: ["types", "utils"] },
    ],
    layerEdges: [
      { from: "utils", to: "types" },
      { from: "graph", to: "utils" },
    ],
    gitActivity: {
      commitCounts: new Map([["src/index.ts", 16]]),
      hotFiles: [{ path: "src/index.ts", commits: 16, lastChanged: "2 hours ago" }],
      changeCoupling: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 10, support: 0.5, confidence: 0.83 }],
    },
    instabilities: [],
    communities: [{ id: 0, files: ["src/types.ts"], label: "types" }],
    deadFiles: ["src/unused.ts", "src/old-helper.ts", "src/deprecated.ts"],
    crossCuttingFiles: [
      { file: "src/types.ts", totalImporters: 20, layerSpread: 3, layers: ["types", "utils", "graph"] },
    ],
    chokepoints: [{ file: "src/utils.ts", separates: 2, importedBy: 14, upstreamCount: 2, downstreamCount: 0 }],
    structuralMismatches: [
      {
        fileA: "src/schema.ts",
        fileB: "src/migration.ts",
        graphDistance: -1,
        coChangeConfidence: 0.9,
        coChangeCount: 8,
      },
      { fileA: "src/config.ts", fileB: "src/refresh.ts", graphDistance: 3, coChangeConfidence: 0.75, coChangeCount: 5 },
    ],
    ...overrides,
  };
}

// ── Task 1a: Section ordering ───────────────────────────────────────────

describe("section ordering (sectionOrder)", () => {
  it("reorders sections when sectionOrder is provided", async () => {
    const answers = {
      ...mockAnswers({ ides: ["generic"] }),
      sectionOrder: ["tech-stack", "architecture", "key-files"],
    } as UserAnswers;

    const sections = await buildSections(mockCtx(), answers, null, mockAnalysis());

    const techStack = sections.find((s) => s.id === "tech-stack");
    const architecture = sections.find((s) => s.id === "architecture");
    const keyFiles = sections.find((s) => s.id === "key-files");

    expect(techStack).toBeDefined();
    expect(architecture).toBeDefined();
    expect(keyFiles).toBeDefined();

    // tech-stack should be priority 0, architecture priority 1, key-files priority 2
    expect(techStack!.priority).toBe(0);
    expect(architecture!.priority).toBe(1);
    expect(keyFiles!.priority).toBe(2);
  });

  it("excludes sections prefixed with '-'", async () => {
    const answers = {
      ...mockAnswers({ ides: ["generic"] }),
      sectionOrder: ["-dead-files", "-chokepoints"],
    } as UserAnswers;

    const sections = await buildSections(mockCtx(), answers, null, mockAnalysis());

    const deadFiles = sections.find((s) => s.id === "dead-files");
    const chokepoints = sections.find((s) => s.id === "chokepoints");

    expect(deadFiles).toBeUndefined();
    expect(chokepoints).toBeUndefined();
  });

  it("combines ordering and exclusion", async () => {
    const answers = {
      ...mockAnswers({ ides: ["generic"] }),
      sectionOrder: ["key-files", "tech-stack", "-dead-files"],
    } as UserAnswers;

    const sections = await buildSections(mockCtx(), answers, null, mockAnalysis());

    // key-files gets priority 0, tech-stack gets priority 1
    const keyFiles = sections.find((s) => s.id === "key-files");
    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(keyFiles!.priority).toBe(0);
    expect(techStack!.priority).toBe(1);

    // dead-files excluded
    expect(sections.find((s) => s.id === "dead-files")).toBeUndefined();
  });

  it("non-listed sections keep offset priorities after ordered sections", async () => {
    const answers = {
      ...mockAnswers({ ides: ["generic"] }),
      sectionOrder: ["architecture"],
    } as UserAnswers;

    const sections = await buildSections(mockCtx(), answers, null, mockAnalysis());

    const architecture = sections.find((s) => s.id === "architecture");
    const hotFiles = sections.find((s) => s.id === "hot-files");

    expect(architecture!.priority).toBe(0);
    // hot-files default priority is 7, offset by 1 (one item in sectionOrder) = 8
    expect(hotFiles!.priority).toBe(8);
  });

  it("does nothing when sectionOrder is empty or missing", async () => {
    const answers = mockAnswers({ ides: ["generic"] });
    const sections = await buildSections(mockCtx(), answers, null, mockAnalysis());

    // Default priorities should be used
    const techStack = sections.find((s) => s.id === "tech-stack");
    expect(techStack!.priority).toBe(1);
  });
});

// ── Task 1b: Aider context enrichment ───────────────────────────────────

describe("aider context enrichment", () => {
  it("includes dead file warnings (max 5)", async () => {
    const analysis = mockAnalysis({
      deadFiles: [
        "src/unused1.ts",
        "src/unused2.ts",
        "src/unused3.ts",
        "src/unused4.ts",
        "src/unused5.ts",
        "src/unused6.ts",
      ],
    });

    const result = await buildAiderContext(mockCtx(), mockAnswers(), null, analysis);

    expect(result).toContain("DEAD FILE: src/unused1.ts has no importers. Consider removing.");
    expect(result).toContain("DEAD FILE: src/unused5.ts has no importers. Consider removing.");
    // 6th entry should be excluded (max 5)
    expect(result).not.toContain("DEAD FILE: src/unused6.ts");
  });

  it("includes circular dependency details", async () => {
    const analysis = mockAnalysis({
      circularDeps: [{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"], severity: 0.5, breakHint: "Extract shared type" }],
    });

    const result = await buildAiderContext(mockCtx(), mockAnswers(), null, analysis);

    expect(result).toContain("CIRCULAR DEP:");
    expect(result).toContain("src/a.ts -> src/b.ts -> src/a.ts");
    expect(result).toContain("Extract shared type");
  });

  it("includes structural mismatch warnings (max 3)", async () => {
    const analysis = mockAnalysis({
      structuralMismatches: [
        {
          fileA: "src/schema.ts",
          fileB: "src/migration.ts",
          graphDistance: -1,
          coChangeConfidence: 0.9,
          coChangeCount: 8,
        },
        {
          fileA: "src/config.ts",
          fileB: "src/refresh.ts",
          graphDistance: 3,
          coChangeConfidence: 0.75,
          coChangeCount: 5,
        },
        { fileA: "src/a.ts", fileB: "src/b.ts", graphDistance: 2, coChangeConfidence: 0.7, coChangeCount: 4 },
        { fileA: "src/c.ts", fileB: "src/d.ts", graphDistance: -1, coChangeConfidence: 0.6, coChangeCount: 3 },
      ],
    });

    const result = await buildAiderContext(mockCtx(), mockAnswers(), null, analysis);

    expect(result).toContain(
      "HIDDEN COUPLING: src/schema.ts and src/migration.ts change together but have no import link.",
    );
    expect(result).toContain(
      "HIDDEN COUPLING: src/config.ts and src/refresh.ts change together but have no import link.",
    );
    expect(result).toContain("HIDDEN COUPLING: src/a.ts and src/b.ts change together but have no import link.");
    // 4th entry should be excluded (max 3)
    expect(result).not.toContain("HIDDEN COUPLING: src/c.ts");
  });

  it("omits dead file section when no dead files", async () => {
    const analysis = mockAnalysis({ deadFiles: [] });
    const result = await buildAiderContext(mockCtx(), mockAnswers(), null, analysis);
    expect(result).not.toContain("DEAD FILE:");
  });

  it("omits structural mismatch section when no mismatches", async () => {
    const analysis = mockAnalysis({ structuralMismatches: undefined });
    const result = await buildAiderContext(mockCtx(), mockAnswers(), null, analysis);
    expect(result).not.toContain("HIDDEN COUPLING:");
  });
});

// ── Task 1c: Per-IDE section emphasis ───────────────────────────────────

describe("per-IDE section emphasis", () => {
  it("Claude boosts working-guidelines and config-constraints to priority 1", async () => {
    const analysis = mockAnalysis({
      configConstraints: {
        typescript: {
          strict: true,
          target: "ES2022",
          pathAliases: {},
          otherStrict: [],
        },
      },
    });

    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["claude"] }), null, analysis);

    const guidelines = sections.find((s) => s.id === "working-guidelines");
    const constraints = sections.find((s) => s.id === "config-constraints");
    expect(guidelines).toBeDefined();
    expect(guidelines!.priority).toBe(1);
    // config-constraints default is 1, Claude boost also sets to 1 (no change or already at 1)
    expect(constraints).toBeDefined();
    expect(constraints!.priority).toBe(1);
  });

  it("Cursor boosts architecture to priority 2", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["cursor"] }), null, mockAnalysis());

    const architecture = sections.find((s) => s.id === "architecture");
    expect(architecture).toBeDefined();
    expect(architecture!.priority).toBe(2);
  });

  it("Copilot boosts conventions to priority 2 and code-snapshot to priority 3", async () => {
    const snapshot = {
      entries: [],
      markdown: "### Types\n\n```ts\nexport type Foo = string;\n```",
    };
    const analysis = mockAnalysis({
      conventions: {
        naming: { functions: "camelCase", types: "PascalCase", constants: "UPPER_CASE", files: "kebab-case" },
        exportStyle: { preferNamed: true, defaultExportPercent: 5, barrelFileCount: 0 },
      },
    });

    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["copilot"] }), snapshot, analysis);

    const conventions = sections.find((s) => s.id === "conventions");
    const codeSnapshot = sections.find((s) => s.id === "code-snapshot");
    expect(conventions).toBeDefined();
    expect(conventions!.priority).toBe(2);
    expect(codeSnapshot).toBeDefined();
    expect(codeSnapshot!.priority).toBe(3);
  });

  it("does not apply boosts when multiple IDEs are targeted", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["claude", "cursor"] }), null, mockAnalysis());

    const guidelines = sections.find((s) => s.id === "working-guidelines");
    const architecture = sections.find((s) => s.id === "architecture");
    // Default priorities: working-guidelines=2, architecture=4
    expect(guidelines!.priority).toBe(2);
    expect(architecture!.priority).toBe(4);
  });

  it("does not apply boosts for aider IDE", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["aider"] }), null, mockAnalysis());

    // All sections should have their default priorities
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    expect(guidelines!.priority).toBe(2);
  });
});

// ── Task 3: getProjectName caching ──────────────────────────────────────

describe("getProjectName caching", () => {
  it("resetProjectNameCache is exported and callable", () => {
    expect(typeof resetProjectNameCache).toBe("function");
    // Should not throw
    resetProjectNameCache();
  });

  it("buildSections calls getProjectName and produces consistent header", async () => {
    const sections1 = await buildSections(mockCtx(), mockAnswers({ ides: ["generic"] }), null);
    const sections2 = await buildSections(mockCtx(), mockAnswers({ ides: ["generic"] }), null);

    const header1 = sections1.find((s) => s.id === "header")!.content;
    const header2 = sections2.find((s) => s.id === "header")!.content;
    expect(header1).toBe(header2);
  });

  it("uses directory name as fallback project name", async () => {
    const ctx = mockCtx({ rootDir: "/tmp/my-awesome-project" });
    const sections = await buildSections(ctx, mockAnswers({ ides: ["generic"] }), null);
    const header = sections.find((s) => s.id === "header")!.content;
    // Should capitalize the directory name as project name
    expect(header).toContain("# My-awesome-project");
  });
});

describe("Key Files instability rendering", () => {
  function minimalCtx(): DetectedContext {
    return {
      rootDir: "/tmp/test",
      language: "typescript",
      hasTypeScript: true,
      packageManager: "npm",
      linter: "none",
      frameworks: [],
      directories: [],
      dependencies: [],
      isGitRepo: false,
      totalSourceBytes: 1000,
      sourceFileCount: 5,
      monorepo: null,
    };
  }

  it("suppresses ⚠️ for Orchestrator files with high instability", async () => {
    const analysis: ContextAnalysis = {
      hubFiles: [
        {
          path: "src/index.ts",
          centrality: 0.9,
          authority: 0.1,
          hubScore: 0.9,
          role: "Orchestrator",
          importedBy: 1,
          imports: 20,
        },
        // Foundation files have low instability and won't appear in instabilities array
        {
          path: "src/types.ts",
          centrality: 1.0,
          authority: 1.0,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 40,
          imports: 0,
        },
      ],
      // Only high-instability files appear here (> 0.8 threshold, fanIn >= 1)
      instabilities: [{ path: "src/index.ts", fanIn: 1, fanOut: 20, instability: 0.95 }],
      circularDeps: [],
      layers: [],
      layerEdges: [],
      gitActivity: null,
      communities: [],
    };

    const sections = await renderArchitectureSections(analysis, minimalCtx());
    const keyFiles = sections.find((s) => s.id === "key-files");
    expect(keyFiles).toBeDefined();

    // Orchestrator row: has instability number but no ⚠️
    expect(keyFiles!.content).toContain("95% unstable");
    const orchestratorRow = keyFiles!.content.split("\n").find((l) => l.includes("src/index.ts"));
    expect(orchestratorRow).toBeDefined();
    expect(orchestratorRow).not.toContain("⚠️");

    // Foundation row: no instability score (not in instabilities array) → shows "stable"
    const foundationRow = keyFiles!.content.split("\n").find((l) => l.includes("src/types.ts"));
    expect(foundationRow).toBeDefined();
    expect(foundationRow).toContain("stable");
    expect(foundationRow).not.toContain("⚠️");
  });

  it("shows ⚠️ for Foundation files with high instability", async () => {
    const analysis: ContextAnalysis = {
      hubFiles: [
        {
          path: "src/types.ts",
          centrality: 1.0,
          authority: 1.0,
          hubScore: 0.1,
          role: "Foundation",
          importedBy: 40,
          imports: 0,
        },
      ],
      instabilities: [{ path: "src/types.ts", fanIn: 3, fanOut: 10, instability: 0.77 }],
      circularDeps: [],
      layers: [],
      layerEdges: [],
      gitActivity: null,
      communities: [],
    };

    const sections = await renderArchitectureSections(analysis, minimalCtx());
    const keyFiles = sections.find((s) => s.id === "key-files");
    expect(keyFiles).toBeDefined();
    const foundationRow = keyFiles!.content.split("\n").find((l) => l.includes("src/types.ts"));
    expect(foundationRow).toBeDefined();
    expect(foundationRow).toContain("⚠️");
  });
});
