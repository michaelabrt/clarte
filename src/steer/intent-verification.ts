/**
 * RFC-002 SS2.4: Verification Protocol + SS2.3 Confidence Calibration.
 *
 * Cross-checks every prediction against the current graph state.
 * Four checks: edge existence, file existence, symbol existence,
 * score monotonicity. Predictions with missing files are removed;
 * predictions with missing edges have their graph signal zeroed
 * and scores recomputed.
 *
 * Confidence calibration labels each surviving prediction as
 * "high" (score > THETA_HIGH) or "medium".
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InMemorySymbolGraph, InMemoryFileGraph } from "../storage/types";
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
 * Note: signals.lexical is the raw BM25+ score (un-normalized, per RFC §1.5
 * ToI transparency). This produces an approximate score when recomputing
 * after zeroing the graph signal. Acceptable because: (1) the direction
 * is always correct (score drops), (2) the stale+ghost edge case is rare,
 * (3) Phase 4 orchestrator can pass normalization context if precision needed.
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

    // Forward: from -> to
    for (const edge of symbolGraph.forward.get(from) ?? []) {
      if (edge.toSymbolId === to) {
        found = true;
        break;
      }
    }

    // Reverse traversal: to -> from in forward map
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

// -- Main verification --------------------------------------------------------

/**
 * Run the four-check verification protocol on predictions.
 *
 * The optional `propagationPaths` map (symbol_id -> path from Dijkstra)
 * enables edge-level verification. When omitted, edge existence defaults
 * to true (cannot verify without path data).
 *
 * The optional `fileTopSymbolId` map (file -> top symbol ID from aggregation)
 * links predictions to their underlying symbol IDs for path lookup.
 */
export function verifyPredictions(
  predictions: IntentPrediction[],
  symbolGraph: InMemorySymbolGraph,
  _fileGraph: InMemoryFileGraph,
  rootDir: string,
  propagationPaths?: Map<number, number[]>,
  fileTopSymbolId?: Map<string, number>,
): IntentPrediction[] {
  const paths = propagationPaths ?? new Map<number, number[]>();
  const topIds = fileTopSymbolId ?? new Map<string, number>();
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
      topIds.get(pred.file) ??
      (pred.symbols.length > 0 ? resolveSymbolId(pred.file, pred.symbols[0].name, symbolGraph) : null);

    // 1. Edge existence
    if (pred.signals.graph > 0 && pred.theory.graph_path && topSymId !== null) {
      const path = paths.get(topSymId);
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
      // Could not resolve any symbol ID for this file
      verification.symbol_exists = false;
    }

    pred.verification = verification;

    // Confidence calibration (SS2.3)
    pred.confidence = pred.score > THETA_HIGH ? "high" : "medium";

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
