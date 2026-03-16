import { errorMessage } from "./utils.js";
import { filterAliveGitActivity } from "./git/filter-alive.js";
import {
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  ANALYSIS_CACHE_VERSION,
  type AnalysisCacheData,
} from "./graph/cache.js";
import { findCircularDeps } from "./graph/cycles.js";
import { getHubFiles } from "./graph/hub-files.js";
import { detectArchitecturalLayers, computeLayerConsistency } from "./graph/layers.js";
import { computeInstability } from "./graph/instability.js";
import { detectCommunities } from "./graph/communities.js";
import { findDeadFiles, readPackageEntryPoints } from "./graph/dead-files.js";
import { findCrossCuttingFiles } from "./graph/cross-cutting.js";
import { findChokepoints } from "./graph/chokepoints.js";
import { computeGraphTopology } from "./graph/topology.js";
import { findStructuralTemporalMismatches } from "./graph/mismatches.js";
import { findTightCouplings } from "./graph/tight-coupling.js";
import { checkArchitecturalFitness } from "./graph/fitness.js";
import { analyzeGitActivity } from "./git/analysis.js";
import { analyzeMonorepoGraph, computePackageCentrality } from "./analysis/monorepo.js";
import { scanConfigConstraints } from "./config/scan.js";
import { inferConventions } from "./conventions/conventions.js";
import { buildTestMapping } from "./analysis/test-map.js";
import { predictChangeImpact } from "./analysis/change-impact.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  renderDeltaSection,
} from "./analysis/delta.js";
import {
  computeProjectCacheKey,
  loadProjectCache,
  saveProjectCache,
  buildProjectCachePayload,
  hydrateProjectCache,
} from "./project-cache.js";
import {
  computeGitCacheKey,
  loadGitCache,
  saveGitCache,
  buildGitCachePayload,
  hydrateGitCache,
  type GitCacheData,
} from "./git-cache.js";
import type { GraphStore } from "../storage/graph-store.js";
import type {
  ConfigConstraints,
  ContextAnalysis,
  DetectedContext,
  HubFile,
  ImportGraph,
  InferredConventions,
  MonorepoAnalysis,
  PackageHubFile,
  ProgressCallback,
  ProjectConfig,
  TestMapping,
} from "./types.js";
import type { GraphPhaseResult, LogCtx, PhaseTiming, ProjectPhaseResult } from "./types/internal.js";
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
} from "./phase-logger.js";

export interface AnalysisResult {
  analysis: ContextAnalysis;
  deltaSection: string | null;
  timing: PhaseTiming;
}

