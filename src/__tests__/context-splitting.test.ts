import { describe, expect, it } from "vitest";
import {
  shouldSplitContext,
  computeDirectoryBudgets,
  buildDirectoryContext,
  buildTieredContext,
} from "../context-splitting.js";
import type {
  ContextAnalysis,
  DetectedContext,
  ImportGraph,
  ImportEdge,
  UserAnswers,
  CodeSnapshot,
} from "../types.js";

// ── Test helpers ─────────────────────────────────────────────────────────────

function mockCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: ["src", "src/components", "src/services", "src/utils"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 500000,
    sourceFileCount: 200,
    monorepo: null,
    ...overrides,
  };
}

function mockAnswers(overrides?: Partial<UserAnswers>): UserAnswers {
  return {
    ides: ["claude"],
    projectPurpose: "A large-scale application with many components",
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

/** Build edges for files across multiple directories */
function makeEdges(): ImportEdge[] {
  const edges: ImportEdge[] = [];

  // src/components has 8 files importing from src/utils
  for (let i = 0; i < 8; i++) {
    edges.push({
      from: `src/components/comp${i}.ts`,
      to: "src/utils/helpers.ts",
      isExternal: false,
      specifier: "../utils/helpers",
      importedNames: ["formatDate"],
    });
  }

  // Internal component imports
  for (let i = 1; i < 8; i++) {
    edges.push({
      from: `src/components/comp${i}.ts`,
      to: "src/components/comp0.ts",
      isExternal: false,
      specifier: "./comp0",
      importedNames: ["BaseComp"],
    });
  }

  // src/services has 6 files
  for (let i = 0; i < 6; i++) {
    edges.push({
      from: `src/services/svc${i}.ts`,
      to: "src/utils/helpers.ts",
      isExternal: false,
      specifier: "../utils/helpers",
      importedNames: ["formatDate"],
    });
    edges.push({
      from: `src/services/svc${i}.ts`,
      to: `src/services/base.ts`,
      isExternal: false,
      specifier: "./base",
      importedNames: ["BaseService"],
    });
  }

  // src/utils has 5+ files (helpers + others)
  for (let i = 0; i < 5; i++) {
    edges.push({
      from: `src/utils/util${i}.ts`,
      to: "src/utils/helpers.ts",
      isExternal: false,
      specifier: "./helpers",
      importedNames: ["helper"],
    });
  }

  // src/pages has only 3 files (below threshold, should not get own context)
  for (let i = 0; i < 3; i++) {
    edges.push({
      from: `src/pages/page${i}.ts`,
      to: `src/components/comp${i}.ts`,
      isExternal: false,
      specifier: `../components/comp${i}`,
      importedNames: ["Component"],
    });
  }

  // External imports (should be ignored for grouping)
  edges.push({
    from: "src/components/comp0.ts",
    to: "react",
    isExternal: true,
    specifier: "react",
    importedNames: ["useState"],
  });

  return edges;
}

function mockGraph(edges?: ImportEdge[]): ImportGraph {
  const graphEdges = edges ?? makeEdges();

  // Compute inDegree from edges
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  const allFiles = new Set<string>();
  for (const edge of graphEdges) {
    if (!edge.isExternal) {
      allFiles.add(edge.from);
      allFiles.add(edge.to);
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    }
  }

  // Set some mock centrality/authority scores
  for (const f of allFiles) {
    const inDeg = inDegree.get(f) ?? 0;
    const score = Math.min(inDeg / 10, 1);
    centrality.set(f, score);
    authority.set(f, score);
    hubScores.set(f, Math.max(0, 0.5 - score));
  }

  return {
    edges: graphEdges,
    inDegree,
    centrality,
    externalImportCounts: new Map([["react", 1]]),
    authority,
    hubScores,
  };
}

function mockAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    testMapping: {
      sourceToTests: new Map([
        ["src/components/comp0.ts", ["src/__tests__/comp0.test.ts"]],
      ]),
      untestedFiles: ["src/components/comp1.ts", "src/components/comp2.ts"],
    },
    ...overrides,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("shouldSplitContext", () => {
  it("returns true when sourceFileCount exceeds threshold", () => {
    const ctx = mockCtx({ sourceFileCount: 200 });
    expect(shouldSplitContext(ctx, 5000)).toBe(true);
  });

  it("returns true when estimatedTokens exceeds threshold", () => {
    const ctx = mockCtx({ sourceFileCount: 50 });
    expect(shouldSplitContext(ctx, 10000)).toBe(true);
  });

  it("returns false for small projects", () => {
    const ctx = mockCtx({ sourceFileCount: 20 });
    expect(shouldSplitContext(ctx, 3000)).toBe(false);
  });

  it("returns false for monorepo projects", () => {
    const ctx = mockCtx({
      sourceFileCount: 500,
      monorepo: {
        type: "pnpm-workspaces",
        packages: [{ name: "pkg-a", path: "packages/a", dependencies: [], frameworks: [] }],
      },
    });
    expect(shouldSplitContext(ctx, 20000)).toBe(false);
  });

  it("returns true at exactly threshold values", () => {
    // sourceFileCount > 150, not >=, so 150 is false, 151 is true
    expect(shouldSplitContext(mockCtx({ sourceFileCount: 150 }), 5000)).toBe(false);
    expect(shouldSplitContext(mockCtx({ sourceFileCount: 151 }), 5000)).toBe(true);

    // estimatedTokens > 8000, so 8000 is false, 8001 is true
    expect(shouldSplitContext(mockCtx({ sourceFileCount: 50 }), 8000)).toBe(false);
    expect(shouldSplitContext(mockCtx({ sourceFileCount: 50 }), 8001)).toBe(true);
  });
});

describe("computeDirectoryBudgets", () => {
  it("groups files by top-level directory", () => {
    const ctx = mockCtx();
    const graph = mockGraph();
    const analysis = mockAnalysis();

    const result = computeDirectoryBudgets(ctx, graph, analysis);

    // src/components should have 8+ files, src/services 7+, src/utils 6+
    expect(result.has("src/components")).toBe(true);
    expect(result.has("src/services")).toBe(true);
    expect(result.has("src/utils")).toBe(true);
  });

  it("excludes directories with fewer than 5 files", () => {
    const ctx = mockCtx();
    const graph = mockGraph();
    const analysis = mockAnalysis();

    const result = computeDirectoryBudgets(ctx, graph, analysis);

    // src/pages has only 3 files, should not be included
    expect(result.has("src/pages")).toBe(false);
  });

  it("returns empty map for projects with no qualifying directories", () => {
    const edges: ImportEdge[] = [
      {
        from: "a.ts",
        to: "b.ts",
        isExternal: false,
        specifier: "./b",
        importedNames: ["foo"],
      },
    ];
    const graph = mockGraph(edges);
    const result = computeDirectoryBudgets(mockCtx(), graph, mockAnalysis());
    expect(result.size).toBe(0);
  });
});

describe("buildDirectoryContext", () => {
  it("includes directory heading and description", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content).toContain("# components/");
    expect(content).toContain("Local context for `src/components/`");
  });

  it("includes local hub files table", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content).toContain("## Key Files");
    expect(content).toContain("| File | Imported By | Role |");
    // comp0 is imported by all others, should appear
    expect(content).toContain("comp0.ts");
  });

  it("includes dependency patterns", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content).toContain("## Dependencies");
    expect(content).toContain("**Imports from:**");
    expect(content).toContain("src/utils");
  });

  it("includes test coverage info when available", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content).toContain("## Test Coverage");
    expect(content).toContain("1 file with tests");
    expect(content).toContain("**Untested files:**");
  });

  it("includes related directories directive", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content).toContain("## Related");
    expect(content).toContain("When working in this directory, also check:");
  });

  it("ends with a single trailing newline", () => {
    const graph = mockGraph();
    const dirFiles = Array.from({ length: 8 }, (_, i) => `src/components/comp${i}.ts`);
    const content = buildDirectoryContext(
      "src/components",
      dirFiles,
      mockCtx(),
      graph,
      mockAnalysis(),
      mockAnswers(),
    );

    expect(content.endsWith("\n")).toBe(true);
    expect(content.endsWith("\n\n")).toBe(false);
  });
});

