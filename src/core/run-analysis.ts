import { filterAliveGitActivity } from "../git/filter-alive.js";
import {
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  ANALYSIS_CACHE_VERSION,
  type AnalysisCacheData,
} from "../graph/cache.js";
import { findCircularDeps } from "../graph/cycles.js";
import { getHubFiles } from "../graph/hub-files.js";
import { detectArchitecturalLayers, computeLayerConsistency } from "../graph/layers.js";
import { computeInstability } from "../graph/instability.js";
import { detectCommunities } from "../graph/communities.js";
import { findDeadFiles, readPackageEntryPoints } from "../graph/dead-files.js";
import { findCrossCuttingFiles } from "../graph/cross-cutting.js";
import { findChokepoints } from "../graph/chokepoints.js";
import { computeGraphTopology } from "../graph/topology.js";
import { findStructuralTemporalMismatches } from "../graph/mismatches.js";
import { findTightCouplings } from "../graph/tight-coupling.js";
import { checkArchitecturalFitness } from "../graph/fitness.js";
import { analyzeGitActivity } from "../git/analysis.js";
import { analyzeMonorepoGraph, computePackageCentrality } from "../analysis/monorepo.js";
import { scanConfigConstraints } from "../config/scan.js";
import { inferConventions } from "../conventions/conventions.js";
import { buildTestMapping } from "../analysis/test-map.js";
import { predictChangeImpact } from "../analysis/change-impact.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  renderDeltaSection,
} from "../analysis/delta.js";
import type {
  ContextAnalysis,
  DetectedContext,
  ImportGraph,
  PackageHubFile,
  ProgressCallback,
  ProjectConfig,
} from "../types.js";
import type { GraphPhaseResult, LogCtx, ProjectPhaseResult } from "../types/internal.js";
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
): Promise<AnalysisResult> {
  const analysisDays = savedConfig?.analysisDays ?? 90;
  const analysisCacheKey = computeAnalysisCacheKey(graph, savedConfig?.layers);
  const analysisCache = await loadAnalysisCache(rootDir);
  const useCache = analysisCache !== null && analysisCache.cacheKey === analysisCacheKey;
  const log: LogCtx = { jsonMode, verbose };

  const entryPoints = readPackageEntryPoints(rootDir);
  const graphResults = runGraphPhase(graph, savedConfig, useCache ? analysisCache : null, log, entryPoints);

  const gitActivity = await runGitPhase(rootDir, detected, analysisDays, verbose ? verboseLog : noopProgress, log);

  const projectResults = await runProjectPhase(rootDir, graph, detected, graphResults, gitActivity, log);

  const analysis: ContextAnalysis = {
    ...graphResults,
    gitActivity,
    ...projectResults,
    analysisDays,
  };

  if (!useCache) {
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
      if (!jsonMode)
        verboseLog(`Warning: analysis cache save failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const deltaSection = await runDeltaPhase(rootDir, analysis, log);

  return { analysis, deltaSection };
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
): Promise<ContextAnalysis["gitActivity"]> {
  const gitActivity = detected.isGitRepo ? await analyzeGitActivity(rootDir, onProgress, analysisDays) : null;

  if (gitActivity) {
    await filterAliveGitActivity(rootDir, gitActivity);
  }

  logGitActivity(gitActivity, analysisDays, log);

  return gitActivity;
}

// ---------------------------------------------------------------------------
// Phase 3: Project analysis (config, conventions, tests, monorepo, impact)
// ---------------------------------------------------------------------------

async function runProjectPhase(
  rootDir: string,
  graph: ImportGraph,
  detected: DetectedContext,
  graphResults: GraphPhaseResult,
  gitActivity: ContextAnalysis["gitActivity"],
  log: LogCtx,
): Promise<ProjectPhaseResult> {
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  logConfigConstraints(configConstraints, log);

  const conventions = await inferConventions(rootDir, graph, configConstraints);
  logConventions(conventions, log);

  const testMapping = buildTestMapping(graph, detected);
  logTestMapping(testMapping, log);

  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;

  const monorepoAnalysis = detected.monorepo
    ? await analyzeMonorepoGraph(rootDir, graph, detected.monorepo)
    : undefined;
  if (monorepoAnalysis && detected.monorepo) {
    const packageHubFiles = new Map<string, PackageHubFile[]>();
    for (const pkg of detected.monorepo.packages) {
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
    monorepoAnalysis.packageHubFiles = packageHubFiles;
  }
  logMonorepoAnalysis(monorepoAnalysis, log);

  let changeImpact: Map<string, Array<{ file: string; score: number }>> | undefined;
  if (graphResults.hubFiles.length > 0) {
    const topHubs = graphResults.hubFiles
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
    if (impactMap.size > 0) changeImpact = impactMap;
  }

  return {
    configConstraints,
    conventions: conventions ?? undefined,
    testMapping: testMapping ?? undefined,
    structuralMismatches: structuralMismatches?.length ? structuralMismatches : undefined,
    monorepoAnalysis,
    changeImpact,
  };
}

// ---------------------------------------------------------------------------
// Phase 4: Delta detection
// ---------------------------------------------------------------------------

async function runDeltaPhase(rootDir: string, analysis: ContextAnalysis, log: LogCtx): Promise<string | null> {
  const currentAnalysisSnapshot = extractSnapshot(analysis);
  const prevSnapshot = await loadPreviousSnapshot(rootDir);
  let deltaSection: string | null = null;

  if (prevSnapshot) {
    const delta = computeDelta(prevSnapshot, currentAnalysisSnapshot);
    if (!isDeltaEmpty(delta)) {
      deltaSection = renderDeltaSection(delta);
      logDelta(deltaSection, log);
    }
  }

  try {
    await saveSnapshot(rootDir, currentAnalysisSnapshot);
  } catch (err) {
    if (!log.jsonMode && log.verbose)
      console.error(`[clarte] snapshot save failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  return deltaSection;
}
