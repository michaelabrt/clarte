import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t } from "../theme.js";
import { fileExists } from "../utils.js";
import {
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  ANALYSIS_CACHE_VERSION,
} from "../graph/cache.js";
import { findCircularDeps } from "../graph/cycles.js";
import { getHubFiles } from "../graph/hub-files.js";
import { detectArchitecturalLayers, computeLayerConsistency } from "../graph/layers.js";
import { computeInstability, INSTABILITY_THRESHOLD } from "../graph/instability.js";
import { detectCommunities } from "../graph/communities.js";
import { findDeadFiles } from "../graph/dead-files.js";
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
  AnalysisCacheData,
  ArchitecturalLayer,
  Chokepoint,
  CircularDependency,
  Community,
  ContextAnalysis,
  CrossCuttingFile,
  DetectedContext,
  FileInstability,
  GraphTopology,
  HubFile,
  ImportGraph,
  LayerConsistency,
  LayerEdge,
  PackageHubFile,
  ProgressCallback,
  ProjectConfig,
  TightCoupling,
} from "../types.js";

export interface AnalysisResult {
  analysis: ContextAnalysis;
  deltaSection: string | null;
}

/** Shared logging context for phase helpers */
interface LogCtx {
  jsonMode: boolean;
  verbose: boolean;
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

  const graphResults = runGraphPhase(graph, savedConfig, useCache ? analysisCache : null, log);

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
    } catch {
      // Cache save failed; non-critical
    }
  }

  const deltaSection = await runDeltaPhase(rootDir, analysis, log);

  return { analysis, deltaSection };
}

// ---------------------------------------------------------------------------
// Phase 1: Graph analysis (cacheable)
// ---------------------------------------------------------------------------

interface GraphPhaseResult {
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  layerEdges: LayerEdge[];
  instabilities: FileInstability[];
  communities: Community[];
  deadFiles: string[];
  crossCuttingFiles: CrossCuttingFile[];
  layerConsistency?: LayerConsistency;
  chokepoints: Chokepoint[];
  graphTopology: GraphTopology;
  structuralMismatches?: ReturnType<typeof findStructuralTemporalMismatches>;
  tightCouplings?: TightCoupling[];
  archViolations?: ContextAnalysis["archViolations"];
}

