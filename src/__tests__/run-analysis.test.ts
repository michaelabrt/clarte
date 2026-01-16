import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeDetectedContext } from "./helpers/mocks.js";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("@clack/prompts", async () => {
  const { createClackMock } = await import("./helpers/mocks.js");
  return createClackMock().mock;
});

vi.mock("../theme.js", async () => {
  const { THEME_MOCK } = await import("./helpers/mocks.js");
  return { theme: THEME_MOCK };
});

const mockFileExists = vi.fn().mockResolvedValue(true);
vi.mock("../utils.js", () => ({
  fileExists: (...args: unknown[]) => mockFileExists(...args),
}));

// Cache mocks
const mockComputeAnalysisCacheKey = vi.fn().mockReturnValue("cache-key-123");
const mockLoadAnalysisCache = vi.fn().mockResolvedValue(null);
const mockSaveAnalysisCache = vi.fn().mockResolvedValue(undefined);

vi.mock("../graph/cache.js", () => ({
  computeAnalysisCacheKey: (...args: unknown[]) => mockComputeAnalysisCacheKey(...args),
  loadAnalysisCache: (...args: unknown[]) => mockLoadAnalysisCache(...args),
  saveAnalysisCache: (...args: unknown[]) => mockSaveAnalysisCache(...args),
  ANALYSIS_CACHE_VERSION: 1,
}));

// Analysis function mocks
const mockGetHubFiles = vi.fn().mockReturnValue([]);
const mockFindCircularDeps = vi.fn().mockReturnValue([]);
const mockDetectArchitecturalLayers = vi.fn().mockReturnValue({ layers: [], layerEdges: [] });
const mockComputeLayerConsistency = vi.fn();
const mockComputeInstability = vi.fn().mockReturnValue([]);
const mockDetectCommunities = vi.fn().mockReturnValue([]);
const mockFindDeadFiles = vi.fn().mockReturnValue([]);
const mockFindCrossCuttingFiles = vi.fn().mockReturnValue([]);
const mockFindChokepoints = vi.fn().mockReturnValue([]);
const mockComputeGraphTopology = vi.fn().mockReturnValue({
  isFragmented: false,
  componentCount: 1,
  componentSizes: [10],
  approximateDiameter: 3,
});
const mockFindStructuralTemporalMismatches = vi.fn().mockReturnValue([]);
const mockFindTightCouplings = vi.fn().mockReturnValue([]);
const mockAnalyzeGitActivity = vi.fn().mockResolvedValue({
  hotFiles: [{ path: "src/index.ts", commits: 10, lastChanged: "1d ago" }],
  changeCoupling: [],
  lagCouplings: [],
});
const mockAnalyzeMonorepoGraph = vi.fn().mockResolvedValue({
  crossPackageEdges: [],
  encapsulationViolations: [],
});
const mockComputePackageCentrality = vi.fn().mockReturnValue({ authority: new Map() });
const mockScanConfigConstraints = vi.fn().mockResolvedValue({});
const mockInferConventions = vi.fn().mockResolvedValue(null);
const mockBuildTestMapping = vi.fn().mockReturnValue(null);
const mockPredictChangeImpact = vi.fn().mockReturnValue([]);
const mockExtractSnapshot = vi.fn().mockReturnValue({});
const mockLoadPreviousSnapshot = vi.fn().mockResolvedValue(null);
const mockSaveSnapshot = vi.fn().mockResolvedValue(undefined);
const mockComputeDelta = vi.fn().mockReturnValue({});
const mockIsDeltaEmpty = vi.fn().mockReturnValue(true);
const mockRenderDeltaSection = vi.fn().mockReturnValue(null);

