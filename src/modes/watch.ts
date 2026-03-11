import fs from "node:fs";
import path from "node:path";
import { ClarteError, ExitCode } from "../errors.js";
import { IGNORE_DIRS_SET } from "../config/ignore-patterns.js";
import { loadConfig, configToAnswers } from "../config/config.js";
import { detectContext, enrichFrameworksWithUsage } from "../detect/detect.js";
import { buildImportGraph, mergeGraph } from "../graph/build.js";
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
import { buildGraphWithCache } from "../graph/cache.js";
import { analyzeGitActivityAsync } from "../git/analysis.js";
import { filterAliveGitActivity } from "../git/filter-alive.js";
import { NOOP_PROGRESS } from "../utils.js";
import { scanConfigConstraints } from "../config/scan.js";
import { inferConventions } from "../conventions/conventions.js";
import { buildTestMapping } from "../analysis/test-map.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  type AnalysisSnapshot,
} from "../analysis/delta.js";
import type { ContextAnalysis, ProgressCallback } from "../types.js";

/** Directories and patterns to ignore in fs.watch events. */
const IGNORE_DIRS = IGNORE_DIRS_SET;

/** File extensions that trigger a rebuild. */
const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".py", ".go", ".rs", ".java"]);

/** Debounce delay for file change events (ms). */
const DEBOUNCE_MS = 500;

/** Files to ignore (lock files, etc.). */
const IGNORE_FILES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
]);

/**
 * Check whether a file change event should trigger a rebuild.
 * Exported for testing.
 */
export function shouldRebuild(filePath: string): boolean {
  // Normalize backslashes to forward slashes for cross-platform compatibility
  // (fs.watch may return forward-slash paths on Windows)
  const normalized = filePath.replace(/\\/g, "/");
  const parts = normalized.split("/");

  // Check if any path segment is an ignored directory
  for (const part of parts) {
    if (IGNORE_DIRS.has(part)) return false;
  }

  const basename = path.basename(filePath);

  // Ignore lock files
  if (IGNORE_FILES.has(basename)) return false;

  // Only rebuild for source file extensions
  const ext = path.extname(filePath);
  return SOURCE_EXTENSIONS.has(ext);
}

/**
 * Create a debounced function that collects items and fires after a delay.
 * Exported for testing.
 */
export function createDebounce<T>(
  fn: (items: T[]) => void,
  delayMs: number,
): { add: (item: T) => void; flush: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: T[] = [];

  const flush = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.length > 0) {
      const items = [...pending];
      pending = [];
      fn(items);
    }
  };

  const add = (item: T) => {
    pending.push(item);
    if (timer) clearTimeout(timer);
    timer = setTimeout(flush, delayMs);
  };

  return { add, flush };
}

function timeStamp(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join(":");
}

