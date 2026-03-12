import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError } from "../errors.js";
import { gitExec, gitExecSafe } from "../git/git.js";
import { theme as t, unpatchPicocolors } from "../theme.js";
import { errorMessage, writeFileSafe, isTestFile } from "../utils.js";
import { detectContext, enrichFrameworksWithUsage } from "../detect/detect.js";
import { buildGraphWithCache } from "../graph/cache.js";
import { buildImportGraph, mergeGraph } from "../graph/build.js";
import { findCircularDeps } from "../graph/cycles.js";
import { getHubFiles } from "../graph/hub-files.js";
import { detectArchitecturalLayers } from "../graph/layers.js";
import { computeInstability } from "../graph/instability.js";
import { detectCommunities } from "../graph/communities.js";
import { analyzeGitActivity } from "../git/analysis.js";
import { loadConfig } from "../config/config.js";
import { buildTestMapping } from "../analysis/test-map.js";
import { generateSnapshot } from "../snapshot/snapshot.js";
import { startShimmer } from "../cli/animations.js";
import { renderDiffContext } from "./diff-render.js";
import type { ContextAnalysis, NeighborhoodResult, ProgressCallback } from "../types.js";

export type { NeighborhoodResult };

export async function runDiffMode(
  rootDir: string,
  ref?: string,
  verbose = false,
  outputFile?: string,
  filterFiles: string[] = [],
): Promise<void> {
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(t.muted(msg));
  };

  // Validate ref to prevent shell injection (only allow git ref characters)
  if (ref && !/^[\w./:@^~{}-]+$/.test(ref)) {
    p.log.error(t.error(`Invalid git ref: ${ref}`));
    return;
  }

  let changedFiles: string[];
  let diffStat: Map<string, { added: number; removed: number }> | null = null;
  try {
    const diffArgs = ref ? ["diff", "--name-only", `${ref}...HEAD`] : ["diff", "--name-only", "HEAD"];
    const output = gitExec(diffArgs, { cwd: rootDir });

    changedFiles = [...new Set(output.split("\n").filter(Boolean))];

    if (filterFiles.length > 0) {
      const filterSet = new Set(filterFiles.map((f) => path.normalize(f)));
      changedFiles = changedFiles.filter((f) => filterSet.has(path.normalize(f)));
    }

    const statArgs = ref ? ["diff", "--numstat", `${ref}...HEAD`] : ["diff", "--numstat", "HEAD"];
    const statOutput = gitExecSafe(statArgs, { cwd: rootDir });
    if (statOutput) {
      diffStat = new Map();
      for (const line of statOutput.split("\n").filter(Boolean)) {
        const [addStr, rmStr, file] = line.split("\t");
        if (file && addStr !== "-") {
          const existing = diffStat.get(file);
          const added = parseInt(addStr, 10) || 0;
          const removed = parseInt(rmStr, 10) || 0;
          if (existing) {
            existing.added += added;
            existing.removed += removed;
          } else {
            diffStat.set(file, { added, removed });
          }
        }
      }
    }
  } catch (err) {
    const msg = errorMessage(err);
    if (ref && (msg.includes("unknown revision") || msg.includes("bad revision"))) {
      throw new ClarteError(`Failed to resolve ref '${ref}'. Verify the branch or commit exists.`);
    } else {
      throw new ClarteError("Failed to get changed files from git. Is this a git repo?");
    }
  }

  if (changedFiles.length === 0) {
    if (filterFiles.length > 0) {
      p.log.info(t.text(`No changes found for: ${filterFiles.join(", ")}`));
    } else {
      p.log.info(t.text("No changed files detected."));
    }
    return;
  }

  p.log.step(t.text(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`));

  const shimmer = startShimmer("Building import graph...");
  const detected = await detectContext(rootDir, verboseLog);
  const graph = await buildGraphWithCache(rootDir, detected.language, verboseLog);

  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, verboseLog);
      mergeGraph(graph, secGraph);
    }
  }

  detected.frameworks = enrichFrameworksWithUsage(detected.frameworks, graph.externalImportCounts);

  shimmer.stop();

  const changedSet = new Set(changedFiles);
  const neighborhood = computeNeighborhood(changedSet, graph.edges);
  const { hop1: hop1Set, hop2: hop2Set } = neighborhood;

  const neighborSet = new Set([...hop1Set, ...hop2Set]);

  const testMapping = buildTestMapping(graph, detected);
  const testFiles = new Set<string>();
  for (const f of changedSet) {
    const tests = testMapping?.sourceToTests.get(f);
    if (tests) {
      for (const tf of tests) testFiles.add(tf);
    }
  }
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.to) && isTestFile(edge.from)) {
      testFiles.add(edge.from);
    }
  }

  const diffConfig = await loadConfig(rootDir);
  const customLayers = diffConfig?.layers;
  const allHubFiles = getHubFiles(graph);
  const hubFileMap = new Map(allHubFiles.map((h) => [h.path, h]));
  const allCircularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(graph, customLayers);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = detected.isGitRepo
    ? analyzeGitActivity(rootDir, verboseLog, diffConfig?.analysisDays ?? 90)
    : null;

  const relevantHub = scopeHubFiles(allHubFiles, changedSet, hop1Set, hop2Set);
  const relevantCycles = scopeCircularDeps(allCircularDeps, changedSet, hop1Set);

  const analysis: ContextAnalysis = {
    hubFiles: relevantHub,
    circularDeps: relevantCycles,
    layers,
    layerEdges,
    gitActivity,
    instabilities,
    communities,
  };

  const snapshot = await generateSnapshot(detected, [], graph);
  const entryIndex = new Map<string, typeof snapshot.entries>();
  if (snapshot) {
    for (const entry of snapshot.entries) {
      const arr = entryIndex.get(entry.file) ?? [];
      arr.push(entry);
      entryIndex.set(entry.file, arr);
    }
  }

  const allRelevant = [...new Set([...changedSet, ...neighborSet, ...testFiles])];

  p.log.step(
    t.text(
      `Scope: ${changedFiles.length} changed, ${hop1Set.size} direct + ${hop2Set.size} indirect neighbor${hop1Set.size + hop2Set.size === 1 ? "" : "s"}, ${testFiles.size} test file${testFiles.size === 1 ? "" : "s"}`,
    ),
  );

  const content = renderDiffContext({
    changedFiles,
    ref,
    diffStat,
    hubFileMap,
    graph,
    neighborhood,
    testFiles,
    entryIndex,
    relevantCycles,
    gitActivity,
    detected,
    analysis,
  });

  if (outputFile) {
    const outPath = path.resolve(rootDir, outputFile);
    await writeFileSafe(outPath, content);
    p.log.step(t.text(`Written to ${t.accent(outputFile)}`));
  } else {
    process.stdout.write(content);
  }

  p.outro(t.success("Diff context ready. ") + t.muted(`${allRelevant.length} files in scope.`));
  unpatchPicocolors();
}

/**
 * Compute 2-hop neighborhoods from a set of changed files in an import graph.
 * Returns separate sets for 1-hop (direct) and 2-hop (indirect) neighbors,
 * split by direction: importers (downstream) vs dependencies (upstream).
 */
export function computeNeighborhood(
  changedFiles: Set<string>,
  edges: Array<{ from: string; to: string; isExternal: boolean }>,
): NeighborhoodResult {
  const hop1 = new Set<string>();
  const hop1Importers = new Set<string>();
  const hop1Dependencies = new Set<string>();

  for (const edge of edges) {
    if (edge.isExternal) continue;
    // edge.from imports edge.to
    if (changedFiles.has(edge.to) && !changedFiles.has(edge.from)) {
      hop1.add(edge.from);
      hop1Importers.add(edge.from); // edge.from imports the changed file
    }
    if (changedFiles.has(edge.from) && !changedFiles.has(edge.to)) {
      hop1.add(edge.to);
      hop1Dependencies.add(edge.to); // edge.to is imported by the changed file
    }
  }

  const hop2 = new Set<string>();
  const hop2Importers = new Set<string>();
  const hop2Dependencies = new Set<string>();

  for (const edge of edges) {
    if (edge.isExternal) continue;
    if (hop1.has(edge.to) && !changedFiles.has(edge.from) && !hop1.has(edge.from)) {
      hop2.add(edge.from);
      hop2Importers.add(edge.from);
    }
    if (hop1.has(edge.from) && !changedFiles.has(edge.to) && !hop1.has(edge.to)) {
      hop2.add(edge.to);
      hop2Dependencies.add(edge.to);
    }
  }

  return { hop1, hop2, hop1Importers, hop1Dependencies, hop2Importers, hop2Dependencies };
}

/**
 * Filter hub files to only those in the given neighborhood (changed + hop1 + hop2).
 */
export function scopeHubFiles<T extends { path: string }>(
  hubFiles: T[],
  changedSet: Set<string>,
  hop1Set: Set<string>,
  hop2Set: Set<string>,
): T[] {
  return hubFiles.filter((h) => changedSet.has(h.path) || hop1Set.has(h.path) || hop2Set.has(h.path));
}

/**
 * Filter circular dependencies to only those where at least one file
 * is in the changed or hop1 neighborhood.
 */
export function scopeCircularDeps<T extends { chain: string[] }>(
  circularDeps: T[],
  changedSet: Set<string>,
  hop1Set: Set<string>,
): T[] {
  return circularDeps.filter((dep) => dep.chain.some((f) => changedSet.has(f) || hop1Set.has(f)));
}
