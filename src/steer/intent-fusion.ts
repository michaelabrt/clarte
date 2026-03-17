/**
 * RFC-002 §1.3, §1.6, §1.7: Intent score fusion, file-level aggregation,
 * and dynamic prediction count selection.
 *
 * The fusion formula:
 *   S_intent(s) = lambda_L * L(s,q) + lambda_G * G(s,q)
 *               + lambda_T * T(s,q) + lambda_B * B_tau(s)
 *
 * where L = lexical (BM25+), G = graph (Dijkstra propagation),
 *       T = temporal (change coupling), B = task-scoped betweenness.
 */

import type { InMemorySymbolGraph } from "../storage/types";
import type { IntentPrediction } from "../core/config/intent-constants";
import {
  LAMBDA_LEXICAL,
  LAMBDA_GRAPH,
  LAMBDA_TEMPORAL,
  LAMBDA_BETWEENNESS,
  THETA_HIGH,
  THETA_LOW,
  MIN_PREDICTIONS,
  MAX_PREDICTIONS,
} from "../core/config/intent-constants";

// ── Types ───────────────────────────────────────────────────────────────────

export interface FusionInput {
  symbolId: number;
  filePath: string;
  /** L(s, q) from BM25+ (raw, pre-normalization) */
  lexicalScore: number;
  /** G(s, q) from Dijkstra propagation, already in [0, 1] */
  graphScore: number;
  /** B_tau(s) from task-scoped betweenness, already in [0, 1] */
  betweennessScore: number;
}

export type FusionSignals = IntentPrediction["signals"];

export interface FusedScore {
  score: number;
  signals: FusionSignals;
}

export interface FileScore {
  score: number;
  signals: FusionSignals;
  topSymbolId: number;
}

// ── Minimum coupling confidence (matches targets-resolve.ts) ────────────────

const MIN_COUPLING_CONFIDENCE = 0.5;

// ── 1.5 Score Fusion ────────────────────────────────────────────────────────

/**
 * Fuse four signals into a single intent score per symbol.
 *
 * Lexical scores are normalized to [0, 1] by dividing by the max across inputs.
 * Graph and betweenness are already normalized. Temporal is computed per-symbol
 * from change coupling with seed files.
 *
 * Returns the un-normalized signal values in `signals` for Theory of Impact transparency.
 *
 * @param staleDiscount - When the graph is stale (built more than
 *   STALE_COMMIT_THRESHOLD commits ago), pass STALE_GRAPH_DISCOUNT (0.5)
 *   to halve the graph signal weight. Omit or pass undefined for fresh graphs.
 */
export function fuseIntentScores(
  inputs: FusionInput[],
  changeCoupling: Map<string, Map<string, number>>,
  seedFiles: Set<string>,
  staleDiscount?: number,
): Map<number, FusedScore> {
  if (inputs.length === 0) return new Map();

  // Normalize lexical scores to [0, 1]
  let maxLexical = 0;
  for (const inp of inputs) if (inp.lexicalScore > maxLexical) maxLexical = inp.lexicalScore;

  const result = new Map<number, FusedScore>();

  for (const inp of inputs) {
    const L = maxLexical > 0 ? inp.lexicalScore / maxLexical : 0;
    const G = staleDiscount !== undefined ? inp.graphScore * staleDiscount : inp.graphScore;
    const B = inp.betweennessScore;

    // Temporal signal: max coupling confidence between this file and any seed file
    let T = 0;
    const fileCoupling = changeCoupling.get(inp.filePath);
    if (fileCoupling) {
      for (const seedFile of seedFiles) {
        const conf = fileCoupling.get(seedFile) ?? 0;
        if (conf >= MIN_COUPLING_CONFIDENCE && conf > T) T = conf;
      }
    }
    // Also check reverse direction (coupling maps may be asymmetric)
    for (const seedFile of seedFiles) {
      const seedCoupling = changeCoupling.get(seedFile);
      if (!seedCoupling) continue;
      const conf = seedCoupling.get(inp.filePath) ?? 0;
      if (conf >= MIN_COUPLING_CONFIDENCE && conf > T) T = conf;
    }

    const score = LAMBDA_LEXICAL * L + LAMBDA_GRAPH * G + LAMBDA_TEMPORAL * T + LAMBDA_BETWEENNESS * B;

    result.set(inp.symbolId, {
      score,
      signals: {
        lexical: inp.lexicalScore, // un-normalized for ToI
        graph: inp.graphScore,
        temporal: T,
        betweenness: inp.betweennessScore,
      },
    });
  }

  return result;
}

// ── 1.6 File-Level Aggregation ──────────────────────────────────────────────

/**
 * Aggregate symbol-level scores to file level using max aggregation.
 *
 * For each file, the symbol with the highest fused score determines the
 * file's score. This prevents files with many low-scoring symbols from
 * outranking files with one high-scoring symbol.
 */
export function aggregateToFiles(
  symbolScores: Map<number, FusedScore>,
  symbolGraph: InMemorySymbolGraph,
): Map<string, FileScore> {
  const fileScores = new Map<string, FileScore>();

  for (const [symbolId, fused] of symbolScores) {
    const node = symbolGraph.symbols.get(symbolId);
    if (!node) continue;

    const existing = fileScores.get(node.filePath);
    if (!existing || fused.score > existing.score) {
      fileScores.set(node.filePath, {
        score: fused.score,
        signals: fused.signals,
        topSymbolId: symbolId,
      });
    }
  }

  return fileScores;
}

// ── 1.7 Dynamic Prediction Count ────────────────────────────────────────────

/**
 * Select predictions based on the confidence gate.
 *
 * 1. All files with score > THETA_HIGH (0.7) are selected.
 * 2. If none exceed the threshold, the single highest-scoring file is taken.
 * 3. At most MAX_PREDICTIONS (5) are returned.
 * 4. Suppressed count: files with score <= THETA_LOW (0.3) not in the selected set.
 */
export function selectPredictions(fileScores: Map<string, FileScore>): { predictions: string[]; suppressed: number } {
  if (fileScores.size === 0) return { predictions: [], suppressed: 0 };

  // Sort by score descending
  const sorted = Array.from(fileScores.entries()).sort((a, b) => b[1].score - a[1].score);

  // Select all above THETA_HIGH, capped at MAX_PREDICTIONS
  let predictions = sorted
    .filter(([, fs]) => fs.score > THETA_HIGH)
    .slice(0, MAX_PREDICTIONS)
    .map(([path]) => path);

  // Fallback: guarantee at least MIN_PREDICTIONS
  if (predictions.length < MIN_PREDICTIONS) {
    predictions = sorted.slice(0, MIN_PREDICTIONS).map(([path]) => path);
  }

  // Count suppressed: files at or below THETA_LOW that are not selected
  const selectedSet = new Set(predictions);
  let suppressed = 0;
  for (const [path, fs] of sorted) {
    if (fs.score <= THETA_LOW && !selectedSet.has(path)) suppressed++;
  }

  return { predictions, suppressed };
}
