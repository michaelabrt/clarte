import { describe, it, expect, vi } from "vitest";
import type { ContextAnalysis } from "../types.js";
import type { HubFile } from "../types/graph.js";

// Mock async and impure dependencies
vi.mock("../templates/directives.js", () => ({
  renderDirectivesSection: vi.fn().mockResolvedValue(null),
}));

vi.mock("../config/scan.js", () => ({
  renderConstraintsSection: vi.fn().mockReturnValue(null),
}));

import { renderArchitectureSections, renderLayerConsistencySection } from "../templates/sections/architecture.js";

// ── Fixtures ──────────────────────────────────────────────────────────

type SimpleEdge = { from: string; to: string };

function makeGraph(edges: SimpleEdge[] = []) {
  const inDegree = new Map<string, number>();
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    if (!inDegree.has(e.from)) inDegree.set(e.from, 0);
  }
  return {
    edges: edges.map((e) => ({ from: e.from, to: e.to, isExternal: false, specifier: e.to, importedNames: [] })),
    inDegree,
    centrality: new Map<string, number>(),
    externalImportCounts: new Map<string, number>(),
    authority: new Map<string, number>(),
    hubScores: new Map<string, number>(),
  };
}

function makeHubFile(path: string, overrides?: Partial<HubFile>): HubFile {
  return {
    path,
    centrality: 0.5,
    authority: 0.5,
    hubScore: 0.5,
    role: "Foundation",
    importedBy: 5,
    imports: 2,
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

function makeLayer(name: string) {
  return { name, files: [], importedByLayers: 0, dependsOn: [] };
}

const DETECTED = {
  rootDir: "/test",
  language: "typescript" as const,
  hasTypeScript: true,
  packageManager: "npm" as const,
  linter: "eslint" as const,
  frameworks: [],
  directories: ["src"],
  dependencies: [],
  isGitRepo: false,
  totalSourceBytes: 0,
  sourceFileCount: 0,
  monorepo: null,
};

// ── key-files section ──────────────────────────────────────────────────

describe("renderArchitectureSections: key-files", () => {
  it("emits no key-files section when hubFiles is empty", async () => {
    const sections = await renderArchitectureSections(makeAnalysis(), DETECTED);
    expect(sections.find((s) => s.id === "key-files")).toBeUndefined();
  });

  it("shows 'stable' when no instability entry for hub file", async () => {
    const analysis = makeAnalysis({ hubFiles: [makeHubFile("src/utils.ts")], instabilities: [] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("stable");
    expect(kf.content).not.toContain("SDP");
  });

  it("shows I% when instability exists but no stable file imports it (no SDP violation)", async () => {
    // hub.ts is unstable (I=0.8), but only consumer.ts (I=1.0, also unstable) imports it
    const analysis = makeAnalysis({
      hubFiles: [makeHubFile("hub.ts")],
      instabilities: [{ path: "hub.ts", fanIn: 1, fanOut: 4, instability: 0.8 }],
    });
    const graph = makeGraph([
      // consumer.ts has no fanIn → I=1.0 (fully unstable), imports hub.ts
      { from: "consumer.ts", to: "hub.ts" },
      // hub.ts imports 4 deps (high fanOut)
      { from: "hub.ts", to: "d1.ts" },
      { from: "hub.ts", to: "d2.ts" },
      { from: "hub.ts", to: "d3.ts" },
      { from: "hub.ts", to: "d4.ts" },
    ]);
    const sections = await renderArchitectureSections(analysis, DETECTED, graph);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("I=80%");
    expect(kf.content).not.toContain("SDP");
  });

  it("shows SDP warning when stable file imports unstable hub", async () => {
    // base.ts: fanIn=4, fanOut=1 → I=0.2 (stable)
    // hub.ts:  fanIn=1, fanOut=4 → I=0.8 (unstable)
    // Edge: base.ts -> hub.ts: importerI=0.2 < importedI=0.8 → SDP violation on hub.ts
    const analysis = makeAnalysis({
      hubFiles: [makeHubFile("hub.ts")],
      instabilities: [{ path: "hub.ts", fanIn: 1, fanOut: 4, instability: 0.8 }],
    });
    const graph = makeGraph([
      { from: "c1.ts", to: "base.ts" },
      { from: "c2.ts", to: "base.ts" },
      { from: "c3.ts", to: "base.ts" },
      { from: "c4.ts", to: "base.ts" },
      { from: "base.ts", to: "hub.ts" },
      { from: "hub.ts", to: "d1.ts" },
      { from: "hub.ts", to: "d2.ts" },
      { from: "hub.ts", to: "d3.ts" },
      { from: "hub.ts", to: "d4.ts" },
    ]);
    const sections = await renderArchitectureSections(analysis, DETECTED, graph);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("SDP");
    expect(kf.content).toContain("I=80%");
  });

  it("suppresses SDP warning when the imported hub is an Orchestrator", async () => {
    // Same topology as SDP test: base.ts (I=0.2) imports hub.ts (I=0.8)
    // But hub.ts has role=Orchestrator — should NOT get SDP warning
    const analysis = makeAnalysis({
      hubFiles: [makeHubFile("hub.ts", { role: "Orchestrator" })],
      instabilities: [{ path: "hub.ts", fanIn: 1, fanOut: 4, instability: 0.8 }],
    });
    const graph = makeGraph([
      { from: "c1.ts", to: "base.ts" },
      { from: "c2.ts", to: "base.ts" },
      { from: "c3.ts", to: "base.ts" },
      { from: "c4.ts", to: "base.ts" },
      { from: "base.ts", to: "hub.ts" },
      { from: "hub.ts", to: "d1.ts" },
      { from: "hub.ts", to: "d2.ts" },
      { from: "hub.ts", to: "d3.ts" },
      { from: "hub.ts", to: "d4.ts" },
    ]);
    const sections = await renderArchitectureSections(analysis, DETECTED, graph);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).not.toContain("SDP");
    expect(kf.content).toContain("I=80%");
  });

  it("shows no SDP warnings when no graph is provided", async () => {
    const analysis = makeAnalysis({
      hubFiles: [makeHubFile("hub.ts")],
      instabilities: [{ path: "hub.ts", fanIn: 1, fanOut: 4, instability: 0.8 }],
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).not.toContain("SDP");
    expect(kf.content).toContain("I=80%");
  });

  it("shows role tag for non-Leaf roles", async () => {
    const analysis = makeAnalysis({ hubFiles: [makeHubFile("src/utils.ts", { role: "Foundation" })] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("(Foundation)");
  });

  it("omits role tag for Leaf files", async () => {
    const analysis = makeAnalysis({ hubFiles: [makeHubFile("src/leaf.ts", { role: "Leaf" })] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).not.toContain("(Leaf)");
  });

  it("uses singular 'file' when importedBy is 1", async () => {
    const analysis = makeAnalysis({ hubFiles: [makeHubFile("src/utils.ts", { importedBy: 1 })] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("1 file");
    expect(kf.content).not.toContain("1 files");
  });

  it("uses plural 'files' when importedBy > 1", async () => {
    const analysis = makeAnalysis({ hubFiles: [makeHubFile("src/utils.ts", { importedBy: 10 })] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const kf = sections.find((s) => s.id === "key-files");
    if (!kf) throw new Error("expected key-files section");
    expect(kf.content).toContain("10 files");
  });
});

// ── architecture section ───────────────────────────────────────────────

describe("renderArchitectureSections: architecture", () => {
  it("emits no architecture section when layers.length <= 1", async () => {
    const analysis = makeAnalysis({ layers: [makeLayer("types")] });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    expect(sections.find((s) => s.id === "architecture")).toBeUndefined();
  });

  it("emits no architecture section when layers is empty", async () => {
    const sections = await renderArchitectureSections(makeAnalysis(), DETECTED);
    expect(sections.find((s) => s.id === "architecture")).toBeUndefined();
  });

  it("emits architecture section when layers.length >= 2", async () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("services")],
      layerEdges: [],
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const arch = sections.find((s) => s.id === "architecture");
    if (!arch) throw new Error("expected architecture section");
    expect(arch.content).toContain("Dependency flow");
    expect(arch.content).toContain("`types`");
    expect(arch.content).toContain("`services`");
    expect(arch.content).toContain("`types` -> `services`");
  });

  it("includes cross-layer edges when they fall outside the main flow", async () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("utils"), makeLayer("services")],
      layerEdges: [
        { from: "services", to: "types" }, // cross-layer: not consecutive in main flow
      ],
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const arch = sections.find((s) => s.id === "architecture");
    if (!arch) throw new Error("expected architecture section");
    expect(arch.content).toContain("Cross-layer edges:");
    expect(arch.content).toContain("services -> types");
  });

  it("omits cross-layer section when all layerEdges are in the main flow", async () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("utils")],
      layerEdges: [{ from: "types", to: "utils" }], // this IS the main flow
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const arch = sections.find((s) => s.id === "architecture");
    if (!arch) throw new Error("expected architecture section");
    expect(arch.content).not.toContain("Cross-layer edges:");
  });
});

// ── monorepo section ───────────────────────────────────────────────────

describe("renderArchitectureSections: monorepo", () => {
  it("emits no package-dependencies section when monorepoAnalysis is absent", async () => {
    const sections = await renderArchitectureSections(makeAnalysis(), DETECTED);
    expect(sections.find((s) => s.id === "package-dependencies")).toBeUndefined();
  });

  it("emits no package-dependencies section when crossPackageEdges is empty", async () => {
    const analysis = makeAnalysis({
      monorepoAnalysis: {
        crossPackageEdges: [],
        encapsulationViolations: [],
        packageDependencies: new Map(),
      },
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    expect(sections.find((s) => s.id === "package-dependencies")).toBeUndefined();
  });

  it("emits package-dependencies section with cross-package edge counts", async () => {
    const analysis = makeAnalysis({
      monorepoAnalysis: {
        crossPackageEdges: [
          {
            from: "pkg-a/src/a.ts",
            to: "pkg-b/src/b.ts",
            fromPackage: "pkg-a",
            toPackage: "pkg-b",
            isEncapsulationViolation: false,
          },
        ],
        encapsulationViolations: [],
        packageDependencies: new Map(),
      },
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const mono = sections.find((s) => s.id === "package-dependencies");
    if (!mono) throw new Error("expected package-dependencies section");
    expect(mono.content).toContain("`pkg-a`");
    expect(mono.content).toContain("`pkg-b`");
    expect(mono.content).toContain("| 1 |");
  });

  it("shows encapsulation violations subsection when violations exist", async () => {
    const violation = {
      from: "pkg-a/src/a.ts",
      to: "pkg-b/internal/x.ts",
      fromPackage: "pkg-a",
      toPackage: "pkg-b",
      isEncapsulationViolation: true,
    };
    const analysis = makeAnalysis({
      monorepoAnalysis: {
        crossPackageEdges: [violation],
        encapsulationViolations: [violation],
        packageDependencies: new Map(),
      },
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const mono = sections.find((s) => s.id === "package-dependencies");
    if (!mono) throw new Error("expected package-dependencies section");
    expect(mono.content).toContain("### Encapsulation Violations");
    expect(mono.content).toContain("pkg-b/internal/x.ts");
  });

  it("caps encapsulation violations at 10 and shows overflow count", async () => {
    const violations = Array.from({ length: 12 }, (_, i) => ({
      from: `pkg-a/src/a${i}.ts`,
      to: `pkg-b/internal/x${i}.ts`,
      fromPackage: "pkg-a",
      toPackage: "pkg-b",
      isEncapsulationViolation: true,
    }));
    const analysis = makeAnalysis({
      monorepoAnalysis: {
        crossPackageEdges: violations,
        encapsulationViolations: violations,
        packageDependencies: new Map(),
      },
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const mono = sections.find((s) => s.id === "package-dependencies");
    if (!mono) throw new Error("expected package-dependencies section");
    expect(mono.content).toContain("and 2 more");
  });

  it("shows key files by package subsection when packageHubFiles exist", async () => {
    const analysis = makeAnalysis({
      monorepoAnalysis: {
        crossPackageEdges: [
          {
            from: "pkg-a/src/a.ts",
            to: "pkg-b/src/b.ts",
            fromPackage: "pkg-a",
            toPackage: "pkg-b",
            isEncapsulationViolation: false,
          },
        ],
        encapsulationViolations: [],
        packageDependencies: new Map(),
        packageHubFiles: new Map([["pkg-a", [{ path: "pkg-a/src/index.ts", authority: 0.9 }]]]),
      },
    });
    const sections = await renderArchitectureSections(analysis, DETECTED);
    const mono = sections.find((s) => s.id === "package-dependencies");
    if (!mono) throw new Error("expected package-dependencies section");
    expect(mono.content).toContain("### Key Files by Package");
    expect(mono.content).toContain("**pkg-a**");
    expect(mono.content).toContain("`pkg-a/src/index.ts`");
  });
});

// ── renderLayerConsistencySection ─────────────────────────────────────

describe("renderLayerConsistencySection", () => {
  it("returns null when layerConsistency is absent", () => {
    const analysis = makeAnalysis({ layers: [makeLayer("types"), makeLayer("utils")] });
    expect(renderLayerConsistencySection(analysis)).toBeNull();
  });

  it("returns null when layers is empty", () => {
    const analysis = makeAnalysis({
      layers: [],
      layerConsistency: {
        consistency: 0.9,
        violations: [{ from: "a.ts", to: "b.ts", fromLayer: "utils", toLayer: "types" }],
      },
    });
    expect(renderLayerConsistencySection(analysis)).toBeNull();
  });

  it("returns null when layers.length is 1", () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types")],
      layerConsistency: {
        consistency: 0.9,
        violations: [{ from: "a.ts", to: "b.ts", fromLayer: "utils", toLayer: "types" }],
      },
    });
    expect(renderLayerConsistencySection(analysis)).toBeNull();
  });

  it("returns null when violations array is empty", () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("utils")],
      layerConsistency: { consistency: 1.0, violations: [] },
    });
    expect(renderLayerConsistencySection(analysis)).toBeNull();
  });

  it("returns layer-consistency section when violations exist", () => {
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("utils")],
      layerConsistency: {
        consistency: 0.85,
        violations: [{ from: "utils/a.ts", to: "services/b.ts", fromLayer: "utils", toLayer: "services" }],
      },
    });
    const section = renderLayerConsistencySection(analysis);
    if (!section) throw new Error("expected layer-consistency section");
    expect(section.id).toBe("layer-consistency");
    expect(section.content).toContain("## Layer Consistency");
    expect(section.content).toContain("85%");
    expect(section.content).toContain("`utils/a.ts`");
    expect(section.content).toContain("`services/b.ts`");
    expect(section.content).toContain("utils -> services");
  });

  it("shows up to 5 violations and overflow count for larger sets", () => {
    const violations = Array.from({ length: 7 }, (_, i) => ({
      from: `a${i}.ts`,
      to: `b${i}.ts`,
      fromLayer: "services",
      toLayer: "types",
    }));
    const analysis = makeAnalysis({
      layers: [makeLayer("types"), makeLayer("services")],
      layerConsistency: { consistency: 0.5, violations },
    });
    const section = renderLayerConsistencySection(analysis);
    if (!section) throw new Error("expected layer-consistency section");
    expect(section.content).toContain("and 2 more");
    const violationLineCount = (section?.content.match(/`a\d\.ts`/g) ?? []).length;
    expect(violationLineCount).toBe(5);
  });
});