export async function runWatchMode(rootDir: string, verbose: boolean): Promise<void> {
  const verboseLog: ProgressCallback = verbose ? (msg) => console.log(`  ${msg}`) : NOOP_PROGRESS;

  // 1. Load config (required for watch mode)
  const config = await loadConfig(rootDir);
  if (!config) {
    throw new ClarteError("No .clarte.json found. Run `npx clarte` first to configure your project.", ExitCode.MISSING);
  }

  const answers = configToAnswers(config);
  let previousSnapshot = await loadPreviousSnapshot(rootDir);

  const analysisDays = config.analysisDays ?? 90;

  // 2. Run initial analysis
  console.log(`[clarte] ${timeStamp()} - starting initial analysis...`);
  await runAnalysis(rootDir, answers, verbose, verboseLog, previousSnapshot, analysisDays);
  previousSnapshot = await loadPreviousSnapshot(rootDir);

  // 3. Start watching
  console.log(`[clarte] ${timeStamp()} - watching for changes... (Ctrl+C to stop)`);

  let isRunning = false;
  let pendingFiles: string[] = [];

  const debounced = createDebounce<string>(async (changedFiles) => {
    if (isRunning) {
      pendingFiles.push(...changedFiles);
      return;
    }
    isRunning = true;

    const uniqueFiles = [...new Set(changedFiles)];
    console.log(
      `[clarte] ${timeStamp()} - ${uniqueFiles.length} file${uniqueFiles.length === 1 ? "" : "s"} changed, rebuilding...`,
    );

    try {
      await runAnalysis(rootDir, answers, verbose, verboseLog, previousSnapshot, analysisDays);
      previousSnapshot = await loadPreviousSnapshot(rootDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[clarte] ${timeStamp()} - error during analysis: ${msg}`);
    } finally {
      isRunning = false;
    }

    // Re-trigger for any files that arrived during the rebuild
    if (pendingFiles.length > 0) {
      const deferred = pendingFiles;
      pendingFiles = [];
      for (const file of deferred) {
        debounced.add(file);
      }
    }
  }, DEBOUNCE_MS);

  // Use fs.watch with recursive option
  let watcher: fs.FSWatcher;
  try {
    watcher = fs.watch(rootDir, { recursive: true }, (_event, filename) => {
      if (!filename) return;
      if (shouldRebuild(filename)) {
        debounced.add(filename);
      }
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ClarteError(`Failed to start file watcher: ${msg}`);
  }

  // 4. Handle clean shutdown
  const cleanup = () => {
    console.log(`\n[clarte] ${timeStamp()} - shutting down watcher.`);
    watcher.close();
    process.exit(ExitCode.SUCCESS);
  };
  // Note: terminal color reset not needed here; watch mode uses console.log, not picocolors

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep the process alive
  await new Promise(() => {
    // Never resolves; process exits via signal handlers
  });
}

async function runAnalysis(
  rootDir: string,
  answers: ReturnType<typeof configToAnswers>,
  verbose: boolean,
  verboseLog: ProgressCallback,
  previousSnapshot: AnalysisSnapshot | null,
  analysisDays: number,
): Promise<void> {
  const startTime = performance.now();

  // Detect context
  const detected = await detectContext(rootDir, verbose ? verboseLog : NOOP_PROGRESS);

  // Build import graph (with cache for incremental updates)
  const graph = await buildGraphWithCache(rootDir, detected.language, verbose ? verboseLog : NOOP_PROGRESS);

  // Merge secondary language graphs
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, NOOP_PROGRESS);
      mergeGraph(graph, secGraph);
    }
  }

  // Enrich frameworks
  detected.frameworks = enrichFrameworksWithUsage(detected.frameworks, graph.externalImportCounts);

  // Full analysis pipeline
  const hubFiles = getHubFiles(graph);
  const circularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(graph, answers.layers);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = detected.isGitRepo ? await analyzeGitActivityAsync(rootDir, NOOP_PROGRESS, analysisDays) : null;
  if (gitActivity) {
    await filterAliveGitActivity(rootDir, gitActivity);
  }
  const deadFiles = findDeadFiles(graph, readPackageEntryPoints(rootDir));
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  const layerConsistency = layers.length >= 2 ? computeLayerConsistency(graph, layers, layerEdges) : undefined;
  const chokepoints = findChokepoints(graph);
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  const testMapping = buildTestMapping(graph, detected);
  const graphTopology = computeGraphTopology(graph);
  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;
  const tightCouplings = findTightCouplings(graph);

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
    analysisDays,
  };

  // Delta tracking
  const currentSnapshot = extractSnapshot(analysis);

  if (previousSnapshot) {
    const delta = computeDelta(previousSnapshot, currentSnapshot);
    if (!isDeltaEmpty(delta)) {
      const changes: string[] = [];
      if (delta.newHubFiles.length > 0) {
        changes.push(`+${delta.newHubFiles.length} hub`);
      }
      if (delta.demotedHubFiles.length > 0) {
        changes.push(`-${delta.demotedHubFiles.length} hub`);
      }
      if (delta.newCircularDeps.length > 0) {
        changes.push(`+${delta.newCircularDeps.length} cycle`);
      }
      if (delta.resolvedCircularDeps.length > 0) {
        changes.push(`-${delta.resolvedCircularDeps.length} cycle`);
      }
      if (delta.newDeadFiles.length > 0) {
        changes.push(`+${delta.newDeadFiles.length} dead`);
      }
      if (delta.resurrectedFiles.length > 0) {
        changes.push(`-${delta.resurrectedFiles.length} dead`);
      }
      if (delta.newChokepoints.length > 0) {
        changes.push(`+${delta.newChokepoints.length} chokepoint`);
      }
      if (delta.resolvedChokepoints.length > 0) {
        changes.push(`-${delta.resolvedChokepoints.length} chokepoint`);
      }
      if (delta.layerViolationDelta !== 0) {
        const sign = delta.layerViolationDelta > 0 ? "+" : "";
        changes.push(`${sign}${delta.layerViolationDelta} violations`);
      }
      console.log(`[clarte] ${timeStamp()} - delta: ${changes.join(", ")}`);
    }
  }

  await saveSnapshot(rootDir, currentSnapshot);

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[clarte] ${timeStamp()} - analysis updated (${elapsed}s)`);
}