function runGraphPhase(
  graph: ImportGraph,
  savedConfig: ProjectConfig | null,
  cache: AnalysisCacheData | null,
  log: LogCtx,
): GraphPhaseResult {
  const hubFiles = cache ? cache.hubFiles : getHubFiles(graph);
  if (!log.jsonMode) {
    const topHubName = hubFiles[0]?.path ?? "";
    p.log.step(
      hubFiles.length > 0
        ? `${t.brand("Key files")}      found ${t.textBold(String(hubFiles.length))} key files` +
            (topHubName ? t.muted(` (top: ${topHubName})`) : "")
        : `${t.brand("Key files")}      ${t.muted("no key files detected")}`,
    );
    if (log.verbose && hubFiles.length > 0) {
      for (const h of hubFiles.slice(0, 5)) {
        p.log.info(
          t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`),
        );
      }
    }
  }

  const circularDeps = cache ? cache.circularDeps : findCircularDeps(graph);
  if (!log.jsonMode) {
    p.log.step(
      circularDeps.length === 0
        ? `${t.brand("Circular deps")}  no cycles found ${t.check()}`
        : `${t.brand("Circular deps")}  ${t.textBold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found ${t.warn("\u26A0")}`,
    );
    if (log.verbose && circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 3)) {
        p.log.info(t.muted(`  ${c.chain.join(" \u2192 ")}`));
      }
    }
  }

  const { layers, layerEdges } = cache
    ? { layers: cache.layers, layerEdges: cache.layerEdges }
    : detectArchitecturalLayers(graph, savedConfig?.layers);
  if (!log.jsonMode) {
    p.log.step(
      layers.length > 0
        ? `${t.brand("Layers")}         ${layers.map((l) => l.name).join(" \u2192 ")}`
        : `${t.brand("Layers")}         ${t.muted("no clear layers detected")}`,
    );
    if (log.verbose && layers.length > 0) {
      for (const l of layers) {
        p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
      }
    }
  }

  const instabilities = cache ? cache.instabilities : computeInstability(graph);
  if (!log.jsonMode) {
    const highInstability = instabilities.filter((f) => f.instability > INSTABILITY_THRESHOLD);
    p.log.step(
      highInstability.length > 0
        ? `${t.brand("Instability")}    ${t.textBold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"} ${t.warn("\u26A0")}`
        : `${t.brand("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
    );
    if (log.verbose && highInstability.length > 0) {
      for (const f of highInstability.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
      }
    }
  }

  const communities = cache ? cache.communities : detectCommunities(graph);
  if (!log.jsonMode) {
    p.log.step(
      communities.length > 0
        ? `${t.brand("Clusters")}       ${t.textBold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
        : `${t.brand("Clusters")}       ${t.muted("single cohesive module")}`,
    );
    if (log.verbose && communities.length > 0) {
      for (const c of communities.slice(0, 5)) {
        p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
      }
    }
  }

  const deadFiles = cache ? cache.deadFiles : findDeadFiles(graph);
  if (!log.jsonMode && deadFiles.length > 0) {
    p.log.step(
      `${t.brand("Dead files")}     ${t.textBold(String(deadFiles.length))} file${deadFiles.length === 1 ? "" : "s"} not imported by anything ${t.warn("\u26A0")}`,
    );
    if (log.verbose) {
      for (const f of deadFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f}`));
      }
    }
  }

  const crossCuttingFiles = cache ? cache.crossCuttingFiles : findCrossCuttingFiles(graph, layers);
  if (!log.jsonMode && crossCuttingFiles.length > 0) {
    p.log.step(
      `${t.brand("Cross-cutting")}  ${t.textBold(String(crossCuttingFiles.length))} file${crossCuttingFiles.length === 1 ? "" : "s"} span ${t.textBold("3+")} layers`,
    );
    if (log.verbose) {
      for (const f of crossCuttingFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.file} (${f.layerSpread} layers: ${f.layers.join(", ")})`));
      }
    }
  }

  const layerConsistency = cache
    ? cache.layerConsistency
    : layers.length >= 2
      ? computeLayerConsistency(graph, layers, layerEdges)
      : undefined;
  if (!log.jsonMode && layerConsistency) {
    const pct = (layerConsistency.consistency * 100).toFixed(0);
    const violationCount = layerConsistency.violations.length;
    p.log.step(
      violationCount === 0
        ? `${t.brand("Layer order")}    ${pct}% consistent ${t.check()}`
        : `${t.brand("Layer order")}    ${pct}% consistent, ${t.textBold(String(violationCount))} violation${violationCount === 1 ? "" : "s"} ${t.warn("\u26A0")}`,
    );
    if (log.verbose && violationCount > 0) {
      for (const v of layerConsistency.violations.slice(0, 3)) {
        p.log.info(t.muted(`  ${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`));
      }
    }
  }

  const chokepoints = cache ? cache.chokepoints : findChokepoints(graph);
  if (!log.jsonMode && chokepoints.length > 0) {
    p.log.step(
      `${t.brand("Chokepoints")}    ${t.textBold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
    );
    if (log.verbose) {
      for (const cp of chokepoints.slice(0, 5)) {
        p.log.info(
          t.muted(
            `  ${cp.file} (${cp.upstreamCount ?? cp.separates} dependents, ${cp.downstreamCount ?? 0} dependencies)`,
          ),
        );
      }
    }
  }

  const graphTopology = cache ? cache.graphTopology : computeGraphTopology(graph);
  if (!log.jsonMode) {
    if (graphTopology.isFragmented) {
      p.log.step(
        `${t.brand("Topology")}       ${t.textBold(String(graphTopology.componentCount))} connected component${graphTopology.componentCount === 1 ? "" : "s"} (fragmented) ${t.warn("\u26A0")}`,
      );
      if (log.verbose) {
        const sizes = graphTopology.componentSizes.slice(0, 5).join(", ");
        p.log.info(t.muted(`  Component sizes: ${sizes}${graphTopology.componentSizes.length > 5 ? ", ..." : ""}`));
        p.log.info(t.muted(`  Approximate diameter: ${graphTopology.approximateDiameter} hops`));
      }
    } else if (log.verbose) {
      p.log.step(
        `${t.brand("Topology")}       single connected graph, diameter ~${graphTopology.approximateDiameter} hops`,
      );
    }
  }

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
    const filesToCheck = new Set<string>();
    for (const h of gitActivity.hotFiles) filesToCheck.add(h.path);
    for (const c of gitActivity.changeCoupling) {
      filesToCheck.add(c.fileA);
      filesToCheck.add(c.fileB);
    }
    if (gitActivity.lagCouplings) {
      for (const c of gitActivity.lagCouplings) {
        filesToCheck.add(c.fileA);
        filesToCheck.add(c.fileB);
      }
    }
    const checks = await Promise.all(
      [...filesToCheck].map(async (f) => [f, await fileExists(path.join(rootDir, f))] as const),
    );
    const alive = new Set(checks.filter(([, ok]) => ok).map(([f]) => f));
    gitActivity.hotFiles = gitActivity.hotFiles.filter((h) => alive.has(h.path));
    gitActivity.changeCoupling = gitActivity.changeCoupling.filter((c) => alive.has(c.fileA) && alive.has(c.fileB));
    if (gitActivity.lagCouplings) {
      gitActivity.lagCouplings = gitActivity.lagCouplings.filter((c) => alive.has(c.fileA) && alive.has(c.fileB));
    }
  }

  if (!log.jsonMode) {
    if (gitActivity) {
      const coupledPairs = gitActivity.changeCoupling.length;
      p.log.step(
        `${t.brand(`Git (${analysisDays}d)`)}      ${t.textBold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${t.textBold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
      );
      if (log.verbose) {
        for (const h of gitActivity.hotFiles.slice(0, 5)) {
          p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
        }
      }
    } else {
      p.log.step(`${t.brand("Git")}            ${t.muted("not a git repo, skipped")}`);
    }
  }

  return gitActivity;
}

// ---------------------------------------------------------------------------
// Phase 3: Project analysis (config, conventions, tests, monorepo, impact)
// ---------------------------------------------------------------------------

interface ProjectPhaseResult {
  configConstraints: ContextAnalysis["configConstraints"];
  conventions?: ContextAnalysis["conventions"];
  testMapping?: ContextAnalysis["testMapping"];
  structuralMismatches?: ContextAnalysis["structuralMismatches"];
  monorepoAnalysis?: ContextAnalysis["monorepoAnalysis"];
  changeImpact?: ContextAnalysis["changeImpact"];
}

async function runProjectPhase(
  rootDir: string,
  graph: ImportGraph,
  detected: DetectedContext,
  graphResults: GraphPhaseResult,
  gitActivity: ContextAnalysis["gitActivity"],
  log: LogCtx,
): Promise<ProjectPhaseResult> {
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  if (!log.jsonMode) {
    const hasConstraints = configConstraints.typescript || configConstraints.linter || configConstraints.formatter;
    if (hasConstraints) {
      const parts: string[] = [];
      if (configConstraints.typescript) parts.push("tsconfig");
      if (configConstraints.linter) parts.push(configConstraints.linter.tool.toLowerCase());
      if (configConstraints.formatter && !configConstraints.linter)
        parts.push(configConstraints.formatter.tool.toLowerCase());
      p.log.step(`${t.brand("Config")}         extracted constraints from ${parts.join(", ")}`);
    }
  }

  const conventions = await inferConventions(rootDir, graph, configConstraints);
  if (!log.jsonMode && conventions) {
    const parts: string[] = [];
    if (Object.values(conventions.naming).some((v) => v !== "mixed")) parts.push("naming");
    if (conventions.exportStyle.preferNamed) parts.push("exports");
    if (conventions.importOrdering) parts.push("imports");
    if (parts.length > 0) {
      p.log.step(`${t.brand("Conventions")}    inferred ${parts.join(", ")} patterns`);
    }
  }

  const testMapping = buildTestMapping(graph, detected);
  if (!log.jsonMode && testMapping) {
    const coveredCount = testMapping.sourceToTests.size;
    const untestedCount = testMapping.untestedFiles.length;
    p.log.step(
      `${t.brand("Test map")}       ${t.textBold(String(coveredCount))} source file${coveredCount === 1 ? "" : "s"} with tests` +
        (untestedCount > 0 ? `, ${t.warn(String(untestedCount))} untested` : ` ${t.check()}`),
    );
    if (log.verbose && untestedCount > 0) {
      for (const f of testMapping.untestedFiles.slice(0, 5)) {
        p.log.info(t.muted(`  untested: ${f}`));
      }
    }
  }

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
  if (!log.jsonMode && monorepoAnalysis) {
    const edgeCount = monorepoAnalysis.crossPackageEdges.length;
    const violationCount = monorepoAnalysis.encapsulationViolations.length;
    if (edgeCount > 0) {
      p.log.step(
        `${t.brand("Packages")}       ${t.textBold(String(edgeCount))} cross-package edge${edgeCount === 1 ? "" : "s"}` +
          (violationCount > 0
            ? `, ${t.warn(String(violationCount))} encapsulation violation${violationCount === 1 ? "" : "s"}`
            : ` ${t.check()}`),
      );
      if (log.verbose && violationCount > 0) {
        for (const v of monorepoAnalysis.encapsulationViolations.slice(0, 5)) {
          p.log.info(t.muted(`  ${v.from} -> ${v.to} (${v.fromPackage} -> ${v.toPackage})`));
        }
      }
    }
  }

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
      if (!log.jsonMode && deltaSection) {
        p.log.step(`${t.brand("Delta")}          architecture changes detected since last run`);
        if (log.verbose) {
          for (const line of deltaSection.split("\n").filter((l) => l.startsWith("- "))) {
            p.log.info(t.muted(`  ${line.slice(2)}`));
          }
        }
      }
    }
  }

  try {
    await saveSnapshot(rootDir, currentAnalysisSnapshot);
  } catch {
    // Snapshot save failed; non-critical
  }

  return deltaSection;
}
