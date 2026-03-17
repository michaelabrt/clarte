/**
 * Verification protocol and confidence calibration.
 *
 * Cross-checks every prediction against the current graph state.
 * Four checks: edge existence, file existence, symbol existence,
 * score monotonicity. Predictions with missing files are removed;
 * predictions with missing edges have their graph signal zeroed
 * and scores recomputed.
 *
 * F1 fix: recomputeScore uses signals.lexical (normalized [0,1]) and
 * signals.graph (effective G*C*D), both stored by the fusion layer.
 * The invariant holds: zeroing any signal always decreases the score.
 *
 * F3: Each prediction gets an isStale flag based on whether its file
 * or any symbol in its propagation path has been modified since the
 * last graph index.
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InMemorySymbolGraph } from "../storage/types";
import type { IntentPrediction, VerificationResult } from "../core/config/intent-constants";
import {
  LAMBDA_LEXICAL,
  LAMBDA_GRAPH,
  LAMBDA_TEMPORAL,
  LAMBDA_BETWEENNESS,
  THETA_HIGH,
} from "../core/config/intent-constants";

// -- Helpers ------------------------------------------------------------------

/**
 * Recompute the fused score from individual signals.
 *
 * All signal values in IntentPrediction.signals are the effective values
 * used in the weighted sum (lexical is normalized, graph is G*C*D).
 * This makes recomputation exact: score = sum(lambda_i * signal_i).
 *
 * F1 invariant: since all signals are in [0,1] and lambdas sum to 1.0,
 * the recomputed score is in [0,1]. Zeroing any non-negative signal
 * always produces a lower or equal score.
 */
function recomputeScore(signals: IntentPrediction["signals"]): number {
  return (
    LAMBDA_LEXICAL * signals.lexical +
    LAMBDA_GRAPH * signals.graph +
    LAMBDA_TEMPORAL * signals.temporal +
    LAMBDA_BETWEENNESS * signals.betweenness
  );
}

/**
 * Resolve a symbol ID from a file path and symbol name.
 * Scans the file's symbols in the graph and matches by name.
 */
function resolveSymbolId(filePath: string, symbolName: string, symbolGraph: InMemorySymbolGraph): number | null {
  const ids = symbolGraph.byFile.get(filePath);
  if (!ids) return null;
  for (const id of ids) {
    const sym = symbolGraph.symbols.get(id);
    if (sym?.name === symbolName) return id;
  }
  return null;
}

/**
 * Verify that every edge in a propagation path exists in the symbol graph.
 * Returns true if all edges are present (or path is too short to check).
 */
function verifyPathEdges(path: number[], symbolGraph: InMemorySymbolGraph): boolean {
  if (path.length < 2) return true;

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];
    let found = false;

    for (const edge of symbolGraph.forward.get(from) ?? []) {
      if (edge.toSymbolId === to) {
        found = true;
        break;
      }
    }

    if (!found) {
      for (const edge of symbolGraph.forward.get(to) ?? []) {
        if (edge.toSymbolId === from) {
          found = true;
          break;
        }
      }
    }

    if (!found) return false;
  }

  return true;
}

/**
 * Determine if a prediction is stale: its file or any symbol in its
 * propagation path resides in a file modified since the last index.
 */
function computeIsStale(
  file: string,
  topSymId: number | null,
  paths: Map<number, number[]>,
  symbolGraph: InMemorySymbolGraph,
  changedFiles: Set<string>,
): boolean {
  if (changedFiles.has(file)) return true;

  if (topSymId !== null) {
    const path = paths.get(topSymId);
    if (path) {
      for (const symId of path) {
        const sym = symbolGraph.symbols.get(symId);
        if (sym && changedFiles.has(sym.filePath)) return true;
      }
    }
  }

  return false;
}

// -- Main verification --------------------------------------------------------

/**
 * Run the four-check verification protocol on predictions.
 *
 * propagationPaths and fileTopSymbolId are mandatory to prevent the
 * "silent bypass" where edge verification is skipped when data is missing.
 *
 * @param changedFilesSinceGraph - files modified since the graph was built.
 *   Used to compute isStale per prediction. Defaults to empty (all fresh).
 */
export function verifyPredictions(
  predictions: IntentPrediction[],
  symbolGraph: InMemorySymbolGraph,
  rootDir: string,
  propagationPaths: Map<number, number[]>,
  fileTopSymbolId: Map<string, number>,
  changedFilesSinceGraph?: Set<string>,
): IntentPrediction[] {
  const changedFiles = changedFilesSinceGraph ?? new Set<string>();
  const verified: IntentPrediction[] = [];

  for (const pred of predictions) {
    const verification: VerificationResult = {
      edge_exists: true,
      file_exists: true,
      symbol_exists: true,
      monotonic: true,
    };

    // Resolve top symbol ID for this prediction
    const topSymId =
      fileTopSymbolId.get(pred.file) ??
      (pred.symbols.length > 0 ? resolveSymbolId(pred.file, pred.symbols[0].name, symbolGraph) : null);

    // 1. Edge existence
    if (pred.signals.graph > 0 && pred.theory.graph_path && topSymId !== null) {
      const path = propagationPaths.get(topSymId);
      if (path && !verifyPathEdges(path, symbolGraph)) {
        verification.edge_exists = false;
        pred.signals.graph = 0;
        pred.score = recomputeScore(pred.signals);
      }
    }

    // 2. File existence
    if (!existsSync(join(rootDir, pred.file))) {
      verification.file_exists = false;
      pred.verification = verification;
      continue; // Remove from output
    }

    // 3. Symbol existence
    if (topSymId !== null) {
      if (!symbolGraph.symbols.has(topSymId)) {
        verification.symbol_exists = false;
      }
    } else if (pred.symbols.length > 0) {
      verification.symbol_exists = false;
    }

    pred.verification = verification;

    // Confidence calibration
    pred.confidence = pred.score > THETA_HIGH ? "high" : "medium";

    // Staleness (F3)
    pred.isStale = computeIsStale(pred.file, topSymId, propagationPaths, symbolGraph, changedFiles);

    verified.push(pred);
  }

  // 4. Score monotonicity check (after filtering, on final sorted order)
  verified.sort((a, b) => b.score - a.score);

  for (let i = 1; i < verified.length; i++) {
    const higher = verified[i - 1];
    const lower = verified[i];

    const hasStrictlyGreater =
      higher.signals.lexical > lower.signals.lexical ||
      higher.signals.graph > lower.signals.graph ||
      higher.signals.temporal > lower.signals.temporal ||
      higher.signals.betweenness > lower.signals.betweenness;

    if (!hasStrictlyGreater) {
      lower.verification.monotonic = false;
    }
  }

  // Assign final ranks
  for (let i = 0; i < verified.length; i++) {
    verified[i].rank = i + 1;
  }

  return verified;
}