export async function runAnalysis(
  rootDir: string,
  graph: ImportGraph,
  detected: DetectedContext,
  savedConfig: ProjectConfig | null,
  verbose: boolean,
  jsonMode: boolean,
  verboseLog: ProgressCallback,
  noopProgress: ProgressCallback,
  store?: GraphStore,
): Promise<AnalysisResult> {
  const totalStart = performance.now();
  const analysisDays = savedConfig?.analysisDays ?? 90;
  const analysisCacheKey = computeAnalysisCacheKey(graph, savedConfig?.layers);
  const analysisCache = await loadAnalysisCache(rootDir);
  const useGraphCache = analysisCache !== null && analysisCache.cacheKey === analysisCacheKey;
  const log: LogCtx = { jsonMode, verbose };

  // Phase 1: Graph analysis (sync, cacheable)
  const graphStart = performance.now();
  const entryPoints = readPackageEntryPoints(rootDir);
  const graphResults = runGraphPhase(graph, savedConfig, useGraphCache ? analysisCache : null, log, entryPoints);
  const graphPhaseMs = performance.now() - graphStart;

  // Load project cache + git cache key
  const projectCacheKey = await computeProjectCacheKey(rootDir, graph, detected);
  const gitCacheKey = computeGitCacheKey(rootDir, analysisDays);
  const projectCache = store ? loadProjectCache(store) : null;
  const gitCache = store ? loadGitCache(store) : null;
  const useProjectCache = projectCache !== null && projectCache.cacheKey === projectCacheKey;
  const validGitCache = gitCacheKey && gitCache && gitCache.cacheKey === gitCacheKey ? gitCache : null;

  // Parallel group: git + cacheable project sub-analyses
  const parallelStart = performance.now();

  const gitPromise = runGitPhase(
    rootDir,
    detected,
    analysisDays,
    verbose ? verboseLog : noopProgress,
    log,
    gitCacheKey,
    validGitCache,
    store,
  );
  const projectPromise = runCacheableProjectPhase(rootDir, graph, detected, useProjectCache ? projectCache : null, log);

  const [{ gitActivity, gitCacheHit }, cacheableProject] = await Promise.all([gitPromise, projectPromise]);
  const parallelGroupMs = performance.now() - parallelStart;

  // Git-dependent work (fast pure computation, runs after parallel group)
  const gitPhaseMs = parallelGroupMs; // git overlapped with project
  const projectStart = performance.now();

  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;

  const changeImpact = computeChangeImpactForHubs(graphResults.hubFiles, graph, gitActivity);

  const projectPhaseMs = performance.now() - projectStart + (useProjectCache ? 0 : cacheableProject.computeMs);

  const projectResults: ProjectPhaseResult = {
    configConstraints: cacheableProject.configConstraints,
    conventions: cacheableProject.conventions ?? undefined,
    testMapping: cacheableProject.testMapping ?? undefined,
    structuralMismatches: structuralMismatches?.length ? structuralMismatches : undefined,
    monorepoAnalysis: cacheableProject.monorepoAnalysis,
    changeImpact,
  };

  // Save project cache on miss
  if (!useProjectCache && store) {
    try {
      saveProjectCache(
        store,
        buildProjectCachePayload(
          projectCacheKey,
          cacheableProject.configConstraints,
          cacheableProject.conventions,
          cacheableProject.testMapping,
          cacheableProject.monorepoAnalysis,
        ),
      );
    } catch (err) {
      if (!jsonMode) verboseLog(`Warning: project cache save failed: ${errorMessage(err)}`);
    }
  }

  const analysis: ContextAnalysis = {
    ...graphResults,
    gitActivity,
    ...projectResults,
    analysisDays,
  };

  if (!useGraphCache) {
    try {
      await saveAnalysisCache(rootDir, {
        version: ANALYSIS_CACHE_VERSION,
        cacheKey: analysisCacheKey,
        hubFiles: graphResults.hubFiles,
        circularDeps: graphResults.circularDeps,
        layers: graphResults.layers,
        layerEdges: graphResults.layerEdges,
        instabilities: graphResults.instabilities,
        communities: graphResults.communities,
        deadFiles: graphResults.deadFiles,
        crossCuttingFiles: graphResults.crossCuttingFiles ?? [],
        layerConsistency: graphResults.layerConsistency,
        chokepoints: graphResults.chokepoints,
        tightCouplings: graphResults.tightCouplings ?? [],
        graphTopology: graphResults.graphTopology,
      });
    } catch (err) {
      if (!jsonMode) verboseLog(`Warning: analysis cache save failed: ${errorMessage(err)}`);
    }
  }

  const deltaStart = performance.now();
  const deltaSection = store ? runDeltaPhase(store, analysis, log) : null;
  const deltaPhaseMs = performance.now() - deltaStart;

  const totalMs = performance.now() - totalStart;

  const timing: PhaseTiming = {
    graphPhaseMs: Math.round(graphPhaseMs),
    gitPhaseMs: Math.round(gitPhaseMs),
    projectPhaseMs: Math.round(projectPhaseMs),
    deltaPhaseMs: Math.round(deltaPhaseMs),
    totalMs: Math.round(totalMs),
    graphCacheHit: useGraphCache,
    projectCacheHit: useProjectCache,
    gitCacheHit,
    parallelGroupMs: Math.round(parallelGroupMs),
  };

  if (verbose && !jsonMode) {
    const graphLabel = useGraphCache ? "cached" : "computed";
    const projectLabel = useProjectCache ? "cached" : "computed";
    const gitLabel = gitCacheHit ? "cached" : "computed";
    verboseLog(
      `Phase timing: graph=${timing.graphPhaseMs}ms(${graphLabel}) git=${timing.gitPhaseMs}ms(${gitLabel}) project=${timing.projectPhaseMs}ms(${projectLabel}) delta=${timing.deltaPhaseMs}ms total=${timing.totalMs}ms`,
    );
  }

  return { analysis, deltaSection, timing };
}

// ---------------------------------------------------------------------------
// Phase 1: Graph analysis (cacheable, pure computation)
// ---------------------------------------------------------------------------

