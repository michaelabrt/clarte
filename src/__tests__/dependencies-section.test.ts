import { describe, it, expect } from "vitest";
import type { ContextAnalysis } from "../types.js";
import {
  renderDependencySections,
  renderCircularDepsContent,
  renderDeadFilesContent,
  renderCrossCuttingContent,
  renderChokepointsContent,
  renderTightCouplingContent,
  renderHiddenCouplingContent,
} from "../templates/sections/dependencies.js";

// ── Fixtures ──────────────────────────────────────────────────────────

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

function makeCycle(chain: string[], severity?: number, breakHint?: string) {
  return { chain, severity, breakHint };
}

function makeChokepoint(file: string, importedBy: number, upstreamCount: number, downstreamCount: number) {
  return { file, importedBy, upstreamCount, downstreamCount };
}

// ── renderDependencySections (always empty, R5 ablation) ───────────────

describe("renderDependencySections", () => {
  it("always returns empty array (R5 ablation: all dep sections disabled)", () => {
    const analysis = makeAnalysis({
      circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])],
      deadFiles: ["src/unused.ts"],
      crossCuttingFiles: [{ file: "src/types.ts", totalImporters: 5, layerSpread: 2, layers: ["a", "b"] }],
      chokepoints: [makeChokepoint("src/core.ts", 10, 50, 5)],
      tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 8, names: [] }],
      structuralMismatches: [
        { fileA: "a.ts", fileB: "b.ts", graphDistance: -1, coChangeConfidence: 0.7, coChangeCount: 5 },
      ],
    });
    expect(renderDependencySections(analysis)).toHaveLength(0);
  });
});

// ── Circular Dependencies ──────────────────────────────────────────────

describe("renderCircularDepsContent", () => {
  it("returns null when circularDeps is empty", () => {
    expect(renderCircularDepsContent(makeAnalysis({ circularDeps: [] }))).toBeNull();
  });

  it("shows (type-only) annotation for severity=0", () => {
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 0)] }));
    expect(content).toContain("(type-only)");
  });

  it("shows (mixed) annotation for severity between 0 and 1", () => {
    const content = renderCircularDepsContent(
      makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 0.5)] }),
    );
    expect(content).toContain("(mixed)");
  });

  it("shows no severity annotation for severity=1", () => {
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 1)] }));
    expect(content).not.toContain("(type-only)");
    expect(content).not.toContain("(mixed)");
  });

  it("shows no severity annotation when severity is undefined", () => {
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] }));
    expect(content).not.toContain("(type-only)");
    expect(content).not.toContain("(mixed)");
  });

  it("shows breakHint when provided", () => {
    const content = renderCircularDepsContent(
      makeAnalysis({
        circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], undefined, "Make import type-only")],
      }),
    );
    expect(content).toContain("Make import type-only");
    expect(content).toContain(" -- ");
  });

  it("omits hint when breakHint is absent", () => {
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] }));
    expect(content).not.toContain(" -- ");
  });

  it("includes all cycle file paths in chain order", () => {
    const content = renderCircularDepsContent(
      makeAnalysis({
        circularDeps: [makeCycle(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"])],
      }),
    );
    expect(content).toContain("`src/a.ts` -> `src/b.ts` -> `src/c.ts` -> `src/a.ts`");
  });

  it("shows feedback edges when there are multiple cycles sharing an edge", () => {
    // a->b edge participates in all 3 cycles
    const cycles = [
      makeCycle(["a.ts", "b.ts", "a.ts"]),
      makeCycle(["a.ts", "b.ts", "c.ts", "a.ts"]),
      makeCycle(["a.ts", "b.ts", "d.ts", "a.ts"]),
    ];
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: cycles }));
    expect(content).toContain("Most impactful edges to break:");
    expect(content).toContain("would resolve");
    expect(content).toContain("of 3 cycles");
  });

  it("omits feedback edges section when there is only 1 cycle", () => {
    const content = renderCircularDepsContent(makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] }));
    expect(content).not.toContain("Most impactful edges to break:");
  });
});

// ── Dead Files ─────────────────────────────────────────────────────────

