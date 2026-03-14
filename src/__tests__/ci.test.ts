import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeImportGraph, makeContextAnalysis } from "./helpers/factories.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../detect/detect.js", () => ({
  detectContext: vi.fn(),
  enrichFrameworksWithUsage: vi.fn().mockReturnValue([]),
}));

vi.mock("../graph/cache.js", () => ({
  buildGraphWithCache: vi.fn(),
}));

vi.mock("../graph/build.js", () => ({
  buildImportGraph: vi.fn(),
  mergeGraph: vi.fn(),
}));

vi.mock("../core/run-analysis.js", () => ({
  runAnalysis: vi.fn(),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../analysis/ci.js", () => ({
  analyzeForCI: vi.fn(),
}));

const { execFileSync } = await import("node:child_process");
const { detectContext, enrichFrameworksWithUsage } = await import("../detect/detect.js");
const { buildGraphWithCache } = await import("../graph/cache.js");
const { buildImportGraph, mergeGraph } = await import("../graph/build.js");
const { runAnalysis } = await import("../core/run-analysis.js");
const { loadConfig } = await import("../config/config.js");
const { analyzeForCI } = await import("../analysis/ci.js");
const { runCiMode } = await import("../cli/ci.js");

const mockExecFileSync = vi.mocked(execFileSync);
const mockDetectContext = vi.mocked(detectContext);
const mockBuildGraphWithCache = vi.mocked(buildGraphWithCache);
const mockBuildImportGraph = vi.mocked(buildImportGraph);
const mockMergeGraph = vi.mocked(mergeGraph);
const mockRunAnalysis = vi.mocked(runAnalysis);
const mockLoadConfig = vi.mocked(loadConfig);
const mockAnalyzeForCI = vi.mocked(analyzeForCI);
const mockEnrichFrameworksWithUsage = vi.mocked(enrichFrameworksWithUsage);

const ROOT = "/test";

const EMPTY_RESULT = {
  version: 2 as const,
  timestamp: new Date().toISOString(),
  filesAnalyzed: 0,
  missingCoChanges: [],
  chokepoints: [],
  crossCutting: [],
  flowBottlenecks: [],
  tightCouplings: [],
  hasFindings: false,
};

const DETECTED = {
  rootDir: ROOT,
  language: "typescript" as const,
  hasTypeScript: true,
  packageManager: "npm" as const,
  linter: "none" as const,
  frameworks: [],
  directories: ["src"],
  dependencies: [],
  isGitRepo: true,
  totalSourceBytes: 0,
  sourceFileCount: 0,
  monorepo: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadConfig.mockResolvedValue(null);
  mockDetectContext.mockResolvedValue(DETECTED);
  mockBuildGraphWithCache.mockResolvedValue(makeImportGraph());
  mockRunAnalysis.mockResolvedValue({ analysis: makeContextAnalysis(), deltaSection: null });
  mockAnalyzeForCI.mockReturnValue({ ...EMPTY_RESULT, filesAnalyzed: 1 });
});

// ── Git fallback: base undefined + error ──────────────────────────────

describe("runCiMode - git error with no base ref", () => {
  it("returns empty result immediately when base is undefined and git diff throws", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("fatal: bad default revision 'HEAD'");
    });
    const result = await runCiMode(ROOT, null, undefined, false);
    // Should only call git once (HEAD), not a second fallback
    expect(mockExecFileSync).toHaveBeenCalledTimes(1);
    expect(result.filesAnalyzed).toBe(0);
    expect(result.hasFindings).toBe(false);
  });
});

// ── Secondary language merging ────────────────────────────────────────