vi.mock("../graph/cycles.js", () => ({
  findCircularDeps: (...args: unknown[]) => mockFindCircularDeps(...args),
}));
vi.mock("../graph/hub-files.js", () => ({
  getHubFiles: (...args: unknown[]) => mockGetHubFiles(...args),
}));
vi.mock("../graph/layers.js", () => ({
  detectArchitecturalLayers: (...args: unknown[]) => mockDetectArchitecturalLayers(...args),
  computeLayerConsistency: (...args: unknown[]) => mockComputeLayerConsistency(...args),
}));
vi.mock("../graph/instability.js", () => ({
  computeInstability: (...args: unknown[]) => mockComputeInstability(...args),
  INSTABILITY_THRESHOLD: 0.8,
}));
vi.mock("../graph/communities.js", () => ({
  detectCommunities: (...args: unknown[]) => mockDetectCommunities(...args),
}));
vi.mock("../graph/dead-files.js", () => ({
  findDeadFiles: (...args: unknown[]) => mockFindDeadFiles(...args),
}));
vi.mock("../graph/cross-cutting.js", () => ({
  findCrossCuttingFiles: (...args: unknown[]) => mockFindCrossCuttingFiles(...args),
}));
vi.mock("../graph/chokepoints.js", () => ({
  findChokepoints: (...args: unknown[]) => mockFindChokepoints(...args),
}));
vi.mock("../graph/topology.js", () => ({
  computeGraphTopology: (...args: unknown[]) => mockComputeGraphTopology(...args),
}));
vi.mock("../graph/mismatches.js", () => ({
  findStructuralTemporalMismatches: (...args: unknown[]) => mockFindStructuralTemporalMismatches(...args),
}));
vi.mock("../graph/tight-coupling.js", () => ({
  findTightCouplings: (...args: unknown[]) => mockFindTightCouplings(...args),
}));
vi.mock("../git/analysis.js", () => ({
  analyzeGitActivity: (...args: unknown[]) => mockAnalyzeGitActivity(...args),
}));
vi.mock("../analysis/monorepo.js", () => ({
  analyzeMonorepoGraph: (...args: unknown[]) => mockAnalyzeMonorepoGraph(...args),
  computePackageCentrality: (...args: unknown[]) => mockComputePackageCentrality(...args),
}));
vi.mock("../config/scan.js", () => ({
  scanConfigConstraints: (...args: unknown[]) => mockScanConfigConstraints(...args),
}));
vi.mock("../conventions/conventions.js", () => ({
  inferConventions: (...args: unknown[]) => mockInferConventions(...args),
}));
vi.mock("../analysis/test-map.js", () => ({
  buildTestMapping: (...args: unknown[]) => mockBuildTestMapping(...args),
}));
vi.mock("../analysis/change-impact.js", () => ({
  predictChangeImpact: (...args: unknown[]) => mockPredictChangeImpact(...args),
}));
vi.mock("../analysis/delta.js", () => ({
  extractSnapshot: (...args: unknown[]) => mockExtractSnapshot(...args),
  loadPreviousSnapshot: (...args: unknown[]) => mockLoadPreviousSnapshot(...args),
  saveSnapshot: (...args: unknown[]) => mockSaveSnapshot(...args),
  computeDelta: (...args: unknown[]) => mockComputeDelta(...args),
  isDeltaEmpty: (...args: unknown[]) => mockIsDeltaEmpty(...args),
  renderDeltaSection: (...args: unknown[]) => mockRenderDeltaSection(...args),
}));

// ── Import under test (after mocks) ────────────────────────────────

import { runAnalysis } from "../core/run-analysis.js";
import type { ImportGraph } from "../types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeGraph(edgeCount = 0): ImportGraph {
  return {
    edges: Array(edgeCount).fill({ from: "a.ts", to: "b.ts", importedNames: [] }),
    inDegree: new Map(),
    centrality: new Map([["src/a.ts", 0.5]]),
    externalImportCounts: new Map(),
    authority: new Map(),
    hubScores: new Map(),
  };
}

const makeDetected = makeDetectedContext;

