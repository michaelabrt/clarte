/**
 * intentPredict orchestrator.
 *
 * Sequentially executes Dijkstra propagation, verification with
 * confidence calibration and context pruning with topological
 * ordering. Returns predictions, context
 * selection and timing data for the trace logger.
 *
 * Safe-failure pattern: if any phase throws, the orchestrator catches
 * the error, logs it to the trace and falls back to a baseline response.
 *
 * Performance budget: <100ms for a 500-file project (warm cache).
 */

import { execSync } from "node:child_process";
import type { InMemoryFileGraph, InMemorySymbolGraph } from "../storage/types";
import type { IntentPrediction, PredictionTrace, SymbolMatch } from "../core/config/intent-constants";
import type { ContextSelection } from "./context-pruning";
import {
  TRANSMISSION,
  REVERSE_MULTIPLIER,
  GHOST_DISCOUNT,
  MAX_PROPAGATION_HOPS,
  SEED_TOP_K,
  STALE_COMMIT_THRESHOLD,
  STALE_GRAPH_DISCOUNT,
  LAMBDA_LEXICAL,
  LAMBDA_TEMPORAL,
  MAX_CONTEXT_TOKENS,
} from "../core/config/intent-constants";
import { extractSymbolSubgraph } from "../core/graph/intent-subgraph";
import { propagateIntent, computePathConfidenceProducts } from "./intent-propagation";
import { applyPhase2Seeding, computeSubgraphBetweenness } from "./intent-phase2";
import { fuseIntentScores, aggregateToFiles, selectPredictions, type FusionInput } from "./intent-fusion";
import { generateTheoryOfImpact } from "./theory-of-impact";
import { verifyPredictions } from "./intent-verification";
import { evaluateSmartSilence } from "./smart-silence";
import { selectContextSymbols, orderForPresentation } from "./context-pruning";
import { tokenizeQuery } from "./targets-resolve";
import { debugIntent } from "./prediction-logger";

// ── Types ───────────────────────────────────────────────────────────────────

export interface IntentPredictResult {
  predictions: IntentPrediction[];
  suppressed: { reason: string | null; count: number };
  contextSelection: ContextSelection;
  timing: PredictionTrace["timing_ms"];
  seeds: PredictionTrace["seeds"];
}

// ── Empty result sentinel ────────────────────────────────────────────────────

const EMPTY_CONTEXT: ContextSelection = {
  selectedSymbols: [],
  tokenBudgetUsed: 0,
  marginalGainAtStop: 0,
  totalCoverage: 0,
};

