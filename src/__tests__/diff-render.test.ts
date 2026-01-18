import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DiffRenderContext } from "../modes/diff-render.js";
import type { ContextAnalysis, DetectedContext, HubFile, ImportGraph, NeighborhoodResult } from "../types.js";

// Mock buildDirectives so renderScopedDirectives is testable in isolation
const mockBuildDirectives = vi.fn().mockReturnValue([]);
vi.mock("../templates/directives.js", () => ({
  buildDirectives: (...args: unknown[]) => mockBuildDirectives(...args),
}));

import { renderDiffContext } from "../modes/diff-render.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeGraph(files: string[] = []): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  for (const f of files) {
    inDegree.set(f, 0);
    centrality.set(f, 0);
  }
  return {
    edges: [],
    inDegree,
    directInDegree: new Map(),
    centrality,
    externalImportCounts: new Map(),
    authority: centrality,
    hubScores: new Map(),
  };
}

function makeNeighborhood(overrides?: Partial<NeighborhoodResult>): NeighborhoodResult {
  return {
    hop1: new Set(),
    hop2: new Set(),
    hop1Importers: new Set(),
    hop1Dependencies: new Set(),
    hop2Importers: new Set(),
    hop2Dependencies: new Set(),
    ...overrides,
  };
}

function makeAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    ...overrides,
  };
}

function makeDetected(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
    ...overrides,
  };
}

function makeCtx(overrides?: Partial<DiffRenderContext>): DiffRenderContext {
  return {
    changedFiles: ["src/foo.ts"],
    diffStat: null,
    hubFileMap: new Map(),
    graph: makeGraph(["src/foo.ts"]),
    neighborhood: makeNeighborhood(),
    testFiles: new Set(),
    entryIndex: new Map(),
    relevantCycles: [],
    gitActivity: null,
    detected: makeDetected(),
    analysis: makeAnalysis(),
    ...overrides,
  };
}

// ── renderSingleFileHeader ─────────────────────────────────────────────

describe("renderSingleFileHeader", () => {
  it("includes the changed file path and default Leaf role", () => {
    const out = renderDiffContext(makeCtx());
    expect(out).toContain("# Diff Context");
    expect(out).toContain("`src/foo.ts`");
    expect(out).toContain("Leaf");
    expect(out).toContain("imported by 0");
  });

  it("includes ref when provided", () => {
    const out = renderDiffContext(makeCtx({ ref: "main" }));
    expect(out).toContain("vs `main`");
  });

  it("excludes ref line when not provided", () => {
    const out = renderDiffContext(makeCtx());
    expect(out).not.toContain("vs `");
  });

  it("includes diffStat when provided", () => {
    const out = renderDiffContext(makeCtx({ diffStat: new Map([["src/foo.ts", { added: 10, removed: 5 }]]) }));
    expect(out).toContain("+10 / -5");
  });

  it("shows Risk annotation for Foundation hub file", () => {
    const hub: HubFile = {
      path: "src/foo.ts",
      role: "Foundation",
      importedBy: 42,
      authority: 0.9,
      hubScore: 0.1,
    };
    const out = renderDiffContext(
      makeCtx({
        hubFileMap: new Map([["src/foo.ts", hub]]),
        graph: makeGraph(["src/foo.ts"]),
      }),
    );
    out.split("\n").forEach((line) => {
      // just ensure output is valid string
    });
    expect(out).toContain("Foundation");
    expect(out).toContain("imported by 42");
    expect(out).toContain("**Risk:**");
  });

  it("shows Risk annotation for Orchestrator hub file", () => {
    const hub: HubFile = {
      path: "src/foo.ts",
      role: "Orchestrator",
      importedBy: 3,
      authority: 0.1,
      hubScore: 0.9,
    };
    const out = renderDiffContext(makeCtx({ hubFileMap: new Map([["src/foo.ts", hub]]) }));
    expect(out).toContain("Orchestrator");
    expect(out).toContain("**Risk:**");
  });

  it("does not show Risk annotation for Leaf files", () => {
    const out = renderDiffContext(makeCtx());
    expect(out).not.toContain("**Risk:**");
  });

  it("uses singular 'file' when importedBy is 1", () => {
    const hub: HubFile = {
      path: "src/foo.ts",
      role: "Foundation",
      importedBy: 1,
      authority: 0.9,
      hubScore: 0.1,
    };
    const out = renderDiffContext(makeCtx({ hubFileMap: new Map([["src/foo.ts", hub]]) }));
    expect(out).toContain("imported by 1 file.");
    expect(out).not.toContain("imported by 1 files.");
  });
});

