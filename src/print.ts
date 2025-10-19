import path from "node:path";
import { loadConfig, configToAnswers } from "./config.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect.js";
import { buildImportGraph, getHubFiles, findCircularDeps, detectArchitecturalLayers, computeInstability, detectCommunities, findDeadFiles, findCrossCuttingFiles, computeLayerConsistency, findChokepoints, computeGraphTopology, findStructuralTemporalMismatches, findTightCouplings } from "./graph.js";
import { buildGraphWithCache } from "./cache.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { analyzeMonorepoGraph, computePackageCentrality } from "./monorepo-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { generateSnapshot } from "./snapshot.js";
import { buildSections, applyBudget, DEFAULT_BUDGET, type SectionFilterOptions } from "./templates/main-context.js";
import { readFileOr } from "./utils.js";
import type { ContextAnalysis, PackageHubFile, ProgressCallback } from "./types.js";

/**
 * Run print mode: compact, token-budgeted summary to stdout.
 * Designed for session hooks (e.g. Claude Code hooks.json).
 * Silent no-op if no .clarte.json config exists.
 */
export async function runPrintMode(
  rootDir: string,
  budget: number = DEFAULT_BUDGET,
  _verbose: boolean = false,
  sectionFilter?: SectionFilterOptions,
): Promise<void> {
  // 1. Load config; if none exists, exit silently (no-op for global hooks)
  const config = await loadConfig(rootDir);
  if (!config) return;

  // 2. Check if MCP server is active (stub mode)
  if (await isMcpActive()) {
    process.stdout.write(
      `<!-- clarte: MCP server active. Use the clarte MCP tool for full analysis. -->\n`,
    );
    return;
  }

  const noopProgress: ProgressCallback = () => {};
  const answers = configToAnswers(config);

  // 3. Detect context
  const detected = await detectContext(rootDir, noopProgress);

  // 4. Build import graph
  const graph = await buildGraphWithCache(rootDir, detected.language, noopProgress);

  // Merge secondary language graphs
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, noopProgress);
      graph.edges.push(...secGraph.edges);
      for (const [k, v] of secGraph.inDegree) {
        graph.inDegree.set(k, (graph.inDegree.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.centrality) {
        if (!graph.centrality.has(k)) graph.centrality.set(k, v);
      }
      for (const [k, v] of secGraph.externalImportCounts) {
        graph.externalImportCounts.set(k, (graph.externalImportCounts.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.authority) {
        if (!graph.authority.has(k)) graph.authority.set(k, v);
      }
      for (const [k, v] of secGraph.hubScores) {
        if (!graph.hubScores.has(k)) graph.hubScores.set(k, v);
      }
    }
  }

  // Enrich frameworks with usage counts
  detected.frameworks = enrichFrameworksWithUsage(
    detected.frameworks,
    graph.externalImportCounts,
  );

  // 5. Run full analysis pipeline
  const hubFiles = getHubFiles(graph);
  const circularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(graph, answers.layers);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = detected.isGitRepo ? analyzeGitActivity(rootDir, noopProgress) : null;
  const deadFiles = findDeadFiles(graph);
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  const layerConsistency = layers.length >= 2
    ? computeLayerConsistency(graph, layers, layerEdges)
    : undefined;
  const chokepoints = findChokepoints(graph);
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  const testMapping = buildTestMapping(graph, detected);
  const graphTopology = computeGraphTopology(graph);
  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;
  const tightCouplings = findTightCouplings(graph);

  // Monorepo graph analysis
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
  };

  // 6. Generate snapshot if configured
  let snapshot = null;
  if (config.generateSnapshot) {
    snapshot = await generateSnapshot(detected, config.snapshotPaths ?? [], graph);
    if (snapshot.entries.length === 0) snapshot = null;
  }

  // 7. Build sections with budget (apply filters first)
  let sections = await buildSections(detected, answers, snapshot, analysis);

  if (sectionFilter?.exclude?.size) {
    sections = sections.filter((s) => !sectionFilter.exclude!.has(s.id));
  }
  if (sectionFilter?.include?.size) {
    for (const s of sections) {
      if (sectionFilter.include.has(s.id)) {
        s.priority = 0;
      }
    }
  }

  const { included } = applyBudget(sections, budget);

  // 8. Write to stdout (plain text, no ANSI)
  const output = included.map((s) => s.content).join("\n\n").trimEnd() + "\n";
  process.stdout.write(output);
}

/**
 * Check if a clarte MCP server is configured in Claude Code settings.
 */
async function isMcpActive(): Promise<boolean> {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  const settingsPath = path.join(homeDir, ".claude", "settings.json");
  const content = await readFileOr(settingsPath);
  if (!content) return false;

  try {
    const settings = JSON.parse(content);
    const mcpServers = settings.mcpServers ?? settings.mcp_servers ?? {};
    return Object.keys(mcpServers).some((key) =>
      key.toLowerCase().includes("clarte"),
    );
  } catch {
    return false;
  }
}
