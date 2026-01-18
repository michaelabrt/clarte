import { describe, it, expect } from "vitest";
import type { ContextAnalysis } from "../types.js";
import { renderDependencySections } from "../templates/sections/dependencies.js";

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

// ── Circular Dependencies ──────────────────────────────────────────────

describe("renderDependencySections: circular-deps", () => {
  it("emits no section when circularDeps is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ circularDeps: [] }));
    expect(sections.find((s) => s.id === "circular-deps")).toBeUndefined();
  });

  it("shows (type-only) annotation for severity=0", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 0)] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).toContain("(type-only)");
  });

  it("shows (mixed) annotation for severity between 0 and 1", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 0.5)] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).toContain("(mixed)");
  });

  it("shows no severity annotation for severity=1", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], 1)] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).not.toContain("(type-only)");
    expect(section!.content).not.toContain("(mixed)");
  });

  it("shows no severity annotation when severity is undefined", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).not.toContain("(type-only)");
    expect(section!.content).not.toContain("(mixed)");
  });

  it("shows breakHint when provided", () => {
    const analysis = makeAnalysis({
      circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"], undefined, "Make import type-only")],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).toContain("Make import type-only");
    expect(section!.content).toContain(" -- ");
  });

  it("omits hint when breakHint is absent", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).not.toContain(" -- ");
  });

  it("includes all cycle file paths in chain order", () => {
    const analysis = makeAnalysis({
      circularDeps: [makeCycle(["src/a.ts", "src/b.ts", "src/c.ts", "src/a.ts"])],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).toContain("`src/a.ts` -> `src/b.ts` -> `src/c.ts` -> `src/a.ts`");
  });

  it("shows feedback edges when there are multiple cycles sharing an edge", () => {
    // a->b edge participates in all 3 cycles
    const cycles = [
      makeCycle(["a.ts", "b.ts", "a.ts"]),
      makeCycle(["a.ts", "b.ts", "c.ts", "a.ts"]),
      makeCycle(["a.ts", "b.ts", "d.ts", "a.ts"]),
    ];
    const analysis = makeAnalysis({ circularDeps: cycles });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).toContain("Most impactful edges to break:");
    expect(section!.content).toContain("would resolve");
    expect(section!.content).toContain("of 3 cycles");
  });

  it("omits feedback edges section when there is only 1 cycle", () => {
    const analysis = makeAnalysis({ circularDeps: [makeCycle(["a.ts", "b.ts", "a.ts"])] });
    const section = renderDependencySections(analysis).find((s) => s.id === "circular-deps");
    expect(section!.content).not.toContain("Most impactful edges to break:");
  });
});

// ── Dead Files ─────────────────────────────────────────────────────────

describe("renderDependencySections: dead-files", () => {
  it("emits no section when deadFiles is absent", () => {
    const sections = renderDependencySections(makeAnalysis());
    expect(sections.find((s) => s.id === "dead-files")).toBeUndefined();
  });

  it("emits no section when deadFiles is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ deadFiles: [] }));
    expect(sections.find((s) => s.id === "dead-files")).toBeUndefined();
  });

  it("lists all files when count <= 15", () => {
    const files = Array.from({ length: 5 }, (_, i) => `src/dead${i}.ts`);
    const analysis = makeAnalysis({ deadFiles: files });
    const section = renderDependencySections(analysis).find((s) => s.id === "dead-files");
    expect(section).toBeDefined();
    for (const f of files) {
      expect(section!.content).toContain(`\`${f}\``);
    }
  });

  it("caps at 15 and shows overflow count for larger sets", () => {
    const files = Array.from({ length: 20 }, (_, i) => `src/dead${i}.ts`);
    const analysis = makeAnalysis({ deadFiles: files });
    const section = renderDependencySections(analysis).find((s) => s.id === "dead-files");
    expect(section!.content).toContain("and 5 more");
    // Only first 15 should appear
    expect(section!.content).toContain("`src/dead14.ts`");
    expect(section!.content).not.toContain("`src/dead15.ts`");
  });
});

// ── Cross-Cutting Files ────────────────────────────────────────────────