// ── renderMultiFileHeader ──────────────────────────────────────────────

describe("renderMultiFileHeader", () => {
  it("shows changed file count and table without diffStat", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/a.ts", "src/b.ts"],
        graph: makeGraph(["src/a.ts", "src/b.ts"]),
      }),
    );
    expect(out).toContain("2 changed files");
    expect(out).toContain("| File | Role | Imported By |");
    expect(out).toContain("`src/a.ts`");
    expect(out).toContain("`src/b.ts`");
    expect(out).not.toContain("Lines (+/-)");
  });

  it("shows Lines column when diffStat is provided", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/a.ts", "src/b.ts"],
        graph: makeGraph(["src/a.ts", "src/b.ts"]),
        diffStat: new Map([
          ["src/a.ts", { added: 5, removed: 2 }],
          ["src/b.ts", { added: 3, removed: 1 }],
        ]),
      }),
    );
    expect(out).toContain("| File | Role | Imported By | Lines (+/-) |");
    expect(out).toContain("+5 / -2");
    expect(out).toContain("+3 / -1");
  });

  it("shows Risk Annotations section when hub files are changed", () => {
    const hub: HubFile = {
      path: "src/a.ts",
      role: "Foundation",
      importedBy: 10,
      authority: 0.9,
      hubScore: 0.1,
    };
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/a.ts", "src/b.ts"],
        hubFileMap: new Map([["src/a.ts", hub]]),
        graph: makeGraph(["src/a.ts", "src/b.ts"]),
      }),
    );
    expect(out).toContain("### Risk Annotations");
    expect(out).toContain("`src/a.ts`");
  });

  it("omits Risk Annotations when no hub files are changed", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/a.ts", "src/b.ts"],
        graph: makeGraph(["src/a.ts", "src/b.ts"]),
      }),
    );
    expect(out).not.toContain("### Risk Annotations");
  });
});

// ── renderTemporalCoupling ─────────────────────────────────────────────

describe("renderTemporalCoupling", () => {
  it("omits section when gitActivity is null", () => {
    const out = renderDiffContext(makeCtx({ gitActivity: null }));
    expect(out).not.toContain("### Temporal Coupling");
  });

  it("omits section when changeCoupling is empty", () => {
    const out = renderDiffContext(
      makeCtx({
        analysis: makeAnalysis({ gitActivity: { changeCoupling: [], hotFiles: [] } }),
        gitActivity: { changeCoupling: [], hotFiles: [] },
      }),
    );
    expect(out).not.toContain("### Temporal Coupling");
  });

  it("shows coupling partner when confidence meets threshold", () => {
    const out = renderDiffContext(
      makeCtx({
        gitActivity: {
          changeCoupling: [{ fileA: "src/foo.ts", fileB: "src/bar.ts", confidence: 0.7, coChangeCount: 5 }],
          hotFiles: [],
        },
      }),
    );
    expect(out).toContain("### Temporal Coupling");
    expect(out).toContain("`src/bar.ts`");
    expect(out).toContain("70% co-change");
  });

  it("omits partner when confidence is below threshold (0.5)", () => {
    const out = renderDiffContext(
      makeCtx({
        gitActivity: {
          changeCoupling: [{ fileA: "src/foo.ts", fileB: "src/bar.ts", confidence: 0.3, coChangeCount: 2 }],
          hotFiles: [],
        },
      }),
    );
    expect(out).not.toContain("### Temporal Coupling");
  });

  it("omits partner when partner is already in changedFiles", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/foo.ts", "src/bar.ts"],
        graph: makeGraph(["src/foo.ts", "src/bar.ts"]),
        gitActivity: {
          changeCoupling: [{ fileA: "src/foo.ts", fileB: "src/bar.ts", confidence: 0.9, coChangeCount: 10 }],
          hotFiles: [],
        },
      }),
    );
    expect(out).not.toContain("### Temporal Coupling");
  });
});

// ── renderCircularDeps ─────────────────────────────────────────────────