describe("buildTieredContext", () => {
  it("returns root file with directory links", () => {
    const ctx = mockCtx();
    const graph = mockGraph();
    const analysis = mockAnalysis();
    const answers = mockAnswers();
    const rootContent = "# test\n\n## What Is This\n\nTest project.\n";

    const tier = buildTieredContext(ctx, answers, null, analysis, graph, rootContent);

    expect(tier.root.content).toContain("## Directory Context");
    expect(tier.root.content).toContain(".clarte/context/");
  });

  it("generates per-directory context files", () => {
    const ctx = mockCtx();
    const graph = mockGraph();
    const analysis = mockAnalysis();
    const answers = mockAnswers();
    const rootContent = "# test\n";

    const tier = buildTieredContext(ctx, answers, null, analysis, graph, rootContent);

    expect(tier.directories.length).toBeGreaterThan(0);
    for (const f of tier.directories) {
      expect(f.path).toMatch(/^\.clarte\/context\/.+\.md$/);
      expect(f.content.length).toBeGreaterThan(0);
    }
  });

  it("uses hyphenated directory names for file paths", () => {
    const ctx = mockCtx();
    const graph = mockGraph();
    const analysis = mockAnalysis();
    const answers = mockAnswers();
    const rootContent = "# test\n";

    const tier = buildTieredContext(ctx, answers, null, analysis, graph, rootContent);

    const paths = tier.directories.map((f) => f.path);
    expect(paths).toContain(".clarte/context/src-components.md");
    expect(paths).toContain(".clarte/context/src-services.md");
    expect(paths).toContain(".clarte/context/src-utils.md");
  });

  it("does not include directory links when no directories qualify", () => {
    const edges: ImportEdge[] = [
      {
        from: "a.ts",
        to: "b.ts",
        isExternal: false,
        specifier: "./b",
        importedNames: ["foo"],
      },
    ];
    const graph = mockGraph(edges);
    const rootContent = "# test\n";

    const tier = buildTieredContext(
      mockCtx(),
      mockAnswers(),
      null,
      mockAnalysis(),
      graph,
      rootContent,
    );

    expect(tier.directories).toHaveLength(0);
    expect(tier.root.content).not.toContain("## Directory Context");
  });

  it("includes token budget info", () => {
    const tier = buildTieredContext(
      mockCtx(),
      mockAnswers(),
      null,
      mockAnalysis(),
      mockGraph(),
      "# test\n",
    );

    expect(tier.tokenBudget.root).toBeGreaterThan(0);
    expect(tier.tokenBudget.perDirectory).toBeGreaterThan(0);
  });
});