function runGraphPhase(
  graph: ImportGraph,
  savedConfig: ProjectConfig | null,
  cache: AnalysisCacheData | null,
  log: LogCtx,
  entryPoints: string[] = [],
): GraphPhaseResult {
  const hubFiles = cache ? cache.hubFiles : getHubFiles(graph);
  logHubFiles(hubFiles, log);

  const circularDeps = cache ? cache.circularDeps : findCircularDeps(graph);
  logCircularDeps(circularDeps, log);

  const { layers, layerEdges } = cache
    ? { layers: cache.layers, layerEdges: cache.layerEdges }
    : detectArchitecturalLayers(graph, savedConfig?.layers);
  logLayers(layers, log);

  const instabilities = cache ? cache.instabilities : computeInstability(graph);
  logInstabilities(instabilities, log);

  const communities = cache ? cache.communities : detectCommunities(graph);
  logCommunities(communities, log);

  const deadFiles = cache ? cache.deadFiles : findDeadFiles(graph, entryPoints);
  logDeadFiles(deadFiles, log);

  const crossCuttingFiles = cache ? cache.crossCuttingFiles : findCrossCuttingFiles(graph, layers);
  logCrossCuttingFiles(crossCuttingFiles, log);

  const layerConsistency = cache
    ? cache.layerConsistency
    : layers.length >= 2
      ? computeLayerConsistency(graph, layers, layerEdges)
      : undefined;
  logLayerConsistency(layerConsistency, log);

  const chokepoints = cache ? cache.chokepoints : findChokepoints(graph);
  logChokepoints(chokepoints, log);

  const graphTopology = cache ? cache.graphTopology : computeGraphTopology(graph);
  logTopology(graphTopology, log);

  const tightCouplings = cache ? cache.tightCouplings : findTightCouplings(graph);
  const archViolations = layers.length >= 2 ? checkArchitecturalFitness(graph, layers, layerEdges) : [];

  return {
    hubFiles,
    circularDeps,
    layers,
    layerEdges,
    instabilities,
    communities,
    deadFiles,
    crossCuttingFiles,
    layerConsistency,
    chokepoints,
    graphTopology,
    tightCouplings: tightCouplings.length ? tightCouplings : undefined,
    archViolations: archViolations.length ? archViolations : undefined,
  };
}

// ---------------------------------------------------------------------------
// Phase 2: Git analysis
// ---------------------------------------------------------------------------

async function runGitPhase(
  rootDir: string,
  detected: DetectedContext,
  analysisDays: number,
  onProgress: ProgressCallback,
  log: LogCtx,
  gitCacheKey: string | null,
  gitCache: GitCacheData | null,
  store?: GraphStore,
): Promise<{ gitActivity: ContextAnalysis["gitActivity"]; gitCacheHit: boolean }> {
  let gitActivity: ContextAnalysis["gitActivity"];
  let gitCacheHit = false;

  if (gitCache) {
    gitActivity = hydrateGitCache(gitCache);
    gitCacheHit = true;
  } else {
    gitActivity = detected.isGitRepo ? await analyzeGitActivity(rootDir, onProgress, analysisDays) : null;
  }

  // Save unfiltered result on cache miss before filterAlive mutates it
  if (!gitCacheHit && gitActivity && gitCacheKey && store) {
    try {
      saveGitCache(store, buildGitCachePayload(gitCacheKey, gitActivity));
    } catch {
      // Non-fatal: cache save failure should not block analysis
    }
  }

  if (gitActivity) {
    await filterAliveGitActivity(rootDir, gitActivity);
  }

  logGitActivity(gitActivity, analysisDays, log);

  return { gitActivity, gitCacheHit };
}

// ---------------------------------------------------------------------------
// Phase 3a: Cacheable project sub-analyses (parallel with git)
// ---------------------------------------------------------------------------

interface CacheableProjectResult {
  configConstraints: ConfigConstraints | undefined;
  conventions: InferredConventions | null;
  testMapping: TestMapping | null;
  monorepoAnalysis: MonorepoAnalysis | undefined;
  /** Wall-clock ms spent computing (0 on cache hit) */
  computeMs: number;
}