function emptyResult(reason: string | null = null): IntentPredictResult {
  return {
    predictions: [],
    suppressed: { reason, count: 0 },
    contextSelection: EMPTY_CONTEXT,
    timing: {
      total: 0,
      seed_selection: 0,
      subgraph_extraction: 0,
      intent_propagation: 0,
      phase2_seeding: null,
      temporal_fusion: 0,
      verification: 0,
      context_pruning: 0,
      rendering: 0,
    },
    seeds: [],
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Build seed score map: symbol_id -> BM25F lexical score.
 * Scans seed files for symbols in the symbol graph, assigns each the
 * file-level BM25F score from the scoring pipeline.
 */
function buildSeedScoreMap(
  seedFiles: string[],
  seedBM25Scores: Map<string, number>,
  symbolGraph: InMemorySymbolGraph,
): Map<number, number> {
  const seeds = new Map<number, number>();
  for (const file of seedFiles) {
    const score = seedBM25Scores.get(file) ?? 0;
    for (const symId of symbolGraph.byFile.get(file) ?? []) {
      seeds.set(symId, score);
    }
  }
  return seeds;
}

/**
 * Score files using BM25F on the file graph.
 * Returns top-K files with their scores.
 */
function scoreSeedFiles(
  queryTokens: string[],
  fileGraph: InMemoryFileGraph,
  symbolGraph: InMemorySymbolGraph,
  topK: number,
): { files: string[]; scores: Map<string, number> } {
  if (queryTokens.length === 0) return { files: [], scores: new Map() };

  // Simple BM25-like scoring on file paths and symbol names
  const fileScores = new Map<string, number>();

  for (const [filePath, node] of fileGraph.nodes) {
    if (filePath.includes("__tests__") || filePath.includes(".test.") || filePath.includes(".spec.")) continue;

    const pathTokens = filePath
      .split(/[/.-]+/)
      .flatMap((seg) => seg.split(/(?=[A-Z])/))
      .map((t) => t.toLowerCase())
      .filter((t) => t.length > 1);

    const symIds = symbolGraph.byFile.get(filePath) ?? [];
    const symNames: string[] = [];
    for (const id of symIds) {
      const sym = symbolGraph.symbols.get(id);
      if (sym) {
        symNames.push(
          ...sym.name
            .split(/(?=[A-Z])/)
            .map((t) => t.toLowerCase())
            .filter((t) => t.length > 1),
        );
      }
    }

    let score = 0;
    for (const qt of queryTokens) {
      if (pathTokens.includes(qt)) score += 2.0;
      if (symNames.includes(qt)) score += 1.5;
    }

    // Authority boost
    score *= 1 + node.authority * 0.5;

    if (score > 0) fileScores.set(filePath, score);
  }

  const sorted = [...fileScores.entries()].sort((a, b) => b[1] - a[1]).slice(0, topK);

  return {
    files: sorted.map(([f]) => f),
    scores: new Map(sorted),
  };
}

/**
 * Count commits between two revisions. Returns 0 on failure.
 */
function commitDistance(fromCommit: string, toCommit: string, rootDir: string): number {
  try {
    const output = execSync(`git rev-list --count ${fromCommit}..${toCommit}`, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return parseInt(output, 10) || 0;
  } catch {
    return 0;
  }
}

/**
 * Get files changed since a commit. Returns empty set on failure.
 */
function getChangedFiles(fromCommit: string, rootDir: string): string[] {
  try {
    const output = execSync(`git diff --name-only ${fromCommit}..HEAD`, {
      cwd: rootDir,
      encoding: "utf-8",
      timeout: 2000,
    }).trim();
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

/**
 * Build the task edge key set for context pruning cost estimation.
 */
function buildTaskEdgeKeys(subgraph: ReturnType<typeof extractSymbolSubgraph>): Set<string> {
  const keys = new Set<string>();
  for (const [sourceId, edges] of subgraph.forward) {
    for (const edge of edges) {
      keys.add(`${sourceId}-${edge.targetId}`);
    }
  }
  return keys;
}

/**
 * Build IntentPrediction objects from file scores and fusion data.
 */
function buildPredictionObjects(
  predFiles: string[],
  fileScores: Map<string, ReturnType<typeof aggregateToFiles> extends Map<string, infer V> ? V : never>,
  symbolGraph: InMemorySymbolGraph,
  propagationPaths: Map<number, number[]>,
  seedFiles: Set<string>,
  changeCoupling: Map<string, Map<string, number>>,
  taskBetweenness: Map<number, number>,
  query: string,
  contextSymbols: Set<number>,
): IntentPrediction[] {
  const predictions: IntentPrediction[] = [];

  for (let i = 0; i < predFiles.length; i++) {
    const file = predFiles[i];
    const fs = fileScores.get(file);
    if (!fs) continue;

    const theory = generateTheoryOfImpact(
      file,
      fs.signals,
      fs.topSymbolId,
      propagationPaths,
      symbolGraph,
      seedFiles,
      changeCoupling,
      taskBetweenness,
      query,
    );

    // Collect symbols from this file that were selected by context pruning
    const fileSymIds = symbolGraph.byFile.get(file) ?? [];
    const symbols: SymbolMatch[] = [];
    for (const symId of fileSymIds) {
      if (contextSymbols.has(symId)) {
        const sym = symbolGraph.symbols.get(symId);
        if (sym) {
          symbols.push({ name: sym.name, score: 0, line: sym.startLine });
        }
      }
    }

    // If no context-pruned symbols, include the top symbol at minimum
    if (symbols.length === 0) {
      const topSym = symbolGraph.symbols.get(fs.topSymbolId);
      if (topSym) {
        symbols.push({ name: topSym.name, score: fs.score, line: topSym.startLine });
      }
    }

    predictions.push({
      file,
      rank: i + 1,
      score: fs.score,
      confidence: "medium", // calibrated by verification
      isStale: false, // set by verification
      signals: { ...fs.signals },
      theory,
      verification: { edge_exists: true, file_exists: true, symbol_exists: true, monotonic: true },
      symbols,
    });
  }

  return predictions;
}

/**
 * Lexical-only fallback: zero graph and betweenness signals, recompute score.
 */
function fallbackToLexical(predictions: IntentPrediction[]): IntentPrediction[] {
  for (const pred of predictions) {
    pred.signals.graph = 0;
    pred.signals.betweenness = 0;
    pred.score = LAMBDA_LEXICAL * pred.signals.lexical + LAMBDA_TEMPORAL * pred.signals.temporal;
    pred.theory.graph_path = null;
    pred.theory.betweenness_rank = null;
  }
  predictions.sort((a, b) => b.score - a.score);
  for (let i = 0; i < predictions.length; i++) {
    predictions[i].rank = i + 1;
  }
  return predictions;
}

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Run the full intent prediction pipeline: seed selection, subgraph
 * extraction, Dijkstra propagation, chokepoint seeding, fusion,
 * verification, smart silence, context pruning and presentation ordering.
 *
 * If the symbol graph is empty or any phase throws, falls back gracefully
 * to an empty result with a diagnostic reason.
 */
export function intentPredict(
  query: string,
  fileGraph: InMemoryFileGraph,
  symbolGraph: InMemorySymbolGraph,
  changeCoupling: Map<string, Map<string, number>>,
  rootDir: string,
  graphCommit: string,
  headCommit: string,
  _maxTargets?: number,
): IntentPredictResult {
  const t0 = performance.now();

  // ── Backward compatibility: empty graph falls back ─────────────────────
  if (symbolGraph.symbols.size === 0) {
    debugIntent("empty symbol graph, falling back to lexical");
    return emptyResult("empty symbol graph");
  }

  try {
    return runPipeline(query, fileGraph, symbolGraph, changeCoupling, rootDir, graphCommit, headCommit, t0);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    debugIntent(`pipeline error: ${msg}`);
    return emptyResult(`pipeline error: ${msg}`);
  }
}

function runPipeline(
  query: string,
  fileGraph: InMemoryFileGraph,
  symbolGraph: InMemorySymbolGraph,
  changeCoupling: Map<string, Map<string, number>>,
  rootDir: string,
  graphCommit: string,
  headCommit: string,
  t0: number,
): IntentPredictResult {
  const timing: PredictionTrace["timing_ms"] = {
    total: 0,
    seed_selection: 0,
    subgraph_extraction: 0,
    intent_propagation: 0,
    phase2_seeding: null,
    temporal_fusion: 0,
    verification: 0,
    context_pruning: 0,
    rendering: 0,
  };

  // ── Stage 1-2: Tokenize + Seed Selection ─────────────────────────────
  const t1 = performance.now();
  const queryTokens = tokenizeQuery(query);
  if (queryTokens.length === 0) {
    debugIntent("no query tokens, returning empty");
    return emptyResult("no query tokens");
  }

  const seedResult = scoreSeedFiles(queryTokens, fileGraph, symbolGraph, SEED_TOP_K);
  const seedFiles = seedResult.files;
  timing.seed_selection = performance.now() - t1;

  if (seedFiles.length === 0) {
    debugIntent("no seed files found");
    return emptyResult("no seed files");
  }

  debugIntent(`query: "${query.slice(0, 80)}"`);
  debugIntent(`tokens: [${queryTokens.map((t) => `"${t}"`).join(", ")}]`);
  debugIntent(
    `seeds (${seedFiles.length}): ${seedFiles
      .slice(0, 3)
      .map((f) => `${f} (${(seedResult.scores.get(f) ?? 0).toFixed(2)})`)
      .join(", ")}${seedFiles.length > 3 ? ", ..." : ""}`,
  );

  // Build seed trace data
  const seedTrace: PredictionTrace["seeds"] = seedFiles.map((f) => ({
    file: f,
    bm25f_score: seedResult.scores.get(f) ?? 0,
    token_matches: queryTokens.filter((t) =>
      f
        .toLowerCase()
        .split(/[/.-]+/)
        .some((seg) => seg.includes(t)),
    ),
  }));

  // ── Stage 3: Subgraph Extraction ──────────────────────────────────────
  const t2 = performance.now();
  const subgraph = extractSymbolSubgraph(seedFiles, symbolGraph, MAX_PROPAGATION_HOPS, fileGraph.forward);
  timing.subgraph_extraction = performance.now() - t2;

  if (subgraph.nodes.size === 0) {
    debugIntent("empty subgraph, no symbols reachable from seeds");
    return emptyResult("empty subgraph");
  }

  let edgeCount = 0;
  for (const edges of subgraph.forward.values()) edgeCount += edges.length;
  debugIntent(
    `subgraph: ${subgraph.nodes.size} symbols, ${edgeCount} edges (${MAX_PROPAGATION_HOPS}-hop BFS, ${(timing.subgraph_extraction).toFixed(0)}ms)`,
  );

  // ── Stage 4: Intent Propagation (Dijkstra) ──────────────────────────────
  const t3 = performance.now();
  const seedScoreMap = buildSeedScoreMap(seedFiles, seedResult.scores, symbolGraph);
  const phase1 = propagateIntent(
    seedScoreMap,
    subgraph,
    TRANSMISSION,
    REVERSE_MULTIPLIER,
    GHOST_DISCOUNT,
    MAX_PROPAGATION_HOPS,
  );
  timing.intent_propagation = performance.now() - t3;

  debugIntent(
    `propagation: ${phase1.scores.size} symbols scored (Dijkstra, ${(timing.intent_propagation).toFixed(0)}ms)`,
  );

  // ── Stage 5: Chokepoint Seeding (Betweenness re-propagation) ────────────
  const t4 = performance.now();
  const phase2Result = applyPhase2Seeding(phase1.scores, subgraph, TRANSMISSION, REVERSE_MULTIPLIER, GHOST_DISCOUNT);
  timing.phase2_seeding = phase2Result.phase2Triggered ? performance.now() - t4 : null;

  if (phase2Result.phase2Triggered) {
    debugIntent(`phase2: ${phase2Result.chokepoints.length} chokepoints identified`);
  }

  // ── Stage 6: Score Fusion ─────────────────────────────────────────────
  const t5 = performance.now();

  // Compute stale discount
  const staleDistance = commitDistance(graphCommit, headCommit, rootDir);
  const staleDiscount = staleDistance > STALE_COMMIT_THRESHOLD ? STALE_GRAPH_DISCOUNT : undefined;

  // Compute path confidence products
  const pathConfidences = computePathConfidenceProducts(phase1.paths, subgraph);

  // Build betweenness map for fusion
  const taskBetweenness = computeSubgraphBetweenness(subgraph);

  // Build fusion inputs from merged scores
  const fusionInputs: FusionInput[] = [];
  for (const [symbolId, mergedScore] of phase2Result.mergedScores) {
    const sym = symbolGraph.symbols.get(symbolId);
    if (!sym) continue;

    fusionInputs.push({
      symbolId,
      filePath: sym.filePath,
      lexicalScore: seedResult.scores.get(sym.filePath) ?? 0,
      graphScore: mergedScore,
      betweennessScore: taskBetweenness.get(symbolId) ?? 0,
      pathConfidence: pathConfidences.get(symbolId),
    });
  }

  const seedFileSet = new Set(seedFiles);
  const symbolScores = fuseIntentScores(fusionInputs, changeCoupling, seedFileSet, staleDiscount);
  timing.temporal_fusion = performance.now() - t5;

  // ── Stage 7-8: File Aggregation + Dynamic Count ───────────────────────
  const fileScores = aggregateToFiles(symbolScores, symbolGraph);
  const { predictions: predFiles, suppressed: suppressedCount } = selectPredictions(fileScores);

  debugIntent(
    `fusion: top-${predFiles.length} by S_intent:\n${predFiles
      .slice(0, 5)
      .map((f, i) => {
        const fs = fileScores.get(f);
        if (!fs) return `  ${i + 1}. ${f}  ???`;
        const s = fs.signals;
        return `  ${i + 1}. ${f}  ${fs.score.toFixed(3)} (L:${s.lexical.toFixed(2)} G:${s.graph.toFixed(2)} T:${s.temporal.toFixed(2)} B:${s.betweenness.toFixed(2)})`;
      })
      .join("\n")}`,
  );

  // ── Stage 10: Smart Silence ───────────────────────────────────────────
  const changedFiles = getChangedFiles(graphCommit, rootDir);

  // Build fileTopSymbolId map for verification
  const fileTopSymbolId = new Map<string, number>();
  for (const [file, fs] of fileScores) {
    fileTopSymbolId.set(file, fs.topSymbolId);
  }

  // ── Stage 11: Context Pruning ─────────────────────────────────────────
  const t7 = performance.now();
  const taskEdgeKeys = buildTaskEdgeKeys(subgraph);
  const intentScoreMap = new Map<number, number>();
  for (const [symId, fused] of symbolScores) {
    intentScoreMap.set(symId, fused.score);
  }
  const contextSelection = selectContextSymbols(
    subgraph,
    intentScoreMap,
    symbolGraph,
    taskEdgeKeys,
    MAX_CONTEXT_TOKENS,
  );

  // Order for presentation
  const orderedSymbols = orderForPresentation(contextSelection.selectedSymbols, subgraph, intentScoreMap, symbolGraph);
  contextSelection.selectedSymbols = orderedSymbols;

  timing.context_pruning = performance.now() - t7;

  debugIntent(
    `context: ${contextSelection.selectedSymbols.length} symbols selected (${contextSelection.tokenBudgetUsed} tokens / ${MAX_CONTEXT_TOKENS} budget)`,
  );

  // ── Build prediction objects ──────────────────────────────────────────
  const contextSymbolSet = new Set(contextSelection.selectedSymbols);
  let predictions = buildPredictionObjects(
    predFiles,
    fileScores,
    symbolGraph,
    phase1.paths,
    seedFileSet,
    changeCoupling,
    taskBetweenness,
    query,
    contextSymbolSet,
  );

  // ── Stage 9: Verification ─────────────────────────────────────────────
  const t6 = performance.now();
  const changedFileSet = new Set(changedFiles);
  predictions = verifyPredictions(predictions, symbolGraph, rootDir, phase1.paths, fileTopSymbolId, changedFileSet);
  timing.verification = performance.now() - t6;

  debugIntent(`verification: ${predictions.length}/${predFiles.length} passed`);

  // Smart silence check
  const silence = evaluateSmartSilence(
    predictions,
    query,
    fileGraph.nodes.size,
    graphCommit,
    headCommit,
    changedFiles,
    predFiles,
  );

  if (silence.shouldSuppress) {
    debugIntent(`suppressed: ${silence.reason}`);
    timing.total = performance.now() - t0;
    return {
      predictions: [],
      suppressed: { reason: silence.reason, count: suppressedCount + predictions.length },
      contextSelection,
      timing,
      seeds: seedTrace,
    };
  }

  if (silence.fallbackToLexical) {
    debugIntent("stale graph, falling back to lexical-only scores");
    predictions = fallbackToLexical(predictions);
  }

  debugIntent(`suppressed: ${suppressedCount} predictions below threshold`);

  // ── Finalize timing ───────────────────────────────────────────────────
  timing.rendering = 0; // filled by caller
  timing.total = performance.now() - t0;

  debugIntent(`total: ${timing.total.toFixed(0)}ms`);

  // Clear large intermediate data structures for GC
  // (propagation paths, subgraph maps are local to this function scope
  //  and will be collected when the function returns)

  return {
    predictions,
    suppressed: { reason: silence.reason, count: suppressedCount },
    contextSelection,
    timing,
    seeds: seedTrace,
  };
}
