import { describe, it, expect, vi, beforeEach } from "vitest";
import type { LogCtx } from "../types/internal.js";

// ── Mocks ────────────────────────────────────────────────────────────

const mockStep = vi.fn();
const mockInfo = vi.fn();

vi.mock("@clack/prompts", () => ({
  log: {
    step: (...args: unknown[]) => mockStep(args[0]),
    info: (...args: unknown[]) => mockInfo(args[0]),
    warn: vi.fn(),
    error: vi.fn(),
    message: vi.fn(),
    success: vi.fn(),
  },
  outro: vi.fn(),
  intro: vi.fn(),
  note: vi.fn(),
}));

vi.mock("../theme.js", () => ({
  theme: {
    text: (s: string) => s,
    textBold: (s: string) => s,
    accent: (s: string) => s,
    muted: (s: string) => s,
    brand: (s: string) => s,
    brandBold: (s: string) => s,
    warn: (s: string) => s,
    success: (s: string) => s,
    error: (s: string) => s,
    check: () => "\u2713",
    bold: (s: string) => s,
    soft: (s: string) => s,
  },
}));

import {
  logHubFiles,
  logCircularDeps,
  logLayers,
  logInstabilities,
  logCommunities,
  logDeadFiles,
  logCrossCuttingFiles,
  logLayerConsistency,
  logChokepoints,
  logTopology,
  logGitActivity,
  logConfigConstraints,
  logConventions,
  logTestMapping,
  logMonorepoAnalysis,
  logDelta,
} from "../core/phase-logger.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const LOG_NORMAL: LogCtx = { jsonMode: false, verbose: false };
const LOG_JSON: LogCtx = { jsonMode: true, verbose: false };
const LOG_VERBOSE: LogCtx = { jsonMode: false, verbose: true };

function makeHubFile(path: string) {
  return { path, centrality: 0.5, authority: 0.8, hubScore: 0.4, role: "Foundation" as const, importedBy: 5 };
}

function makeLayer(name: string) {
  return { name, files: ["src/a.ts"], importedByLayers: 0, dependsOn: [] };
}

function makeGitActivity() {
  return {
    hotFiles: [{ path: "src/a.ts", commits: 10, lastChanged: "2025-01-01" }],
    changeCoupling: [{ files: ["a.ts", "b.ts"], coChangeCount: 5, jaccard: 0.5, confidence: 0.6 }],
    lagCouplings: [],
  };
}

beforeEach(() => {
  mockStep.mockClear();
  mockInfo.mockClear();
});

// ── jsonMode suppression ───────────────────────────────────────────────

describe("jsonMode suppression", () => {
  it.each([
    ["logHubFiles", () => logHubFiles([], LOG_JSON)],
    ["logCircularDeps", () => logCircularDeps([], LOG_JSON)],
    ["logLayers", () => logLayers([], LOG_JSON)],
    ["logInstabilities", () => logInstabilities([], LOG_JSON)],
    ["logCommunities", () => logCommunities([], LOG_JSON)],
    ["logDeadFiles", () => logDeadFiles(["dead.ts"], LOG_JSON)],
    [
      "logCrossCuttingFiles",
      () => logCrossCuttingFiles([{ file: "x.ts", totalImporters: 2, layerSpread: 2, layers: ["a", "b"] }], LOG_JSON),
    ],
    ["logLayerConsistency", () => logLayerConsistency({ consistency: 1, violations: [] }, LOG_JSON)],
    [
      "logChokepoints",
      () => logChokepoints([{ file: "x.ts", importedBy: 1, upstreamCount: 5, downstreamCount: 2 }], LOG_JSON),
    ],
    [
      "logTopology",
      () =>
        logTopology(
          { componentCount: 1, componentSizes: [10], approximateDiameter: 3, reachability: 1, isFragmented: false },
          LOG_JSON,
        ),
    ],
    ["logGitActivity", () => logGitActivity(makeGitActivity(), 90, LOG_JSON)],
    [
      "logConfigConstraints",
      () =>
        logConfigConstraints(
          { typescript: { strict: true, target: "ES2022", pathAliases: {}, otherStrict: [] } },
          LOG_JSON,
        ),
    ],
    [
      "logConventions",
      () =>
        logConventions(
          {
            naming: { functions: "camelCase", types: "PascalCase", constants: "UPPER", files: "camelCase" },
            exportStyle: { preferNamed: true, defaultExportPercent: 0, barrelFileCount: 0 },
          },
          LOG_JSON,
        ),
    ],
    [
      "logTestMapping",
      () => logTestMapping({ sourceToTests: new Map([["a.ts", ["a.test.ts"]]]), untestedFiles: [] }, LOG_JSON),
    ],
    [
      "logMonorepoAnalysis",
      () =>
        logMonorepoAnalysis(
          {
            crossPackageEdges: [
              { from: "a", to: "b", fromPackage: "p1", toPackage: "p2", isEncapsulationViolation: false },
            ],
            encapsulationViolations: [],
            packageDependencies: new Map(),
          },
          LOG_JSON,
        ),
    ],
    ["logDelta", () => logDelta("- some change", LOG_JSON)],
  ])("%s does not log when jsonMode=true", (_, fn) => {
    fn();
    expect(mockStep).not.toHaveBeenCalled();
    expect(mockInfo).not.toHaveBeenCalled();
  });
});

