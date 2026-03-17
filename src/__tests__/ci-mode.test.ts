import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeImportGraph, makeContextAnalysis } from "./helpers/factories";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

vi.mock("../core/detect/detect.js", () => ({
  detectContext: vi.fn(),
  enrichFrameworksWithUsage: vi.fn().mockReturnValue([]),
}));

vi.mock("../core/graph/cache.js", () => ({
  buildGraphWithCache: vi.fn(),
}));

vi.mock("../core/graph/build.js", () => ({
  buildImportGraph: vi.fn(),
  mergeGraph: vi.fn(),
}));

vi.mock("../core/run-analysis.js", () => ({
  runAnalysis: vi.fn(),
}));

vi.mock("../core/config/config.js", () => ({
  loadConfig: vi.fn(),
}));

vi.mock("../core/analysis/ci.js", () => ({
  analyzeForCI: vi.fn(),
}));

const mockStore = vi.hoisted(() => ({
  close: vi.fn(),
  getCache: vi.fn().mockReturnValue(undefined),
  setCache: vi.fn(),
}));
vi.mock("../storage/loader.js", () => ({
  openGraphStore: vi.fn().mockResolvedValue(mockStore),
}));

const { execFileSync } = await import("node:child_process");
const { detectContext } = await import("../core/detect/detect.js");
const { buildGraphWithCache } = await import("../core/graph/cache.js");
const { runAnalysis } = await import("../core/run-analysis.js");
const { loadConfig } = await import("../core/config/config.js");
const { analyzeForCI } = await import("../core/analysis/ci.js");
const { runCiMode } = await import("../cli/ci.js");

const mockExecFileSync = vi.mocked(execFileSync);
const mockDetectContext = vi.mocked(detectContext);
const mockBuildGraphWithCache = vi.mocked(buildGraphWithCache);
const mockRunAnalysis = vi.mocked(runAnalysis);
const mockLoadConfig = vi.mocked(loadConfig);
const mockAnalyzeForCI = vi.mocked(analyzeForCI);

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

// ── File resolution ───────────────────────────────────────────────────

describe("runCiMode — file resolution", () => {
  it("returns empty result early when no files and no git output", async () => {
    mockExecFileSync.mockReturnValue("" as unknown as string);
    const result = await runCiMode(ROOT, [], undefined, false);
    expect(result.filesAnalyzed).toBe(0);
    expect(result.hasFindings).toBe(false);
  });

  it("uses explicit files when provided, skipping git diff", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    await runCiMode(ROOT, ["src/a.ts"], undefined, false);
    expect(mockExecFileSync).not.toHaveBeenCalled();
    expect(mockAnalyzeForCI).toHaveBeenCalled();
  });

  it("runs git diff against HEAD when no files and no base ref", async () => {
    mockExecFileSync.mockReturnValue("src/a.ts\n" as unknown as string);
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    await runCiMode(ROOT, null, undefined, false);
    expect(mockExecFileSync).toHaveBeenCalledWith("git", expect.arrayContaining(["HEAD"]), expect.any(Object));
  });

  it("uses custom base ref when provided", async () => {
    mockExecFileSync.mockReturnValue("src/a.ts\n" as unknown as string);
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    await runCiMode(ROOT, null, "main", false);
    expect(mockExecFileSync).toHaveBeenCalledWith("git", expect.arrayContaining(["main"]), expect.any(Object));
  });

  it("falls back to HEAD when custom base ref git diff fails", async () => {
    let callCount = 0;
    mockExecFileSync.mockImplementation((..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) throw new Error("ref not found");
      return "src/a.ts\n";
    });
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    await runCiMode(ROOT, null, "missing-branch", false);
    expect(mockExecFileSync).toHaveBeenCalledTimes(2);
    // Second call should be against HEAD
    expect(mockExecFileSync).toHaveBeenLastCalledWith("git", expect.arrayContaining(["HEAD"]), expect.any(Object));
  });

  it("returns empty result when HEAD git diff also fails", async () => {
    mockExecFileSync.mockImplementation((..._args: unknown[]) => {
      throw new Error("not a git repo");
    });
    const result = await runCiMode(ROOT, null, "main", false);
    expect(result.filesAnalyzed).toBe(0);
  });

  it("returns empty result when git output is empty string", async () => {
    mockExecFileSync.mockReturnValue("   " as unknown as string);
    const result = await runCiMode(ROOT, null, undefined, false);
    expect(result.filesAnalyzed).toBe(0);
  });
});

// ── Source file filtering ─────────────────────────────────────────────

describe("runCiMode — source file filtering", () => {
  it("filters out non-source files not in the graph", async () => {
    // Only "src/a.ts" exists in the graph; "README.md" does not
    const graph = makeImportGraph([], ["src/a.ts"]);
    mockBuildGraphWithCache.mockResolvedValue(graph);
    await runCiMode(ROOT, ["src/a.ts", "README.md"], undefined, false);
    const [, sourceFiles] = mockAnalyzeForCI.mock.calls[0];
    expect(sourceFiles).toContain("src/a.ts");
    expect(sourceFiles).not.toContain("README.md");
  });
});
