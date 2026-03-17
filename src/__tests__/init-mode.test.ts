import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../cli/animations.js", () => ({
  startShimmer: () => ({
    message: vi.fn(),
    stop: vi.fn(),
  }),
  NOOP_SHIMMER: { stop() {}, message() {} },
}));

const clackMock = vi.hoisted(() => ({
  logCalls: [] as Array<{ method: string; args: unknown[] }>,
}));
const mockConfirm = vi.fn().mockResolvedValue(false);

vi.mock("@clack/prompts", async () => {
  const { createClackMock } = await import("./helpers/mocks.js");
  const m = createClackMock({ captureLogs: true });
  clackMock.logCalls = m.logCalls;
  const mock = m.mock;
  mock.confirm = (...args: unknown[]) => mockConfirm(...args);
  return mock;
});

vi.mock("../core/theme.js", async () => {
  const { THEME_MOCK } = await import("./helpers/mocks.js");
  return { theme: THEME_MOCK, unpatchPicocolors: vi.fn(), resetTerminalColors: vi.fn() };
});

// Detection mocks
const mockDetectContext = vi.fn().mockResolvedValue({
  rootDir: "/tmp/test",
  language: "typescript",
  hasTypeScript: true,
  packageManager: "npm",
  linter: "eslint",
  frameworks: [],
  directories: ["src"],
  dependencies: [],
  isGitRepo: true,
  totalSourceBytes: 10000,
  sourceFileCount: 50,
  monorepo: null,
});
const mockDetectIDEs = vi.fn().mockResolvedValue(["claude"]);
const mockDetectProjectDescription = vi.fn().mockResolvedValue("A test project");
const mockEnrichFrameworksWithUsage = vi.fn().mockReturnValue([]);

vi.mock("../core/detect/detect.js", () => ({
  detectContext: (...args: unknown[]) => mockDetectContext(...args),
  detectIDEs: (...args: unknown[]) => mockDetectIDEs(...args),
  detectProjectDescription: (...args: unknown[]) => mockDetectProjectDescription(...args),
  enrichFrameworksWithUsage: (...args: unknown[]) => mockEnrichFrameworksWithUsage(...args),
}));

// Graph mocks
const mockBuildGraphWithCache = vi.fn().mockResolvedValue({
  edges: [],
  inDegree: new Map(),
  centrality: new Map(),
  externalImportCounts: new Map(),
  authority: new Map(),
  hubScores: new Map(),
});
const mockBuildImportGraph = vi.fn().mockResolvedValue({
  edges: [],
  inDegree: new Map(),
  centrality: new Map(),
  externalImportCounts: new Map(),
  authority: new Map(),
  hubScores: new Map(),
});
const mockMergeGraph = vi.fn();

vi.mock("../core/graph/cache.js", () => ({
  buildGraphWithCache: (...args: unknown[]) => mockBuildGraphWithCache(...args),
}));
vi.mock("../core/graph/build.js", () => ({
  buildImportGraph: (...args: unknown[]) => mockBuildImportGraph(...args),
  mergeGraph: (...args: unknown[]) => mockMergeGraph(...args),
  recomputeScoresAfterMerge: vi.fn(),
}));

const mockGetHubFiles = vi.fn().mockReturnValue([]);
vi.mock("../core/graph/hub-files.js", () => ({
  getHubFiles: (...args: unknown[]) => mockGetHubFiles(...args),
}));

// Analysis mock
const mockRunAnalysis = vi.fn().mockResolvedValue({
  analysis: {
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    deadFiles: [],
    configConstraints: {},
    crossCuttingFiles: [],
    chokepoints: [],
    graphTopology: { isFragmented: false, componentCount: 1, componentSizes: [5], approximateDiameter: 2 },
    analysisDays: 90,
  },
  deltaSection: null,
});

vi.mock("../core/run-analysis.js", () => ({
  runAnalysis: (...args: unknown[]) => mockRunAnalysis(...args),
}));

// Snapshot mock
const mockGenerateSnapshot = vi.fn().mockResolvedValue({
  entries: [{ file: "src/types.ts", category: "type", signature: "interface Foo {}" }],
  markdown: "## Types\n\n```ts\ninterface Foo {}\n```",
  budgetExcluded: 0,
});

vi.mock("../core/snapshot/snapshot.js", () => ({
  generateSnapshot: (...args: unknown[]) => mockGenerateSnapshot(...args),
}));

