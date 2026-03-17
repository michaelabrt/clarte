/**
 * RFC-002 SS2.3: Theory of Impact generator.
 *
 * Synthesizes Phase 1 fusion signals into structured evidence for each
 * predicted file. Each non-zero signal produces a human/AI-readable
 * explanation linking specific symbol relationships to the user's intent.
 */

import type { InMemorySymbolGraph } from "../storage/types";
import type { TheoryOfImpact, IntentPrediction } from "../core/config/intent-constants";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import { TRANSMISSION } from "../core/config/intent-constants";

// -- Helpers ------------------------------------------------------------------

/**
 * Find the edge kind between two adjacent symbols in the graph.
 * Returns the first matching forward edge kind, or null if none.
 */
function findEdgeKind(fromId: number, toId: number, symbolGraph: InMemorySymbolGraph): SymbolEdgeKind | null {
  for (const edge of symbolGraph.forward.get(fromId) ?? []) {
    if (edge.toSymbolId === toId) return edge.kind as SymbolEdgeKind;
  }
  // Check reverse: toId -> fromId in forward means fromId <- toId
  for (const edge of symbolGraph.forward.get(toId) ?? []) {
    if (edge.toSymbolId === fromId) return edge.kind as SymbolEdgeKind;
  }
  return null;
}

/**
 * Compute the product of transmission gammas along a path.
 * For each consecutive pair, look up the edge kind and multiply gammas.
 * Reverse-direction traversal (going against forward edge direction)
 * applies the reverseMultiplier implicitly in the gamma.
 */
function computePathGamma(path: number[], symbolGraph: InMemorySymbolGraph, reverseMultiplier: number): number {
  if (path.length < 2) return 1.0;

  let gamma = 1.0;
  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];

    // Check forward direction first
    let edgeKind: SymbolEdgeKind | null = null;
    let isReverse = false;

    for (const edge of symbolGraph.forward.get(from) ?? []) {
      if (edge.toSymbolId === to) {
        edgeKind = edge.kind as SymbolEdgeKind;
        break;
      }
    }

    if (!edgeKind) {
      // Check if it's a reverse traversal (to -> from in forward map)
      for (const edge of symbolGraph.forward.get(to) ?? []) {
        if (edge.toSymbolId === from) {
          edgeKind = edge.kind as SymbolEdgeKind;
          isReverse = true;
          break;
        }
      }
    }

    if (!edgeKind) {
      // Edge not found in graph; use minimum gamma
      gamma *= 0.3;
      continue;
    }

    const baseGamma = TRANSMISSION[edgeKind] ?? 0.3;
    gamma *= isReverse ? baseGamma * reverseMultiplier : baseGamma;
  }

  return gamma;
}

/**
 * Format edge kinds along a path as a readable chain.
 * e.g. "calls -> extends -> implements"
 */
function formatEdgeChain(path: number[], symbolGraph: InMemorySymbolGraph): string {
  const kinds: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const kind = findEdgeKind(path[i], path[i + 1], symbolGraph);
    kinds.push(kind ?? "unknown");
  }
  return kinds.join(" -> ");
}

// -- Main generator -----------------------------------------------------------

/**
 * Generate a structured Theory of Impact for a predicted file.
 *
 * Each non-zero signal produces a non-null evidence string. Zero signals
 * produce null (no evidence claimed). The graph path evidence includes
 * hop count, edge kinds and the cumulative gamma product.
 *
 * @param reverseMultiplier - multiplier for reverse-direction traversal
 *   (default 0.7, matching REVERSE_MULTIPLIER constant)
 */
export function generateTheoryOfImpact(
  file: string,
  signals: IntentPrediction["signals"],
  topSymbolId: number,
  propagationPaths: Map<number, number[]>,
  symbolGraph: InMemorySymbolGraph,
  seedFiles: Set<string>,
  changeCoupling: Map<string, Map<string, number>>,
  taskBetweenness: Map<number, number>,
  reverseMultiplier = 0.7,
): TheoryOfImpact {
  const result: TheoryOfImpact = {
    lexical_evidence: null,
    graph_path: null,
    temporal_pair: null,
    betweenness_rank: null,
  };

  // 1. Lexical evidence
  if (signals.lexical > 0) {
    const sym = symbolGraph.symbols.get(topSymbolId);
    if (sym) {
      result.lexical_evidence = `symbol '${sym.name}' in ${sym.filePath}`;
    }
  }

  // 2. Graph path evidence
  if (signals.graph > 0) {
    const path = propagationPaths.get(topSymbolId);
    if (path && path.length >= 2) {
      const hops = path.length - 1;
      const seedSym = symbolGraph.symbols.get(path[0]);
      const seedName = seedSym?.name ?? `symbol#${path[0]}`;
      const edgeChain = formatEdgeChain(path, symbolGraph);
      const gamma = computePathGamma(path, symbolGraph, reverseMultiplier);
      result.graph_path = `${hops}-hop from seed ${seedName} via ${edgeChain} (gamma: ${gamma.toFixed(2)})`;
    }
  }

  // 3. Temporal evidence
  if (signals.temporal > 0) {
    let bestSeed: string | null = null;
    let bestConf = 0;

    for (const seedFile of seedFiles) {
      // Check file -> seedFile coupling
      const conf1 = changeCoupling.get(file)?.get(seedFile) ?? 0;
      if (conf1 > bestConf) {
        bestConf = conf1;
        bestSeed = seedFile;
      }
      // Check seedFile -> file coupling (asymmetric maps)
      const conf2 = changeCoupling.get(seedFile)?.get(file) ?? 0;
      if (conf2 > bestConf) {
        bestConf = conf2;
        bestSeed = seedFile;
      }
    }

    if (bestSeed) {
      result.temporal_pair = `co-changed with ${bestSeed} (conf: ${bestConf.toFixed(2)})`;
    }
  }

  // 4. Betweenness evidence
  if (signals.betweenness > 0) {
    const symBetweenness = taskBetweenness.get(topSymbolId) ?? 0;
    const allValues = Array.from(taskBetweenness.values());
    if (allValues.length > 0) {
      const rank = allValues.filter((v) => v < symBetweenness).length / allValues.length;
      result.betweenness_rank = Math.round(rank * 100) / 100;
    }
  }

  return result;
}