// ── logHubFiles ────────────────────────────────────────────────────────

describe("logHubFiles", () => {
  it("logs 'no key files detected' when empty", () => {
    logHubFiles([], LOG_NORMAL);
    expect(mockStep).toHaveBeenCalledOnce();
    expect(mockStep.mock.calls[0][0]).toContain("no key files detected");
  });

  it("logs count and top file name when populated", () => {
    logHubFiles([makeHubFile("src/utils.ts"), makeHubFile("src/core.ts")], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 key files");
    expect(msg).toContain("src/utils.ts");
  });

  it("logs individual file details in verbose mode", () => {
    logHubFiles([makeHubFile("src/utils.ts")], LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/utils.ts");
    expect(infoMsg).toContain("auth:");
    expect(infoMsg).toContain("role:");
  });
});

// ── logCircularDeps ────────────────────────────────────────────────────

describe("logCircularDeps", () => {
  it("logs checkmark when no cycles", () => {
    logCircularDeps([], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("\u2713");
  });

  it("logs count with warning when cycles found", () => {
    logCircularDeps([{ chain: ["a.ts", "b.ts", "a.ts"] }], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 cycle");
    expect(msg).not.toContain("cycles");
  });

  it("uses plural 'cycles' for multiple cycles", () => {
    logCircularDeps([{ chain: ["a.ts", "b.ts", "a.ts"] }, { chain: ["c.ts", "d.ts", "c.ts"] }], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 cycles");
  });

  it("logs cycle chains in verbose mode", () => {
    logCircularDeps([{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"] }], LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/a.ts");
  });
});

// ── logLayers ──────────────────────────────────────────────────────────

describe("logLayers", () => {
  it("logs 'no clear layers detected' when empty", () => {
    logLayers([], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("no clear layers detected");
  });

  it("logs layer names joined with arrows", () => {
    logLayers([makeLayer("types"), makeLayer("utils"), makeLayer("services")], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("types");
    expect(msg).toContain("utils");
    expect(msg).toContain("services");
  });

  it("logs per-layer details in verbose mode", () => {
    logLayers([makeLayer("types")], LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("types");
    expect(infoMsg).toContain("files");
  });
});

// ── logInstabilities ───────────────────────────────────────────────────

describe("logInstabilities", () => {
  it("logs healthy range message when no high-instability files", () => {
    logInstabilities([], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("all files within healthy range");
    expect(msg).toContain("\u2713");
  });

  it("logs count with warning when high-instability files found", () => {
    logInstabilities([{ path: "src/a.ts", fanIn: 1, fanOut: 9, instability: 0.9 }], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 high-risk file");
  });

  it("logs file details in verbose mode", () => {
    logInstabilities([{ path: "src/a.ts", fanIn: 1, fanOut: 9, instability: 0.9 }], LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/a.ts");
    expect(infoMsg).toContain("I=");
  });
});

// ── logCommunities ─────────────────────────────────────────────────────

describe("logCommunities", () => {
  it("logs 'single cohesive module' when empty", () => {
    logCommunities([], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("single cohesive module");
  });

  it("logs count when communities found", () => {
    const communities = [
      { id: 0, label: "core", files: ["a.ts"] },
      { id: 1, label: "utils", files: ["b.ts"] },
    ];
    logCommunities(communities, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 module clusters");
  });
});

// ── logDeadFiles ───────────────────────────────────────────────────────

describe("logDeadFiles", () => {
  it("does not log when empty", () => {
    logDeadFiles([], LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs count with warning when dead files found", () => {
    logDeadFiles(["src/dead.ts", "src/unused.ts"], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 files not imported");
  });

  it("logs file paths in verbose mode", () => {
    logDeadFiles(["src/dead.ts"], LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/dead.ts");
  });
});

// ── logCrossCuttingFiles ───────────────────────────────────────────────

describe("logCrossCuttingFiles", () => {
  it("does not log when empty", () => {
    logCrossCuttingFiles([], LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs count when cross-cutting files found", () => {
    logCrossCuttingFiles(
      [{ file: "src/types.ts", totalImporters: 10, layerSpread: 3, layers: ["a", "b", "c"] }],
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 file");
    expect(msg).toContain("3+ layers");
  });
});

// ── logLayerConsistency ────────────────────────────────────────────────

describe("logLayerConsistency", () => {
  it("does not log when undefined", () => {
    logLayerConsistency(undefined, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs percentage with checkmark when no violations", () => {
    logLayerConsistency({ consistency: 0.95, violations: [] }, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("95%");
    expect(msg).toContain("\u2713");
  });

  it("logs percentage and violation count when violations exist", () => {
    logLayerConsistency(
      {
        consistency: 0.7,
        violations: [
          { from: "a.ts", to: "b.ts", fromLayer: "services", toLayer: "types" },
          { from: "c.ts", to: "d.ts", fromLayer: "services", toLayer: "utils" },
        ],
      },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("70%");
    expect(msg).toContain("2 violations");
  });

  it("logs violation details in verbose mode", () => {
    logLayerConsistency(
      { consistency: 0.8, violations: [{ from: "a.ts", to: "b.ts", fromLayer: "services", toLayer: "types" }] },
      LOG_VERBOSE,
    );
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("a.ts");
    expect(infoMsg).toContain("b.ts");
  });
});

// ── logChokepoints ─────────────────────────────────────────────────────

describe("logChokepoints", () => {
  it("does not log when empty", () => {
    logChokepoints([], LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs count when chokepoints found", () => {
    logChokepoints([{ file: "src/core.ts", importedBy: 15, upstreamCount: 100, downstreamCount: 5 }], LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 structural chokepoint");
  });
});

// ── logTopology ────────────────────────────────────────────────────────

describe("logTopology", () => {
  it("does not log for connected graph in non-verbose mode", () => {
    logTopology(
      { componentCount: 1, componentSizes: [50], approximateDiameter: 5, reachability: 1, isFragmented: false },
      LOG_NORMAL,
    );
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs fragmented warning when isFragmented", () => {
    logTopology(
      {
        componentCount: 3,
        componentSizes: [30, 10, 5],
        approximateDiameter: 4,
        reachability: 0.67,
        isFragmented: true,
      },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("3 connected components");
    expect(msg).toContain("fragmented");
  });

  it("logs connected graph info in verbose mode", () => {
    logTopology(
      { componentCount: 1, componentSizes: [50], approximateDiameter: 5, reachability: 1, isFragmented: false },
      LOG_VERBOSE,
    );
    expect(mockStep).toHaveBeenCalled();
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("single connected");
  });
});

// ── logGitActivity ─────────────────────────────────────────────────────

describe("logGitActivity", () => {
  it("logs 'not a git repo' when gitActivity is null", () => {
    logGitActivity(null, 90, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("not a git repo");
  });

  it("logs active files and coupled pairs count when activity present", () => {
    const activity = {
      hotFiles: [{ path: "a.ts", commits: 10, lastChanged: "2025-01-01" }],
      changeCoupling: [
        { files: ["a.ts", "b.ts"], coChangeCount: 5, jaccard: 0.5, confidence: 0.6 },
        { files: ["c.ts", "d.ts"], coChangeCount: 3, jaccard: 0.3, confidence: 0.5 },
      ],
      lagCouplings: [],
    };
    logGitActivity(activity, 90, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 active file");
    expect(msg).toContain("2 coupled pairs");
  });

  it("logs hot file details in verbose mode", () => {
    logGitActivity(makeGitActivity(), 90, LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/a.ts");
    expect(infoMsg).toContain("commits");
  });
});

// ── logConfigConstraints ───────────────────────────────────────────────

describe("logConfigConstraints", () => {
  it("does not log when no constraints present", () => {
    logConfigConstraints({}, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs tsconfig when typescript constraint present", () => {
    logConfigConstraints(
      { typescript: { strict: true, target: "ES2022", pathAliases: {}, otherStrict: [] } },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("tsconfig");
  });

  it("logs linter tool name when linter constraint present", () => {
    logConfigConstraints({ linter: { tool: "biome", keyRules: [] } }, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("biome");
  });
});

// ── logConventions ─────────────────────────────────────────────────────

describe("logConventions", () => {
  it("does not log when null", () => {
    logConventions(null, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("does not log when all naming is 'mixed' and no other patterns", () => {
    logConventions(
      {
        naming: { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" },
        exportStyle: { preferNamed: false, defaultExportPercent: 100, barrelFileCount: 0 },
      },
      LOG_NORMAL,
    );
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs inferred naming when consistent naming detected", () => {
    logConventions(
      {
        naming: { functions: "camelCase", types: "PascalCase", constants: "UPPER", files: "camelCase" },
        exportStyle: { preferNamed: true, defaultExportPercent: 0, barrelFileCount: 0 },
      },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("inferred");
    expect(msg).toContain("naming");
  });
});

// ── logTestMapping ─────────────────────────────────────────────────────

describe("logTestMapping", () => {
  it("does not log when null", () => {
    logTestMapping(null, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs covered count with checkmark when no untested files", () => {
    logTestMapping(
      {
        sourceToTests: new Map([
          ["a.ts", ["a.test.ts"]],
          ["b.ts", ["b.test.ts"]],
        ]),
        untestedFiles: [],
      },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 source files with tests");
    expect(msg).toContain("\u2713");
  });

  it("logs untested count when untested files exist", () => {
    logTestMapping({ sourceToTests: new Map([["a.ts", ["a.test.ts"]]]), untestedFiles: ["b.ts", "c.ts"] }, LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("2 untested");
  });

  it("logs untested file paths in verbose mode", () => {
    logTestMapping({ sourceToTests: new Map(), untestedFiles: ["src/untested.ts"] }, LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("src/untested.ts");
  });
});

// ── logMonorepoAnalysis ────────────────────────────────────────────────

describe("logMonorepoAnalysis", () => {
  it("does not log when undefined", () => {
    logMonorepoAnalysis(undefined, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("does not log when crossPackageEdges is empty", () => {
    logMonorepoAnalysis(
      { crossPackageEdges: [], encapsulationViolations: [], packageDependencies: new Map() },
      LOG_NORMAL,
    );
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs edge count when cross-package edges present", () => {
    logMonorepoAnalysis(
      {
        crossPackageEdges: [
          { from: "a", to: "b", fromPackage: "p1", toPackage: "p2", isEncapsulationViolation: false },
        ],
        encapsulationViolations: [],
        packageDependencies: new Map(),
      },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 cross-package edge");
    expect(msg).toContain("\u2713");
  });

  it("logs violation count when encapsulation violations present", () => {
    const edge = { from: "a", to: "b", fromPackage: "p1", toPackage: "p2", isEncapsulationViolation: true };
    logMonorepoAnalysis(
      { crossPackageEdges: [edge], encapsulationViolations: [edge], packageDependencies: new Map() },
      LOG_NORMAL,
    );
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("1 encapsulation violation");
  });
});

// ── logDelta ───────────────────────────────────────────────────────────

describe("logDelta", () => {
  it("does not log when deltaSection is null", () => {
    logDelta(null, LOG_NORMAL);
    expect(mockStep).not.toHaveBeenCalled();
  });

  it("logs 'architecture changes detected' when deltaSection present", () => {
    logDelta("- new cycle detected\n- hub file added", LOG_NORMAL);
    const msg = mockStep.mock.calls[0][0] as string;
    expect(msg).toContain("architecture changes detected");
  });

  it("logs delta lines in verbose mode", () => {
    logDelta("- new cycle detected\n- hub file added", LOG_VERBOSE);
    expect(mockInfo).toHaveBeenCalled();
    const infoMsg = mockInfo.mock.calls[0][0] as string;
    expect(infoMsg).toContain("new cycle detected");
  });
});
