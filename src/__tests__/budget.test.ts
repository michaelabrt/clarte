import { describe, expect, it } from "vitest";
import { buildMainContext, buildSections } from "../templates/main-context.js";
import { applyBudget, applyCharBudget } from "../templates/budget.js";
import { trimSnapshotToChars, renderSnapshot } from "../snapshot/snapshot.js";
import type {
  CodeSnapshot,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  ImportGraph,
  SnapshotEntry,
  UserAnswers,
} from "../types.js";

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
    circularDeps: [{ chain: ["a.ts", "b.ts", "a.ts"], breakHint: "Use type-only import" }],
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
      hotFiles: [
        { path: "src/index.ts", commits: 16, lastChanged: "2 hours ago" },
        { path: "src/types.ts", commits: 12, lastChanged: "6 hours ago" },
      ],
      changeCoupling: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 10, support: 0.5, confidence: 0.83 }],
    },
    instabilities: [],
    communities: [{ id: 0, files: ["src/types.ts"], label: "types" }],
    deadFiles: ["src/unused.ts"],
    crossCuttingFiles: [
      { file: "src/types.ts", totalImporters: 20, layerSpread: 3, layers: ["types", "utils", "graph"] },
    ],
    chokepoints: [{ file: "src/utils.ts", separates: 2, importedBy: 14, upstreamCount: 2, downstreamCount: 0 }],
    tightCouplings: [{ from: "src/index.ts", to: "src/types.ts", importedNames: 15, names: [] }],
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
    if (!techStack) throw new Error("expected tech-stack section");
    expect(techStack.priority).toBe(1);
  });

  it("includes working-guidelines at priority 1 when single IDE is claude", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null, mockAnalysis());
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    if (!guidelines) throw new Error("expected working-guidelines section");
    // Claude single-IDE boost: working-guidelines is boosted from 2 to 1
    expect(guidelines.priority).toBe(1);
  });

  it("includes working-guidelines at default priority 2 when multiple IDEs", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers({ ides: ["claude", "cursor"] }), null, mockAnalysis());
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    if (!guidelines) throw new Error("expected working-guidelines section");
    expect(guidelines.priority).toBe(2);
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

  it("default budget includes sections up to budget limit", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis());
    expect(result).toContain("## Tech Stack");
    // All sections now compete normally for budget (no full-only cutoff)
    // Low-priority sections may be omitted only if budget is exceeded
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
    // With a 500-token budget, some sections must be omitted
    expect(result).toContain("<!-- Sections omitted");
    expect(result).toMatch(/Sections omitted to fit token budget:/);
  });
});

// ── Character budget tests ─────────────────────────────────────────────────

function makeSection(id: string, priority: number, chars: number): ContextSection {
  const header = `## ${id}\n\n`;
  const body = "x".repeat(Math.max(0, chars - header.length));
  return { id, priority, content: header + body, tokens: Math.ceil(chars / 4) };
}

function makeSnapshotEntries(count: number): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      file: `src/file${i}.ts`,
      category: i < count / 2 ? "type" : "function",
      signature: `export ${i < count / 2 ? "interface" : "function"} Item${i} { field${i}: string; anotherField${i}: number; }`,
      importedByCount: count - i,
    });
  }
  return entries;
}

describe("applyCharBudget", () => {
  const comment = "\n<!-- clarte: generated test -->\n";

  it("includes all sections when under budget", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("tech-stack", 1, 200),
      makeSection("snapshot", 6, 300),
    ];

    const { included, dropped } = applyCharBudget(sections, 10000, comment);
    expect(included).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it("drops lowest-priority sections (highest number) first", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("tech-stack", 1, 200),
      makeSection("snapshot", 6, 300),
      makeSection("tight-coupling", 10, 300),
    ];

    // Budget tight enough to require dropping the P10 section
    const total = sections.reduce((s, sec) => s + sec.content.length, 0);
    const { included, dropped } = applyCharBudget(sections, total - 100, comment);
    expect(dropped).toContain("tight-coupling");
    expect(included.map((s) => s.id)).not.toContain("tight-coupling");
  });

  it("never drops P0-P2 sections", () => {
    const sections = [
      makeSection("header", 0, 5000),
      makeSection("guidelines", 2, 5000),
      makeSection("snapshot", 6, 100),
    ];

    const { included, dropped } = applyCharBudget(sections, 1000, comment);
    expect(included.find((s) => s.id === "header")).toBeDefined();
    expect(included.find((s) => s.id === "guidelines")).toBeDefined();
    expect(dropped).toContain("snapshot");
  });

  it("preserves original section order", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("snapshot", 6, 200),
      makeSection("tech-stack", 1, 100),
    ];

    const { included } = applyCharBudget(sections, 10000, comment);
    expect(included.map((s) => s.id)).toEqual(["header", "snapshot", "tech-stack"]);
  });
});

