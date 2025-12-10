import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t } from "./theme.js";
import { fileExists } from "./utils.js";
import { enrichFrameworksWithUsage } from "./detect.js";
import {
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  ANALYSIS_CACHE_VERSION,
} from "./cache.js";
import { findCircularDeps } from "./graph-cycles.js";
import { getHubFiles } from "./graph/hub-files.js";
import { detectArchitecturalLayers, computeLayerConsistency } from "./graph/layers.js";
import { computeInstability, INSTABILITY_THRESHOLD } from "./graph/instability.js";
import { detectCommunities } from "./graph/communities.js";
import { findDeadFiles } from "./graph/dead-files.js";
import { findCrossCuttingFiles } from "./graph/cross-cutting.js";
import { findChokepoints } from "./graph/chokepoints.js";
import { computeGraphTopology } from "./graph/topology.js";
import { findStructuralTemporalMismatches } from "./graph/mismatches.js";
import { findTightCouplings } from "./graph/tight-coupling.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { analyzeMonorepoGraph, computePackageCentrality } from "./monorepo-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { predictChangeImpact } from "./change-impact.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  renderDeltaSection,
} from "./delta.js";
import type {
  ContextAnalysis,
  DetectedContext,
  HubFile,
  ImportGraph,
  PackageHubFile,
  ProgressCallback,
  ProjectConfig,
} from "./types.js";

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
  const useAnalysisCache = analysisCache !== null && analysisCache.cacheKey === analysisCacheKey;

  // Hub files (HITS analysis)
  const hubFiles = useAnalysisCache ? analysisCache.hubFiles : getHubFiles(graph);
  if (!jsonMode) {
    const topHubName = hubFiles[0]?.path ?? "";
    p.log.step(
      hubFiles.length > 0
        ? `${t.brand("Key files")}      found ${t.textBold(String(hubFiles.length))} key files` +
            (topHubName ? t.muted(` (top: ${topHubName})`) : "")
        : `${t.brand("Key files")}      ${t.muted("no key files detected")}`,
    );
    if (verbose && hubFiles.length > 0) {
      for (const h of hubFiles.slice(0, 5)) {
        p.log.info(
          t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`),
        );
      }
    }
  }

  // Circular dependency detection (Tarjan SCC)
  const circularDeps = useAnalysisCache ? analysisCache.circularDeps : findCircularDeps(graph);
  if (!jsonMode) {
    p.log.step(
      circularDeps.length === 0
        ? `${t.brand("Circular deps")}  no cycles found ${t.check()}`
        : `${t.brand("Circular deps")}  ${t.textBold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found ${t.warn("\u26A0")}`,
    );
    if (verbose && circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 3)) {
        p.log.info(t.muted(`  ${c.chain.join(" \u2192 ")}`));
      }
    }
  }

  const { layers, layerEdges } = useAnalysisCache
    ? { layers: analysisCache.layers, layerEdges: analysisCache.layerEdges }
    : detectArchitecturalLayers(graph, savedConfig?.layers);
  if (!jsonMode) {
    p.log.step(
      layers.length > 0
        ? `${t.brand("Layers")}         ${layers.map((l) => l.name).join(" \u2192 ")}`
        : `${t.brand("Layers")}         ${t.muted("no clear layers detected")}`,
    );
    if (verbose && layers.length > 0) {
      for (const l of layers) {
        p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
      }
    }
  }

  const instabilities = useAnalysisCache ? analysisCache.instabilities : computeInstability(graph);
  if (!jsonMode) {
    const highInstability = instabilities.filter((f) => f.instability > INSTABILITY_THRESHOLD);
    p.log.step(
      highInstability.length > 0
        ? `${t.brand("Instability")}    ${t.textBold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"} ${t.warn("\u26A0")}`
        : `${t.brand("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
    );
    if (verbose && highInstability.length > 0) {
      for (const f of highInstability.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
      }
    }
  }

  const communities = useAnalysisCache ? analysisCache.communities : detectCommunities(graph);
  if (!jsonMode) {
    p.log.step(
      communities.length > 0
        ? `${t.brand("Clusters")}       ${t.textBold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
        : `${t.brand("Clusters")}       ${t.muted("single cohesive module")}`,
    );
    if (verbose && communities.length > 0) {
      for (const c of communities.slice(0, 5)) {
        p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
      }
    }
  }

  const gitActivity = detected.isGitRepo
    ? await analyzeGitActivity(rootDir, verbose ? verboseLog : noopProgress, analysisDays)
    : null;

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

  if (!jsonMode) {
    if (gitActivity) {
      const coupledPairs = gitActivity.changeCoupling.length;
      p.log.step(
        `${t.brand(`Git (${analysisDays}d)`)}      ${t.textBold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${t.textBold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
      );
      if (verbose) {
        for (const h of gitActivity.hotFiles.slice(0, 5)) {
          p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
        }
      }
    } else {
      p.log.step(`${t.brand("Git")}            ${t.muted("not a git repo, skipped")}`);
    }
  }

  const deadFiles = useAnalysisCache ? analysisCache.deadFiles : findDeadFiles(graph);
  if (!jsonMode && deadFiles.length > 0) {
    p.log.step(
      `${t.brand("Dead files")}     ${t.textBold(String(deadFiles.length))} file${deadFiles.length === 1 ? "" : "s"} not imported by anything ${t.warn("\u26A0")}`,
    );
    if (verbose) {
      for (const f of deadFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f}`));
      }
    }
  }

  const crossCuttingFiles = useAnalysisCache ? analysisCache.crossCuttingFiles : findCrossCuttingFiles(graph, layers);
  if (!jsonMode && crossCuttingFiles.length > 0) {
    p.log.step(
      `${t.brand("Cross-cutting")}  ${t.textBold(String(crossCuttingFiles.length))} file${crossCuttingFiles.length === 1 ? "" : "s"} span ${t.textBold("3+")} layers`,
    );
    if (verbose) {
      for (const f of crossCuttingFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.file} (${f.layerSpread} layers: ${f.layers.join(", ")})`));
      }
    }
  }

  const layerConsistency = useAnalysisCache
    ? analysisCache.layerConsistency
    : layers.length >= 2
      ? computeLayerConsistency(graph, layers, layerEdges)
      : undefined;
  if (!jsonMode && layerConsistency) {
    const pct = (layerConsistency.consistency * 100).toFixed(0);
    const violationCount = layerConsistency.violations.length;
    p.log.step(
      violationCount === 0
        ? `${t.brand("Layer order")}    ${pct}% consistent ${t.check()}`
        : `${t.brand("Layer order")}    ${pct}% consistent, ${t.textBold(String(violationCount))} violation${violationCount === 1 ? "" : "s"} ${t.warn("\u26A0")}`,
    );
    if (verbose && violationCount > 0) {
      for (const v of layerConsistency.violations.slice(0, 3)) {
        p.log.info(t.muted(`  ${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`));
      }
    }
  }

  const chokepoints = useAnalysisCache ? analysisCache.chokepoints : findChokepoints(graph);
  if (!jsonMode && chokepoints.length > 0) {
    p.log.step(
      `${t.brand("Chokepoints")}    ${t.textBold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
    );
    if (verbose) {
      for (const cp of chokepoints.slice(0, 5)) {
        p.log.info(t.muted(`  ${cp.file} (separates ${cp.separates} components, ${cp.importedBy} importers)`));
      }
    }
  }

  const configConstraints = await scanConfigConstraints(rootDir, detected);
  if (!jsonMode) {
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
  if (!jsonMode && conventions) {
    const parts: string[] = [];
    if (Object.values(conventions.naming).some((v) => v !== "mixed")) parts.push("naming");
    if (conventions.exportStyle.preferNamed) parts.push("exports");
    if (conventions.importOrdering) parts.push("imports");
    if (parts.length > 0) {
      p.log.step(`${t.brand("Conventions")}    inferred ${parts.join(", ")} patterns`);
    }
  }

  const testMapping = buildTestMapping(graph, detected);
  if (!jsonMode && testMapping) {
    const coveredCount = testMapping.sourceToTests.size;
    const untestedCount = testMapping.untestedFiles.length;
    p.log.step(
      `${t.brand("Test map")}       ${t.textBold(String(coveredCount))} source file${coveredCount === 1 ? "" : "s"} with tests` +
        (untestedCount > 0 ? `, ${t.warn(String(untestedCount))} untested` : ` ${t.check()}`),
    );
    if (verbose && untestedCount > 0) {
      for (const f of testMapping.untestedFiles.slice(0, 5)) {
        p.log.info(t.muted(`  untested: ${f}`));
      }
    }
  }

  const graphTopology = useAnalysisCache ? analysisCache.graphTopology : computeGraphTopology(graph);
  if (!jsonMode) {
    if (graphTopology.isFragmented) {
      p.log.step(
        `${t.brand("Topology")}       ${t.textBold(String(graphTopology.componentCount))} connected component${graphTopology.componentCount === 1 ? "" : "s"} (fragmented) ${t.warn("\u26A0")}`,
      );
      if (verbose) {
        const sizes = graphTopology.componentSizes.slice(0, 5).join(", ");
        p.log.info(t.muted(`  Component sizes: ${sizes}${graphTopology.componentSizes.length > 5 ? ", ..." : ""}`));
        p.log.info(t.muted(`  Approximate diameter: ${graphTopology.approximateDiameter} hops`));
      }
    } else if (verbose) {
      p.log.step(
        `${t.brand("Topology")}       single connected graph, diameter ~${graphTopology.approximateDiameter} hops`,
      );
    }
  }

  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;

  const tightCouplings = useAnalysisCache ? analysisCache.tightCouplings : findTightCouplings(graph);

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
  if (!jsonMode && monorepoAnalysis) {
    const edgeCount = monorepoAnalysis.crossPackageEdges.length;
    const violationCount = monorepoAnalysis.encapsulationViolations.length;
    if (edgeCount > 0) {
      p.log.step(
        `${t.brand("Packages")}       ${t.textBold(String(edgeCount))} cross-package edge${edgeCount === 1 ? "" : "s"}` +
          (violationCount > 0
            ? `, ${t.warn(String(violationCount))} encapsulation violation${violationCount === 1 ? "" : "s"}`
            : ` ${t.check()}`),
      );
      if (verbose && violationCount > 0) {
        for (const v of monorepoAnalysis.encapsulationViolations.slice(0, 5)) {
          p.log.info(t.muted(`  ${v.from} -> ${v.to} (${v.fromPackage} -> ${v.toPackage})`));
        }
      }
    }
  }

  let changeImpact: Map<string, Array<{ file: string; score: number }>> | undefined;
  if (hubFiles.length > 0) {
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
    if (impactMap.size > 0) changeImpact = impactMap;
  }

  const analysis: ContextAnalysis = {
    hubFiles,
    circularDeps,
    layers,
    layerEdges,
    gitActivity,
    instabilities,
    communities,
    deadFiles,
    configConstraints,
    crossCuttingFiles,
    layerConsistency,
    chokepoints,
    conventions: conventions ?? undefined,
    testMapping: testMapping ?? undefined,
    graphTopology,
    structuralMismatches: structuralMismatches?.length ? structuralMismatches : undefined,
    tightCouplings: tightCouplings.length ? tightCouplings : undefined,
    monorepoAnalysis,
    changeImpact,
    analysisDays,
  };

  if (!useAnalysisCache) {
    try {
      await saveAnalysisCache(rootDir, {
        version: ANALYSIS_CACHE_VERSION,
        cacheKey: analysisCacheKey,
        hubFiles,
        circularDeps,
        layers,
        layerEdges,
        instabilities,
        communities,
        deadFiles,
        crossCuttingFiles: crossCuttingFiles ?? [],
        layerConsistency,
        chokepoints,
        tightCouplings,
        graphTopology,
      });
    } catch {
      // Cache save failed; non-critical
    }
  }

  // Delta detection
  const currentAnalysisSnapshot = extractSnapshot(analysis);
  const prevSnapshot = await loadPreviousSnapshot(rootDir);
  let deltaSection: string | null = null;
  if (prevSnapshot) {
    const delta = computeDelta(prevSnapshot, currentAnalysisSnapshot);
    if (!isDeltaEmpty(delta)) {
      deltaSection = renderDeltaSection(delta);
      if (!jsonMode && deltaSection) {
        p.log.step(`${t.brand("Delta")}          architecture changes detected since last run`);
        if (verbose) {
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

  return { analysis, deltaSection };
}