// File generation mock
const mockGenerateFiles = vi
  .fn()
  .mockResolvedValue([{ path: ".claude/rules/clarte.md", content: "# Test", isNew: true }]);

vi.mock("../core/generate.js", () => ({
  generateFiles: (...args: unknown[]) => mockGenerateFiles(...args),
}));

// Summary mock
const mockPrintSummary = vi.fn();
vi.mock("../cli/summary.js", () => ({
  printSummary: (...args: unknown[]) => mockPrintSummary(...args),
}));

// Config mocks
const mockSaveConfig = vi.fn().mockResolvedValue(undefined);
const mockConfigToAnswers = vi.fn().mockReturnValue({
  ides: ["claude"],
  projectPurpose: "test",
  keyPatterns: "",
  gotchas: "",
  generateSnapshot: true,
  snapshotPaths: [],
  stackConfirmed: true,
  stackCorrections: "",
  generatePerPackage: false,
});
const mockComputeSnapshotHash = vi.fn().mockResolvedValue("hash123");

vi.mock("../core/config/config.js", () => ({
  CLARTE_DIR: ".clarte",
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  configToAnswers: (...args: unknown[]) => mockConfigToAnswers(...args),
  computeSnapshotHash: (...args: unknown[]) => mockComputeSnapshotHash(...args),
}));

// Prompts mock
const mockRunPrompts = vi.fn().mockResolvedValue({
  ides: ["claude"],
  projectPurpose: "reconfigured",
  keyPatterns: "",
  gotchas: "",
  generateSnapshot: true,
  snapshotPaths: [],
  stackConfirmed: true,
  stackCorrections: "",
  generatePerPackage: false,
});

vi.mock("../cli/prompts.js", () => ({
  runPrompts: (...args: unknown[]) => mockRunPrompts(...args),
}));

// Hooks mock
vi.mock("../cli/hooks.js", () => ({
  initPreCommitHook: vi.fn(),
}));

// GraphStore mock
const mockStore = vi.hoisted(() => ({
  close: vi.fn(),
  getCache: vi.fn().mockReturnValue(undefined),
  setCache: vi.fn(),
}));
vi.mock("../storage/loader.js", () => ({
  openGraphStore: vi.fn().mockResolvedValue(mockStore),
}));

vi.mock("../core/graph/persist.js", () => ({
  persistGraph: vi.fn().mockResolvedValue(undefined),
  loadPersistedGraph: vi.fn().mockResolvedValue(null),
  CLARTE_DIR: ".clarte",
}));

// Serialize/directives mocks
const mockSerializeAnalysis = vi.fn().mockReturnValue({ detected: {}, analysis: {} });
vi.mock("../core/analysis/serialize.js", () => ({
  serializeAnalysis: (...args: unknown[]) => mockSerializeAnalysis(...args),
}));
vi.mock("../steer/context/directives.js", () => ({
  buildDirectives: vi.fn().mockReturnValue([]),
}));

const mockFileExists = vi.fn().mockResolvedValue(false);
vi.mock("../core/utils.js", () => ({
  NOOP_PROGRESS: () => {},
  fileExists: (...args: unknown[]) => mockFileExists(...args),
  formatBytes: (n: number) => `${(n / 1024).toFixed(0)} KB`,
  errorMessage: (err: unknown) => (err instanceof Error ? err.message : String(err)),
  writeJsonStdout: vi.fn().mockResolvedValue(undefined),
}));

// ── Import under test (after mocks) ────────────────────────────────

import { runInitMode } from "../cli/init";
import type { ProjectConfig } from "../core/types";

// ── Helpers ─────────────────────────────────────────────────────────

function makeOpts(overrides: Partial<Parameters<typeof runInitMode>[0]> = {}) {
  return {
    rootDir: "/tmp/test",
    yes: false,
    dryRun: false,
    reconfigure: false,
    verbose: false,
    jsonMode: false,
    savedConfig: null as ProjectConfig | null,
    ...overrides,
  };
}

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  clackMock.logCalls.length = 0;
  vi.clearAllMocks();
  mockDetectContext.mockResolvedValue({
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 10000,
    sourceFileCount: 50,
    monorepo: null,
  });
  mockGenerateFiles.mockResolvedValue([{ path: ".claude/rules/clarte.md", content: "# Test", isNew: true }]);
  mockRunAnalysis.mockResolvedValue({
    analysis: {
      hubFiles: [],
      circularDeps: [],
      layers: [],
      layerEdges: [],
      gitActivity: null,
      instabilities: [],
      communities: [],
      deadFiles: [],
      configConstraints: {},
      crossCuttingFiles: [],
      chokepoints: [],
      graphTopology: { isFragmented: false, componentCount: 1, componentSizes: [5], approximateDiameter: 2 },
      analysisDays: 90,
    },
    deltaSection: null,
  });
  mockGenerateSnapshot.mockResolvedValue({
    entries: [{ file: "src/types.ts", category: "type", signature: "interface Foo {}" }],
    markdown: "## Types",
    budgetExcluded: 0,
  });
});