describe("trimSnapshotToChars", () => {
  it("returns full markdown when under budget", () => {
    const entries = makeSnapshotEntries(5);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, 100000);
    expect(trimmedCount).toBe(0);
    expect(markdown).toBe(fullMarkdown);
  });

  it("trims entries to fit within character budget", () => {
    const entries = makeSnapshotEntries(20);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const targetChars = Math.floor(fullMarkdown.length / 2);
    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, targetChars);

    expect(markdown.length).toBeLessThanOrEqual(targetChars);
    expect(trimmedCount).toBeGreaterThan(0);
    expect(trimmedCount).toBeLessThan(entries.length);
  });

  it("preserves highest-value entries (from the front)", () => {
    const entries = makeSnapshotEntries(10);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const targetChars = Math.floor(fullMarkdown.length / 3);
    const { markdown } = trimSnapshotToChars(snapshot, targetChars);

    // First entry should be present
    expect(markdown).toContain("Item0");
  });

  it("always keeps at least 1 entry", () => {
    const entries = makeSnapshotEntries(5);
    const snapshot: CodeSnapshot = {
      entries,
      markdown: renderSnapshot(entries, "typescript"),
    };

    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, 10);
    expect(trimmedCount).toBe(4);
    expect(markdown.length).toBeGreaterThan(0);
  });
});

describe("buildMainContext character budget integration", () => {
  it("maxChars=0 disables character budget", async () => {
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 0, undefined, 0);
    expect(result.length).toBeGreaterThan(0);
    // Should contain all sections with no char trimming
    expect(result).toContain("## Tech Stack");
    expect(result).toContain("## Dead Files");
  });

  it("tight maxChars drops P3+ sections but keeps P0-P2", async () => {
    // With analysis and --full (budget=0), all sections are included
    const fullResult = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 0, undefined, 0);
    // Now apply a tight char budget that's smaller than the full output
    // but still larger than P0-P2 mandatory sections
    const tightBudget = 2000;
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 0, undefined, tightBudget);
    // Should be shorter than unrestricted full output
    expect(result.length).toBeLessThan(fullResult.length);
    // Should still contain mandatory sections
    expect(result).toContain("## Tech Stack");
    // P3+ sections should be dropped
    expect(result).not.toContain("## Dead Files");
  });

  it("reservedChars reduces the effective character budget", async () => {
    const maxChars = 5000;
    const reservedChars = 500;

    const withoutReserved = await buildMainContext(
      mockCtx(),
      mockAnswers(),
      null,
      mockAnalysis(),
      0,
      undefined,
      maxChars,
      0,
    );
    const withReserved = await buildMainContext(
      mockCtx(),
      mockAnswers(),
      null,
      mockAnalysis(),
      0,
      undefined,
      maxChars,
      reservedChars,
    );
    // With reserved chars, the output should be equal or shorter
    expect(withReserved.length).toBeLessThanOrEqual(withoutReserved.length);
  });
});

describe("buildSections with graph parameter (betweenness pipeline)", () => {
  function graphWithBetweenness(): ImportGraph {
    return {
      edges: [],
      inDegree: new Map(),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
      betweennessScores: new Map([
        ["src/hot-path.ts", 0.75], // high betweenness, NOT a chokepoint
        ["src/utils.ts", 0.9], // high betweenness, IS a chokepoint (excluded)
        ["src/leaf.ts", 0.1], // low betweenness (excluded)
      ]),
    };
  }

  it("buildSections includes flow bottleneck directive when graph is passed", async () => {
    const graph = graphWithBetweenness();
    const sections = await buildSections(mockCtx(), mockAnswers(), null, mockAnalysis(), graph);
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    if (!guidelines) throw new Error("expected working-guidelines section");
    expect(guidelines.content).toContain("flow bottleneck");
    expect(guidelines.content).toContain("src/hot-path.ts");
  });

  it("buildSections excludes flow bottleneck when graph is not passed", async () => {
    const sections = await buildSections(mockCtx(), mockAnswers(), null, mockAnalysis());
    const guidelines = sections.find((s) => s.id === "working-guidelines");
    if (!guidelines) throw new Error("expected working-guidelines section");
    expect(guidelines.content).not.toContain("flow bottleneck");
  });

  it("buildMainContext renders flow bottleneck directive end-to-end", async () => {
    const graph = graphWithBetweenness();
    const result = await buildMainContext(mockCtx(), mockAnswers(), null, mockAnalysis(), 0, undefined, 0, 0, graph);
    expect(result).toContain("flow bottleneck");
    expect(result).toContain("src/hot-path.ts");
    // src/utils.ts is a chokepoint in mockAnalysis, should not appear as flow bottleneck
    expect(result).not.toMatch(/src\/utils\.ts.*flow bottleneck/);
  });
});