describe("runCiMode - secondary languages", () => {
  it("merges graphs for each secondary language", async () => {
    const detected = {
      ...DETECTED,
      secondaryLanguages: ["python" as const, "go" as const],
    };
    mockDetectContext.mockResolvedValue(detected);

    const primaryGraph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(primaryGraph);
    mockBuildImportGraph.mockResolvedValue(makeImportGraph());

    await runCiMode(ROOT, ["src/a.ts"], undefined, false);

    expect(mockBuildImportGraph).toHaveBeenCalledTimes(2);
    expect(mockBuildImportGraph).toHaveBeenCalledWith(ROOT, "python", undefined);
    expect(mockBuildImportGraph).toHaveBeenCalledWith(ROOT, "go", undefined);
    expect(mockMergeGraph).toHaveBeenCalledTimes(2);
  });

  it("skips secondary language merging when not present", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);

    await runCiMode(ROOT, ["src/a.ts"], undefined, false);

    expect(mockBuildImportGraph).not.toHaveBeenCalled();
    expect(mockMergeGraph).not.toHaveBeenCalled();
  });
});

// ── enrichFrameworksWithUsage ─────────────────────────────────────────

describe("runCiMode - framework enrichment", () => {
  it("calls enrichFrameworksWithUsage with frameworks and external import counts", async () => {
    const frameworks = [{ name: "react", version: "18.0.0" }];
    const detected = { ...DETECTED, frameworks };
    mockDetectContext.mockResolvedValue(detected);

    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);

    await runCiMode(ROOT, ["src/a.ts"], undefined, false);

    expect(mockEnrichFrameworksWithUsage).toHaveBeenCalledWith(frameworks, graph.externalImportCounts);
  });
});

// ── Verbose logging ───────────────────────────────────────────────────

describe("runCiMode - verbose logging", () => {
  it("writes to stderr when verbose is true", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);

    await runCiMode(ROOT, ["src/a.ts"], undefined, true);

    const ciMessages = stderrSpy.mock.calls.map(([msg]) => String(msg)).filter((msg) => msg.startsWith("[ci]"));
    expect(ciMessages.length).toBeGreaterThan(0);
    expect(ciMessages[0]).toContain("Analyzing 1 changed files");

    stderrSpy.mockRestore();
  });

  it("logs skipped non-source files when verbose", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    // src/a.ts is in graph, README.md is not
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);

    await runCiMode(ROOT, ["src/a.ts", "README.md"], undefined, true);

    const ciMessages = stderrSpy.mock.calls.map(([msg]) => String(msg)).filter((msg) => msg.startsWith("[ci]"));
    const skipMsg = ciMessages.find((m) => m.includes("Skipping"));
    expect(skipMsg).toBeDefined();
    expect(skipMsg).toContain("README.md");

    stderrSpy.mockRestore();
  });

  it("does not write to stderr when verbose is false", async () => {
    const stderrSpy = vi.spyOn(process.stderr, "write").mockReturnValue(true);

    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);

    await runCiMode(ROOT, ["src/a.ts"], undefined, false);

    const ciMessages = stderrSpy.mock.calls.map(([msg]) => String(msg)).filter((msg) => msg.startsWith("[ci]"));
    expect(ciMessages).toHaveLength(0);

    stderrSpy.mockRestore();
  });
});

// ── Verbose with secondary languages passes progress ──────────────────

describe("runCiMode - verbose secondary language progress", () => {
  it("passes verbose progress callback to buildImportGraph", async () => {
    const detected = {
      ...DETECTED,
      secondaryLanguages: ["python" as const],
    };
    mockDetectContext.mockResolvedValue(detected);

    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    mockBuildImportGraph.mockResolvedValue(makeImportGraph());

    await runCiMode(ROOT, ["src/a.ts"], undefined, true);

    // When verbose, progress callback (3rd arg) should be a function, not undefined
    const thirdArg = mockBuildImportGraph.mock.calls[0][2];
    expect(typeof thirdArg).toBe("function");
  });

  it("passes undefined progress to buildImportGraph when not verbose", async () => {
    const detected = {
      ...DETECTED,
      secondaryLanguages: ["python" as const],
    };
    mockDetectContext.mockResolvedValue(detected);

    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    mockBuildImportGraph.mockResolvedValue(makeImportGraph());

    await runCiMode(ROOT, ["src/a.ts"], undefined, false);

    const thirdArg = mockBuildImportGraph.mock.calls[0][2];
    expect(thirdArg).toBeUndefined();
  });
});
