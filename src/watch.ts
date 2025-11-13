import fs from "node:fs";
import path from "node:path";
import { loadConfig, configToAnswers } from "./config.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect.js";
import {
  buildImportGraph,
  mergeGraph,
  getHubFiles,
  findCircularDeps,
  detectArchitecturalLayers,
  computeInstability,
  detectCommunities,
  findDeadFiles,
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
  computeGraphTopology,
  findStructuralTemporalMismatches,
  findTightCouplings,
} from "./graph.js";
import { buildGraphWithCache } from "./cache.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  type AnalysisSnapshot,
} from "./delta.js";
import type { ContextAnalysis, ProgressCallback } from "./types.js";

// ── Ignore patterns ───────────────────────────────────────────────────

/** Directories and patterns to ignore in fs.watch events. */
const IGNORE_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "target",
  "vendor",
  "__pycache__",
  "venv",
  ".venv",
  ".git",
  ".clarte",
]);

/** File extensions that trigger a rebuild. */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".py",
  ".go",
  ".rs",
  ".java",
]);

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

// ── File filtering ────────────────────────────────────────────────────

/**
 * Check whether a file change event should trigger a rebuild.
 * Exported for testing.
 */
export function shouldRebuild(filePath: string): boolean {
  const parts = filePath.split(path.sep);

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

// ── Debounce utility ──────────────────────────────────────────────────

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

// ── Time formatting ───────────────────────────────────────────────────

function timeStamp(): string {
  const now = new Date();
  return [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join(":");
}

// ── Main watch mode ───────────────────────────────────────────────────

export async function runWatchMode(
  rootDir: string,
  verbose: boolean,
): Promise<void> {
  const noopProgress: ProgressCallback = () => {};
  const verboseLog: ProgressCallback = verbose
    ? (msg) => console.log(`  ${msg}`)
    : noopProgress;

  // 1. Load config (required for watch mode)
  const config = await loadConfig(rootDir);
  if (!config) {
    console.error(
      "[clarte] No .clarte.json found. Run `npx clarte` first to configure your project.",
    );
    process.exit(1);
  }

  const answers = configToAnswers(config);
  let previousSnapshot = await loadPreviousSnapshot(rootDir);

  // 2. Run initial analysis
  console.log(`[clarte] ${timeStamp()} - starting initial analysis...`);
  await runAnalysis(rootDir, answers, verbose, verboseLog, previousSnapshot);
  previousSnapshot = await loadPreviousSnapshot(rootDir);

  // 3. Start watching
  console.log(`[clarte] ${timeStamp()} - watching for changes... (Ctrl+C to stop)`);

  let isRunning = false;

  const debounced = createDebounce<string>(async (changedFiles) => {
    if (isRunning) return;
    isRunning = true;

    const uniqueFiles = [...new Set(changedFiles)];
    console.log(
      `[clarte] ${timeStamp()} - ${uniqueFiles.length} file${uniqueFiles.length === 1 ? "" : "s"} changed, rebuilding...`,
    );

    try {
      await runAnalysis(rootDir, answers, verbose, verboseLog, previousSnapshot);
      previousSnapshot = await loadPreviousSnapshot(rootDir);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[clarte] ${timeStamp()} - error during analysis: ${msg}`);
    }

    isRunning = false;
  }, 500);

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
    console.error(`[clarte] Failed to start file watcher: ${msg}`);
    process.exit(1);
  }

  // 4. Handle clean shutdown
  const cleanup = () => {
    console.log(`\n[clarte] ${timeStamp()} - shutting down watcher.`);
    watcher.close();
    process.exit(0);
  };

  process.on("SIGINT", cleanup);
  process.on("SIGTERM", cleanup);

  // Keep the process alive
  await new Promise(() => {
    // Never resolves; process exits via signal handlers
  });
}

// ── Analysis pipeline ─────────────────────────────────────────────────

async function runAnalysis(
  rootDir: string,
  answers: ReturnType<typeof configToAnswers>,
  verbose: boolean,
  verboseLog: ProgressCallback,
  previousSnapshot: AnalysisSnapshot | null,
): Promise<void> {
  const startTime = performance.now();
  const noopProgress: ProgressCallback = () => {};

  // Detect context
  const detected = await detectContext(rootDir, verbose ? verboseLog : noopProgress);

  // Build import graph (with cache for incremental updates)
  const graph = await buildGraphWithCache(
    rootDir,
    detected.language,
    verbose ? verboseLog : noopProgress,
  );

  // Merge secondary language graphs
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, noopProgress);
      mergeGraph(graph, secGraph);
    }
  }

  // Enrich frameworks
  detected.frameworks = enrichFrameworksWithUsage(
    detected.frameworks,
    graph.externalImportCounts,
  );

  // Full analysis pipeline
  const hubFiles = getHubFiles(graph);
  const circularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(graph, answers.layers);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = detected.isGitRepo
    ? analyzeGitActivity(rootDir, noopProgress)
    : null;
  const deadFiles = findDeadFiles(graph);
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  const layerConsistency =
    layers.length >= 2
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
    structuralMismatches: structuralMismatches?.length
      ? structuralMismatches
      : undefined,
    tightCouplings: tightCouplings.length ? tightCouplings : undefined,
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
      console.log(
        `[clarte] ${timeStamp()} - delta: ${changes.join(", ")}`,
      );
    }
  }

  await saveSnapshot(rootDir, currentSnapshot);

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
  console.log(`[clarte] ${timeStamp()} - analysis updated (${elapsed}s)`);
}