const noopProgress = () => {};

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLoadAnalysisCache.mockResolvedValue(null);
  mockAnalyzeGitActivity.mockResolvedValue({
    hotFiles: [{ path: "src/index.ts", commits: 10, lastChanged: "1d ago" }],
    changeCoupling: [],
    lagCouplings: [],
  });
});

describe("runAnalysis", () => {
  it("returns a complete ContextAnalysis on cache miss", async () => {
    const { analysis } = await runAnalysis(
      "/tmp/test",
      makeGraph(5),
      makeDetected(),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(analysis.hubFiles).toBeDefined();
    expect(analysis.circularDeps).toBeDefined();
    expect(analysis.layers).toBeDefined();
    expect(analysis.layerEdges).toBeDefined();
    expect(analysis.instabilities).toBeDefined();
    expect(analysis.communities).toBeDefined();
    expect(analysis.deadFiles).toBeDefined();
    expect(analysis.configConstraints).toBeDefined();
    expect(analysis.graphTopology).toBeDefined();
    expect(analysis.analysisDays).toBe(90);
  });

  it("calls all analysis functions on cache miss", async () => {
    await runAnalysis("/tmp/test", makeGraph(), makeDetected(), null, false, true, noopProgress, noopProgress);

    expect(mockGetHubFiles).toHaveBeenCalled();
    expect(mockFindCircularDeps).toHaveBeenCalled();
    expect(mockDetectArchitecturalLayers).toHaveBeenCalled();
    expect(mockComputeInstability).toHaveBeenCalled();
    expect(mockDetectCommunities).toHaveBeenCalled();
    expect(mockFindDeadFiles).toHaveBeenCalled();
    expect(mockFindCrossCuttingFiles).toHaveBeenCalled();
    expect(mockFindChokepoints).toHaveBeenCalled();
    expect(mockComputeGraphTopology).toHaveBeenCalled();
    expect(mockFindTightCouplings).toHaveBeenCalled();
  });

  it("uses cached values on cache hit", async () => {
    const cachedHubFiles = [{ path: "cached.ts", authority: 1, hubScore: 0.5, role: "Foundation" }];
    const cachedCircularDeps = [{ chain: ["a.ts", "b.ts", "a.ts"] }];

    mockLoadAnalysisCache.mockResolvedValue({
      cacheKey: "cache-key-123",
      hubFiles: cachedHubFiles,
      circularDeps: cachedCircularDeps,
      layers: [],
      layerEdges: [],
      instabilities: [],
      communities: [],
      deadFiles: [],
      crossCuttingFiles: [],
      chokepoints: [],
      tightCouplings: [],
      graphTopology: { isFragmented: false, componentCount: 1, componentSizes: [5], approximateDiameter: 2 },
    });

    const { analysis } = await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected(),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    // Should use cached values
    expect(analysis.hubFiles).toBe(cachedHubFiles);
    expect(analysis.circularDeps).toBe(cachedCircularDeps);

    // Should NOT call the expensive computations
    expect(mockGetHubFiles).not.toHaveBeenCalled();
    expect(mockFindCircularDeps).not.toHaveBeenCalled();
    expect(mockDetectArchitecturalLayers).not.toHaveBeenCalled();
    expect(mockComputeInstability).not.toHaveBeenCalled();
  });

  it("calls analyzeGitActivity when isGitRepo=true", async () => {
    await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected({ isGitRepo: true }),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(mockAnalyzeGitActivity).toHaveBeenCalledWith("/tmp/test", expect.any(Function), 90);
  });

  it("skips analyzeGitActivity when isGitRepo=false", async () => {
    const { analysis } = await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected({ isGitRepo: false }),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(mockAnalyzeGitActivity).not.toHaveBeenCalled();
    expect(analysis.gitActivity).toBeNull();
  });

  it("filters dead files from git activity results", async () => {
    mockAnalyzeGitActivity.mockResolvedValue({
      hotFiles: [
        { path: "src/alive.ts", commits: 5, lastChanged: "1d ago" },
        { path: "src/deleted.ts", commits: 3, lastChanged: "2d ago" },
      ],
      changeCoupling: [{ fileA: "src/alive.ts", fileB: "src/deleted.ts", coChanges: 3, confidence: 0.5 }],
      lagCouplings: [],
    });
    // alive.ts exists, deleted.ts does not
    mockFileExists.mockImplementation(async (p: string) => !p.includes("deleted"));

    const { analysis } = await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected(),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(analysis.gitActivity!.hotFiles).toHaveLength(1);
    expect(analysis.gitActivity!.hotFiles[0].path).toBe("src/alive.ts");
    expect(analysis.gitActivity!.changeCoupling).toHaveLength(0);
  });

  it("calls monorepo analysis when monorepo is detected", async () => {
    const monorepo = {
      type: "npm" as const,
      packages: [{ name: "core", path: "packages/core" }],
    };

    await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected({ monorepo }),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(mockAnalyzeMonorepoGraph).toHaveBeenCalled();
    expect(mockComputePackageCentrality).toHaveBeenCalled();
  });

  it("skips monorepo analysis when no monorepo", async () => {
    await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected({ monorepo: null }),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(mockAnalyzeMonorepoGraph).not.toHaveBeenCalled();
  });

  it("saves analysis cache on cache miss", async () => {
    await runAnalysis("/tmp/test", makeGraph(), makeDetected(), null, false, true, noopProgress, noopProgress);

    expect(mockSaveAnalysisCache).toHaveBeenCalledWith(
      "/tmp/test",
      expect.objectContaining({
        cacheKey: "cache-key-123",
      }),
    );
  });

  it("does not save cache on cache hit", async () => {
    mockLoadAnalysisCache.mockResolvedValue({
      cacheKey: "cache-key-123",
      hubFiles: [],
      circularDeps: [],
      layers: [],
      layerEdges: [],
      instabilities: [],
      communities: [],
      deadFiles: [],
      crossCuttingFiles: [],
      chokepoints: [],
      tightCouplings: [],
      graphTopology: { isFragmented: false, componentCount: 1, componentSizes: [5], approximateDiameter: 2 },
    });

    await runAnalysis("/tmp/test", makeGraph(), makeDetected(), null, false, true, noopProgress, noopProgress);

    expect(mockSaveAnalysisCache).not.toHaveBeenCalled();
  });

  it("does not throw when cache save fails", async () => {
    mockSaveAnalysisCache.mockRejectedValue(new Error("disk full"));

    await expect(
      runAnalysis("/tmp/test", makeGraph(), makeDetected(), null, false, true, noopProgress, noopProgress),
    ).resolves.toBeDefined();
  });

  it("uses analysisDays from config", async () => {
    await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected(),
      { analysisDays: 30 } as never,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(mockAnalyzeGitActivity).toHaveBeenCalledWith("/tmp/test", expect.any(Function), 30);
  });

  it("returns delta section when previous snapshot exists and delta is non-empty", async () => {
    mockLoadPreviousSnapshot.mockResolvedValue({ some: "snapshot" });
    mockIsDeltaEmpty.mockReturnValue(false);
    mockRenderDeltaSection.mockReturnValue("- Added 2 hub files\n- Removed 1 cycle");

    const { deltaSection } = await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected(),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(deltaSection).toContain("Added 2 hub files");
    expect(mockSaveSnapshot).toHaveBeenCalled();
  });

  it("returns null delta when no previous snapshot", async () => {
    mockLoadPreviousSnapshot.mockResolvedValue(null);

    const { deltaSection } = await runAnalysis(
      "/tmp/test",
      makeGraph(),
      makeDetected(),
      null,
      false,
      true,
      noopProgress,
      noopProgress,
    );

    expect(deltaSection).toBeNull();
  });
});