describe("renderDeadFilesContent", () => {
  it("returns null when deadFiles is absent", () => {
    expect(renderDeadFilesContent(makeAnalysis())).toBeNull();
  });

  it("returns null when deadFiles is empty", () => {
    expect(renderDeadFilesContent(makeAnalysis({ deadFiles: [] }))).toBeNull();
  });

  it("lists all files when count <= 15", () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/dead${i}.ts`);
    const content = renderDeadFilesContent(makeAnalysis({ deadFiles: files }));
    expect(content).not.toBeNull();
    for (const f of files) {
      expect(content).toContain(`\`${f}\``);
    }
  });

  it("caps at 15 and shows overflow count for larger sets", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/dead${i}.ts`);
    const content = renderDeadFilesContent(makeAnalysis({ deadFiles: files }));
    expect(content).toContain("and 5 more");
    // Only first 15 should appear
    expect(content).toContain("`src/dead14.ts`");
    expect(content).not.toContain("`src/dead15.ts`");
  });
});

// ── Cross-Cutting Files ────────────────────────────────────────────────

describe("renderCrossCuttingContent", () => {
  it("returns null when crossCuttingFiles is absent", () => {
    expect(renderCrossCuttingContent(makeAnalysis())).toBeNull();
  });

  it("returns null when crossCuttingFiles is empty", () => {
    expect(renderCrossCuttingContent(makeAnalysis({ crossCuttingFiles: [] }))).toBeNull();
  });

  it("renders table with File, Imported By and Layers columns", () => {
    const content = renderCrossCuttingContent(
      makeAnalysis({
        crossCuttingFiles: [
          { file: "src/types.ts", totalImporters: 10, layerSpread: 3, layers: ["types", "utils", "services"] },
        ],
      }),
    );
    expect(content).toContain("| File | Imported By | Layers |");
    expect(content).toContain("`src/types.ts`");
    expect(content).toContain("types, utils, services");
  });

  it("uses singular 'file' when totalImporters is 1", () => {
    const content = renderCrossCuttingContent(
      makeAnalysis({
        crossCuttingFiles: [{ file: "src/x.ts", totalImporters: 1, layerSpread: 2, layers: ["a", "b"] }],
      }),
    );
    expect(content).toContain("1 file");
    expect(content).not.toContain("1 files");
  });
});

// ── Chokepoints ────────────────────────────────────────────────────────

describe("renderChokepointsContent", () => {
  it("returns null when chokepoints is absent", () => {
    expect(renderChokepointsContent(makeAnalysis())).toBeNull();
  });

  it("returns null when chokepoints is empty", () => {
    expect(renderChokepointsContent(makeAnalysis({ chokepoints: [] }))).toBeNull();
  });

  it("shows correct upstream and downstream counts", () => {
    const content = renderChokepointsContent(
      makeAnalysis({
        chokepoints: [makeChokepoint("src/core.ts", 15, 120, 8)],
      }),
    );
    expect(content).toContain("`src/core.ts`");
    expect(content).toContain("120 files");
    expect(content).toContain("8 files");
  });

  it("caps at 5 and shows overflow count", () => {
    const cps = Array.from({ length: 8 }, (_, i) => makeChokepoint(`cp${i}.ts`, i + 1, 100 - i, 10));
    const content = renderChokepointsContent(makeAnalysis({ chokepoints: cps }));
    expect(content).toContain("and 3 more");
    expect(content).toContain("`cp4.ts`");
    expect(content).not.toContain("`cp5.ts`");
  });
});

// ── Tight Coupling ─────────────────────────────────────────────────────

describe("renderTightCouplingContent", () => {
  it("returns null when tightCouplings is absent", () => {
    expect(renderTightCouplingContent(makeAnalysis())).toBeNull();
  });

  it("returns null when tightCouplings is empty", () => {
    expect(renderTightCouplingContent(makeAnalysis({ tightCouplings: [] }))).toBeNull();
  });

  it("shows type-only annotation when typeOnlyCount > 0", () => {
    const content = renderTightCouplingContent(
      makeAnalysis({
        tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [], typeOnlyCount: 5 }],
      }),
    );
    expect(content).toContain("(5 type-only)");
  });

  it("omits type-only annotation when typeOnlyCount is 0", () => {
    const content = renderTightCouplingContent(
      makeAnalysis({
        tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [], typeOnlyCount: 0 }],
      }),
    );
    expect(content).not.toContain("type-only");
  });

  it("omits type-only annotation when typeOnlyCount is absent", () => {
    const content = renderTightCouplingContent(
      makeAnalysis({
        tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [] }],
      }),
    );
    expect(content).not.toContain("type-only");
  });

  it("shows from/to file paths and import count", () => {
    const content = renderTightCouplingContent(
      makeAnalysis({
        tightCouplings: [{ from: "src/a.ts", to: "src/b.ts", importedNames: 12, names: [] }],
      }),
    );
    expect(content).toContain("`src/a.ts`");
    expect(content).toContain("`src/b.ts`");
    expect(content).toContain("12 names");
  });
});

// ── Hidden Coupling ────────────────────────────────────────────────────

describe("renderHiddenCouplingContent", () => {
  it("returns null when structuralMismatches is absent", () => {
    expect(renderHiddenCouplingContent(makeAnalysis())).toBeNull();
  });

  it("returns null when structuralMismatches is empty", () => {
    expect(renderHiddenCouplingContent(makeAnalysis({ structuralMismatches: [] }))).toBeNull();
  });

  it("shows 'unreachable' for graphDistance=-1", () => {
    const content = renderHiddenCouplingContent(
      makeAnalysis({
        structuralMismatches: [
          { fileA: "a.ts", fileB: "b.ts", graphDistance: -1, coChangeConfidence: 0.7, coChangeCount: 10 },
        ],
      }),
    );
    expect(content).toContain("unreachable");
  });

  it("shows '3 hops' for graphDistance=3", () => {
    const content = renderHiddenCouplingContent(
      makeAnalysis({
        structuralMismatches: [
          { fileA: "a.ts", fileB: "b.ts", graphDistance: 3, coChangeConfidence: 0.7, coChangeCount: 10 },
        ],
      }),
    );
    expect(content).toContain("3 hops");
  });

  it("shows confidence as percentage", () => {
    const content = renderHiddenCouplingContent(
      makeAnalysis({
        structuralMismatches: [
          { fileA: "a.ts", fileB: "b.ts", graphDistance: -1, coChangeConfidence: 0.73, coChangeCount: 15 },
        ],
      }),
    );
    expect(content).toContain("73%");
  });

  it("renders table with file paths and co-change count", () => {
    const content = renderHiddenCouplingContent(
      makeAnalysis({
        structuralMismatches: [
          { fileA: "src/a.ts", fileB: "src/b.ts", graphDistance: -1, coChangeConfidence: 0.5, coChangeCount: 8 },
        ],
      }),
    );
    expect(content).toContain("| File A | File B |");
    expect(content).toContain("`src/a.ts`");
    expect(content).toContain("`src/b.ts`");
    expect(content).toContain("| 8 |");
  });
});