async function runCacheableProjectPhase(
  rootDir: string,
  graph: ImportGraph,
  detected: DetectedContext,
  cache: import("./project-cache.js").ProjectCacheData | null,
  log: LogCtx,
): Promise<CacheableProjectResult> {
  // Cache hit: hydrate and return
  if (cache) {
    const hydrated = hydrateProjectCache(cache);
    if (hydrated.configConstraints) logConfigConstraints(hydrated.configConstraints, log);
    logConventions(hydrated.conventions, log);
    logTestMapping(hydrated.testMapping, log);
    logMonorepoAnalysis(hydrated.monorepoAnalysis, log);
    return {
      configConstraints: hydrated.configConstraints,
      conventions: hydrated.conventions ?? null,
      testMapping: hydrated.testMapping ?? null,
      monorepoAnalysis: hydrated.monorepoAnalysis,
      computeMs: 0,
    };
  }

  // Cache miss: compute in parallel where possible
  const start = performance.now();

  // These can run concurrently: config scan, test mapping, monorepo analysis
  const [configConstraints, testMapping, monorepoAnalysis] = await Promise.all([
    scanConfigConstraints(rootDir, detected),
    Promise.resolve(buildTestMapping(graph, detected)),
    detected.monorepo ? analyzeMonorepoGraph(rootDir, graph, detected.monorepo) : Promise.resolve(undefined),
  ]);

  logConfigConstraints(configConstraints, log);
  logTestMapping(testMapping, log);

  // Conventions chains after configConstraints (needs it as input)
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  logConventions(conventions, log);

  // Attach package hub files to monorepo analysis
  if (monorepoAnalysis && detected.monorepo) {
    monorepoAnalysis.packageHubFiles = computePackageHubFiles(graph, detected.monorepo.packages);
  }
  logMonorepoAnalysis(monorepoAnalysis, log);

  return {
    configConstraints,
    conventions,
    testMapping,
    monorepoAnalysis,
    computeMs: performance.now() - start,
  };
}

// ---------------------------------------------------------------------------
// Phase 3b: Git-dependent helpers
// ---------------------------------------------------------------------------

/**
 * Compute change impact predictions for the top hub files.
 */
function computeChangeImpactForHubs(
  hubFiles: HubFile[],
  graph: ImportGraph,
  gitActivity: ContextAnalysis["gitActivity"],
): Map<string, Array<{ file: string; score: number }>> | undefined {
  if (hubFiles.length === 0) return undefined;

  const topHubs = hubFiles
    .slice()
    .sort((a, b) => b.authority - a.authority || a.path.localeCompare(b.path))
    .slice(0, 5);

  const impactMap = new Map<string, Array<{ file: string; score: number }>>();
  for (const hub of topHubs) {
    const predictions = predictChangeImpact(hub.path, graph, gitActivity);
    if (predictions.length > 0) {
      impactMap.set(hub.path, predictions);
    }
  }

  return impactMap.size > 0 ? impactMap : undefined;
}

/**
 * Compute per-package hub files from HITS centrality.
 */
function computePackageHubFiles(
  graph: ImportGraph,
  packages: Array<{ name: string; path: string }>,
): Map<string, PackageHubFile[]> {
  const packageHubFiles = new Map<string, PackageHubFile[]>();
  for (const pkg of packages) {
    const { authority } = computePackageCentrality(graph, pkg.path);
    const topFiles = [...authority.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .filter(([, score]) => score > 0)
      .map(([filePath, score]) => ({ path: filePath, authority: score }));
    if (topFiles.length > 0) {
      packageHubFiles.set(pkg.name, topFiles);
    }
  }
  return packageHubFiles;
}

// ---------------------------------------------------------------------------
// Phase 4: Delta detection
// ---------------------------------------------------------------------------

function runDeltaPhase(store: GraphStore, analysis: ContextAnalysis, log: LogCtx): string | null {
  const currentAnalysisSnapshot = extractSnapshot(analysis);
  const prevSnapshot = loadPreviousSnapshot(store);
  let deltaSection: string | null = null;

  if (prevSnapshot) {
    const delta = computeDelta(prevSnapshot, currentAnalysisSnapshot);
    if (!isDeltaEmpty(delta)) {
      deltaSection = renderDeltaSection(delta);
      logDelta(deltaSection, log);
    }
  }

  try {
    saveSnapshot(store, currentAnalysisSnapshot);
  } catch (err) {
    if (!log.jsonMode && log.verbose) console.error(`[clarte] snapshot save failed: ${errorMessage(err)}`);
  }

  return deltaSection;
}
