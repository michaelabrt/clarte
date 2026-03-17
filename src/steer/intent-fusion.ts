/**
 * RFC-002 SS1.3, SS1.6, SS1.7: Intent score fusion, file-level aggregation,
 * and dynamic prediction count selection.
 *
 * Updated fusion formula (F1/F2 remediation):
 *   S_intent(s) = lambda_L * L_hat(s,q) + lambda_G * G(s,q) * C(s) * D
 *               + lambda_T * T(s,q) + lambda_B * B_tau(s)
 *
 * where L_hat = normalized BM25+ in [0,1], G = Dijkstra propagation,
 *       C = path resolution confidence product, D = stale discount,
 *       T = temporal (change coupling), B = task-scoped betweenness.
 *
 * signals.lexical stores L_hat (normalized) for exact recomputeScore.
 * signals.rawLexical stores the raw BM25+ for ToI display.
 * signals.graph stores the effective G*C*D for exact recomputeScore.
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
  /** Product of edge resolution confidences along the Dijkstra path. Defaults to 1.0. */
  pathConfidence?: number;
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
 * Graph scores are modulated by pathConfidence (resolution tier product) and
 * staleDiscount (graph freshness). All effective values are stored in signals
 * for exact recomputation by the verification protocol.
 *
 * @param staleDiscount - Pass STALE_GRAPH_DISCOUNT (0.5) when the graph is
 *   stale. Omit or pass undefined for fresh graphs.
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

  const staleFactor = staleDiscount ?? 1.0;
  const result = new Map<number, FusedScore>();

  for (const inp of inputs) {
    const L = maxLexical > 0 ? inp.lexicalScore / maxLexical : 0;
    const pathConf = inp.pathConfidence ?? 1.0;
    const G = inp.graphScore * pathConf * staleFactor;
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
        lexical: L, // normalized [0,1] for recomputeScore
        rawLexical: inp.lexicalScore, // raw BM25+ for ToI display
        graph: G, // effective: G(s) * C_path * D_stale
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