describe("runInitMode", () => {
  it("runs the full pipeline: detect -> graph -> analysis -> snapshot -> generate", async () => {
    await runInitMode(makeOpts());

    expect(mockDetectContext).toHaveBeenCalled();
    expect(mockBuildGraphWithCache).toHaveBeenCalled();
    expect(mockRunAnalysis).toHaveBeenCalled();
    expect(mockGenerateSnapshot).toHaveBeenCalled();
    expect(mockGenerateFiles).toHaveBeenCalled();
    expect(mockPrintSummary).toHaveBeenCalled();
  });

  it("passes dryRun through to generateFiles", async () => {
    await runInitMode(makeOpts({ dryRun: true }));

    const callArgs = mockGenerateFiles.mock.calls[0][0];
    expect(callArgs.dryRun).toBe(true);
  });

  it("uses saved config when present (skips prompts)", async () => {
    const savedConfig = {
      ides: ["claude"],
      generateSnapshot: true,
      snapshotPaths: [],
      generatePerPackage: false,
    } as ProjectConfig;

    await runInitMode(makeOpts({ savedConfig }));

    expect(mockConfigToAnswers).toHaveBeenCalledWith(savedConfig);
    expect(mockRunPrompts).not.toHaveBeenCalled();
    expect(mockDetectIDEs).not.toHaveBeenCalled();
  });

  it("runs prompts when reconfigure=true", async () => {
    const savedConfig = {
      ides: ["claude"],
      generateSnapshot: true,
      snapshotPaths: [],
      generatePerPackage: false,
    } as ProjectConfig;

    await runInitMode(makeOpts({ savedConfig, reconfigure: true }));

    expect(mockRunPrompts).toHaveBeenCalled();
    expect(mockConfigToAnswers).not.toHaveBeenCalled();
  });

  it("auto-detects IDEs on first run (no saved config)", async () => {
    await runInitMode(makeOpts({ savedConfig: null }));

    expect(mockDetectIDEs).toHaveBeenCalled();
    expect(mockDetectProjectDescription).toHaveBeenCalled();
    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it("skips snapshot when generateSnapshot=false", async () => {
    mockConfigToAnswers.mockReturnValue({
      ides: ["claude"],
      projectPurpose: "test",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: false,
      snapshotPaths: [],
      stackConfirmed: true,
      stackCorrections: "",
      generatePerPackage: false,
    });
    const savedConfig = { generateSnapshot: false } as ProjectConfig;

    await runInitMode(makeOpts({ savedConfig }));

    expect(mockGenerateSnapshot).not.toHaveBeenCalled();
  });

  it("handles empty file generation gracefully", async () => {
    mockGenerateFiles.mockResolvedValue([]);
    const { outro } = await import("@clack/prompts");

    await runInitMode(makeOpts());

    expect(outro).toHaveBeenCalledWith("Nothing to write. Done!");
    expect(mockPrintSummary).not.toHaveBeenCalled();
  });

  it("saves config on first run when not dry-run", async () => {
    await runInitMode(makeOpts({ dryRun: false, savedConfig: null }));

    expect(mockSaveConfig).toHaveBeenCalled();
  });

  it("does not save config on dry-run", async () => {
    await runInitMode(makeOpts({ dryRun: true, savedConfig: null }));

    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("builds secondary language graphs when detected", async () => {
    mockDetectContext.mockResolvedValue({
      rootDir: "/tmp/test",
      language: "typescript",
      hasTypeScript: true,
      packageManager: "npm",
      linter: "eslint",
      frameworks: [],
      directories: ["src"],
      dependencies: [],
      isGitRepo: true,
      totalSourceBytes: 10000,
      sourceFileCount: 50,
      monorepo: null,
      secondaryLanguages: ["python"],
    });

    await runInitMode(makeOpts());

    expect(mockBuildImportGraph).toHaveBeenCalledWith("/tmp/test", "python", undefined, undefined);
    expect(mockMergeGraph).toHaveBeenCalled();
  });
});