describe("renderCircularDeps", () => {
  it("omits section when no cycles", () => {
    const out = renderDiffContext(makeCtx({ relevantCycles: [] }));
    expect(out).not.toContain("### Circular Dependencies");
  });

  it("shows cycle with breakHint", () => {
    const out = renderDiffContext(
      makeCtx({
        relevantCycles: [{ chain: ["a.ts", "b.ts", "a.ts"], breakHint: "Make the import type-only" }],
      }),
    );
    expect(out).toContain("### Circular Dependencies");
    expect(out).toContain("Make the import type-only");
  });

  it("shows default message when no breakHint", () => {
    const out = renderDiffContext(
      makeCtx({
        relevantCycles: [{ chain: ["a.ts", "b.ts", "a.ts"] }],
      }),
    );
    expect(out).toContain("### Circular Dependencies");
    expect(out).toContain("Consider breaking this circular dependency");
  });
});

// ── renderNeighbors ────────────────────────────────────────────────────

describe("renderNeighbors", () => {
  it("omits section when neighborhood is empty", () => {
    const out = renderDiffContext(makeCtx());
    expect(out).not.toContain("## Neighbors");
  });

  it("shows Dependents section for hop1 importers", () => {
    const out = renderDiffContext(
      makeCtx({
        neighborhood: makeNeighborhood({
          hop1: new Set(["src/consumer.ts"]),
          hop1Importers: new Set(["src/consumer.ts"]),
        }),
        graph: makeGraph(["src/foo.ts", "src/consumer.ts"]),
      }),
    );
    expect(out).toContain("## Neighbors");
    expect(out).toContain("### Dependents (import changed files)");
    expect(out).toContain("`src/consumer.ts`");
  });

  it("shows Dependencies section for hop1 dependencies", () => {
    const out = renderDiffContext(
      makeCtx({
        neighborhood: makeNeighborhood({
          hop1: new Set(["src/lib.ts"]),
          hop1Dependencies: new Set(["src/lib.ts"]),
        }),
        graph: makeGraph(["src/foo.ts", "src/lib.ts"]),
      }),
    );
    expect(out).toContain("### Dependencies (imported by changed files)");
    expect(out).toContain("`src/lib.ts`");
  });

  it("shows Indirect section for hop2 and caps at 15", () => {
    const hop2Files = Array.from({ length: 20 }, (_, i) => `src/dep${i}.ts`);
    const out = renderDiffContext(
      makeCtx({
        neighborhood: makeNeighborhood({
          hop2: new Set(hop2Files),
          hop2Dependencies: new Set(hop2Files),
        }),
        graph: makeGraph(["src/foo.ts", ...hop2Files]),
      }),
    );
    expect(out).toContain("### Indirect (2-hop)");
    // Verify only 15 file entries appear (cap)
    const tableRows = out.split("\n").filter((line) => line.startsWith("| `src/dep"));
    expect(tableRows.length).toBe(15);
  });
});

// ── renderRelatedTests ─────────────────────────────────────────────────

describe("renderRelatedTests", () => {
  it("omits section when no test files", () => {
    const out = renderDiffContext(makeCtx({ testFiles: new Set() }));
    expect(out).not.toContain("## Related Tests");
  });

  it("shows test files sorted alphabetically", () => {
    const out = renderDiffContext(
      makeCtx({
        testFiles: new Set(["src/__tests__/z.test.ts", "src/__tests__/a.test.ts"]),
      }),
    );
    expect(out).toContain("## Related Tests");
    expect(out).toContain("> Run these tests after your changes.");
    const lines = out.split("\n");
    const aIdx = lines.findIndex((l) => l.includes("a.test.ts"));
    const zIdx = lines.findIndex((l) => l.includes("z.test.ts"));
    expect(aIdx).toBeLessThan(zIdx);
  });
});

// ── renderSignatures ───────────────────────────────────────────────────