describe("renderDependencySections: cross-cutting", () => {
  it("emits no section when crossCuttingFiles is absent", () => {
    const sections = renderDependencySections(makeAnalysis());
    expect(sections.find((s) => s.id === "cross-cutting")).toBeUndefined();
  });

  it("emits no section when crossCuttingFiles is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ crossCuttingFiles: [] }));
    expect(sections.find((s) => s.id === "cross-cutting")).toBeUndefined();
  });

  it("renders table with File, Imported By and Layers columns", () => {
    const analysis = makeAnalysis({
      crossCuttingFiles: [
        { file: "src/types.ts", totalImporters: 10, layerSpread: 3, layers: ["types", "utils", "services"] },
      ],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "cross-cutting");
    expect(section!.content).toContain("| File | Imported By | Layers |");
    expect(section!.content).toContain("`src/types.ts`");
    expect(section!.content).toContain("types, utils, services");
  });

  it("uses singular 'file' when totalImporters is 1", () => {
    const analysis = makeAnalysis({
      crossCuttingFiles: [{ file: "src/x.ts", totalImporters: 1, layerSpread: 2, layers: ["a", "b"] }],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "cross-cutting");
    expect(section!.content).toContain("1 file");
    expect(section!.content).not.toContain("1 files");
  });
});

// ── Chokepoints ────────────────────────────────────────────────────────

describe("renderDependencySections: chokepoints", () => {
  it("emits no section when chokepoints is absent", () => {
    const sections = renderDependencySections(makeAnalysis());
    expect(sections.find((s) => s.id === "chokepoints")).toBeUndefined();
  });

  it("emits no section when chokepoints is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ chokepoints: [] }));
    expect(sections.find((s) => s.id === "chokepoints")).toBeUndefined();
  });

  it("shows correct upstream and downstream counts", () => {
    const analysis = makeAnalysis({
      chokepoints: [makeChokepoint("src/core.ts", 15, 120, 8)],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "chokepoints");
    expect(section!.content).toContain("`src/core.ts`");
    expect(section!.content).toContain("120 files");
    expect(section!.content).toContain("8 files");
  });

  it("caps at 5 and shows overflow count", () => {
    const cps = Array.from({ length: 8 }, (_, i) => makeChokepoint(`cp${i}.ts`, i + 1, 100 - i, 10));
    const analysis = makeAnalysis({ chokepoints: cps });
    const section = renderDependencySections(analysis).find((s) => s.id === "chokepoints");
    expect(section!.content).toContain("and 3 more");
    expect(section!.content).toContain("`cp4.ts`");
    expect(section!.content).not.toContain("`cp5.ts`");
  });
});

// ── Tight Coupling ─────────────────────────────────────────────────────

describe("renderDependencySections: tight-coupling", () => {
  it("emits no section when tightCouplings is absent", () => {
    const sections = renderDependencySections(makeAnalysis());
    expect(sections.find((s) => s.id === "tight-coupling")).toBeUndefined();
  });

  it("emits no section when tightCouplings is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ tightCouplings: [] }));
    expect(sections.find((s) => s.id === "tight-coupling")).toBeUndefined();
  });

  it("shows type-only annotation when typeOnlyCount > 0", () => {
    const analysis = makeAnalysis({
      tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [], typeOnlyCount: 5 }],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "tight-coupling");
    expect(section!.content).toContain("(5 type-only)");
  });

  it("omits type-only annotation when typeOnlyCount is 0", () => {
    const analysis = makeAnalysis({
      tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [], typeOnlyCount: 0 }],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "tight-coupling");
    expect(section!.content).not.toContain("type-only");
  });

  it("omits type-only annotation when typeOnlyCount is absent", () => {
    const analysis = makeAnalysis({
      tightCouplings: [{ from: "a.ts", to: "b.ts", importedNames: 10, names: [] }],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "tight-coupling");
    expect(section!.content).not.toContain("type-only");
  });

  it("shows from/to file paths and import count", () => {
    const analysis = makeAnalysis({
      tightCouplings: [{ from: "src/a.ts", to: "src/b.ts", importedNames: 12, names: [] }],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "tight-coupling");
    expect(section!.content).toContain("`src/a.ts`");
    expect(section!.content).toContain("`src/b.ts`");
    expect(section!.content).toContain("12 names");
  });
});

// ── Hidden Coupling ────────────────────────────────────────────────────

describe("renderDependencySections: hidden-coupling", () => {
  it("emits no section when structuralMismatches is absent", () => {
    const sections = renderDependencySections(makeAnalysis());
    expect(sections.find((s) => s.id === "hidden-coupling")).toBeUndefined();
  });

  it("emits no section when structuralMismatches is empty", () => {
    const sections = renderDependencySections(makeAnalysis({ structuralMismatches: [] }));
    expect(sections.find((s) => s.id === "hidden-coupling")).toBeUndefined();
  });

  it("shows 'unreachable' for graphDistance=-1", () => {
    const analysis = makeAnalysis({
      structuralMismatches: [
        { fileA: "a.ts", fileB: "b.ts", graphDistance: -1, coChangeConfidence: 0.7, coChangeCount: 10 },
      ],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "hidden-coupling");
    expect(section!.content).toContain("unreachable");
  });

  it("shows '3 hops' for graphDistance=3", () => {
    const analysis = makeAnalysis({
      structuralMismatches: [
        { fileA: "a.ts", fileB: "b.ts", graphDistance: 3, coChangeConfidence: 0.7, coChangeCount: 10 },
      ],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "hidden-coupling");
    expect(section!.content).toContain("3 hops");
  });

  it("shows confidence as percentage", () => {
    const analysis = makeAnalysis({
      structuralMismatches: [
        { fileA: "a.ts", fileB: "b.ts", graphDistance: -1, coChangeConfidence: 0.73, coChangeCount: 15 },
      ],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "hidden-coupling");
    expect(section!.content).toContain("73%");
  });

  it("renders table with file paths and co-change count", () => {
    const analysis = makeAnalysis({
      structuralMismatches: [
        { fileA: "src/a.ts", fileB: "src/b.ts", graphDistance: -1, coChangeConfidence: 0.5, coChangeCount: 8 },
      ],
    });
    const section = renderDependencySections(analysis).find((s) => s.id === "hidden-coupling");
    expect(section!.content).toContain("| File A | File B |");
    expect(section!.content).toContain("`src/a.ts`");
    expect(section!.content).toContain("`src/b.ts`");
    expect(section!.content).toContain("| 8 |");
  });
});