describe("renderSignatures", () => {
  it("omits section when no entries in index", () => {
    const out = renderDiffContext(makeCtx({ entryIndex: new Map() }));
    expect(out).not.toContain("## Signatures in Scope");
  });

  it("shows signatures with TypeScript fence for ts language", () => {
    const out = renderDiffContext(
      makeCtx({
        entryIndex: new Map([["src/foo.ts", [{ signature: "export function foo(): void", kind: "function" }]]]),
        detected: makeDetected({ language: "typescript" }),
      }),
    );
    expect(out).toContain("## Signatures in Scope");
    expect(out).toContain("```ts");
    expect(out).toContain("// src/foo.ts");
    expect(out).toContain("export function foo(): void");
  });

  it("uses Python fence for python language", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["app/foo.py"],
        graph: makeGraph(["app/foo.py"]),
        entryIndex: new Map([["app/foo.py", [{ signature: "def foo() -> None:", kind: "function" }]]]),
        detected: makeDetected({ language: "python" }),
      }),
    );
    expect(out).toContain("```py");
  });

  it("uses raw language name as fence fallback for unknown languages", () => {
    const out = renderDiffContext(
      makeCtx({
        entryIndex: new Map([["src/foo.ts", [{ signature: "fn foo()", kind: "function" }]]]),
        detected: makeDetected({ language: "haskell" as "typescript" }),
      }),
    );
    expect(out).toContain("```haskell");
    expect(out).not.toContain("```ts");
  });

  it("uses 'rb' fence for ruby language", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["app/foo.rb"],
        graph: makeGraph(["app/foo.rb"]),
        entryIndex: new Map([["app/foo.rb", [{ signature: "def foo", kind: "function" }]]]),
        detected: makeDetected({ language: "ruby" as "typescript" }),
      }),
    );
    expect(out).toContain("```rb");
  });

  it("uses 'kt' fence for kotlin language", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["app/Foo.kt"],
        graph: makeGraph(["app/Foo.kt"]),
        entryIndex: new Map([["app/Foo.kt", [{ signature: "fun foo()", kind: "function" }]]]),
        detected: makeDetected({ language: "kotlin" as "typescript" }),
      }),
    );
    expect(out).toContain("```kt");
  });

  it("caps at 20 files and 5 entries per file", () => {
    // Create 25 files each with 8 entries
    const files = Array.from({ length: 25 }, (_, i) => `src/f${i}.ts`);
    const graph = makeGraph(files);
    // Set centrality so files are sorted consistently
    for (const f of files) graph.centrality.set(f, 0);
    const entryIndex = new Map(
      files.map((f) => [
        f,
        Array.from({ length: 8 }, (_, j) => ({ signature: `// sig ${j}`, kind: "function" as const })),
      ]),
    );
    const out = renderDiffContext(
      makeCtx({
        changedFiles: files,
        graph,
        entryIndex,
      }),
    );
    // Count file comments (// src/fN.ts)
    const fileComments = out.split("\n").filter((l) => l.startsWith("// src/f"));
    expect(fileComments.length).toBeLessThanOrEqual(20);
    // Each file should have at most 5 signature lines
    // Count "// sig N" lines (signature content lines)
    const sigLines = out.split("\n").filter((l) => l.startsWith("// sig "));
    expect(sigLines.length).toBeLessThanOrEqual(100); // 20 files * 5 entries
  });
});

// ── renderScopedDirectives ─────────────────────────────────────────────

describe("renderScopedDirectives", () => {
  beforeEach(() => {
    mockBuildDirectives.mockReset().mockReturnValue([]);
  });

  it("omits section when no directives match changed files", () => {
    mockBuildDirectives.mockReturnValue(["When modifying src/other.ts, check foo"]);
    const out = renderDiffContext(makeCtx());
    expect(out).not.toContain("## Working Guidelines");
  });

  it("shows section when a directive mentions the changed file", () => {
    mockBuildDirectives.mockReturnValue(["When modifying src/foo.ts, check dependents"]);
    const out = renderDiffContext(makeCtx());
    expect(out).toContain("## Working Guidelines");
    expect(out).toContain("> Scoped directives for changed files.");
    expect(out).toContain("When modifying src/foo.ts, check dependents");
  });
});

// ── Isolated file edge case ────────────────────────────────────────────

describe("isolated file", () => {
  it("shows isolation message when file is not in graph with empty neighborhood", () => {
    const out = renderDiffContext(
      makeCtx({
        changedFiles: ["src/isolated.ts"],
        graph: makeGraph([]),
        neighborhood: makeNeighborhood(),
        testFiles: new Set(),
        entryIndex: new Map(),
      }),
    );
    expect(out).toContain("not in the import graph");
  });
});
