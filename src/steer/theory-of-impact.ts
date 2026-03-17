/**
 * RFC-002 SS2.3: Theory of Impact generator.
 *
 * Synthesizes Phase 1 fusion signals into structured evidence for each
 * predicted file. Each non-zero signal produces a human/AI-readable
 * explanation linking specific symbol relationships to the user's intent.
 *
 * Anti-fabrication: returns null for graph_path when any edge in the
 * Dijkstra path is unresolvable in the current graph state.
 */

import type { InMemorySymbolGraph } from "../storage/types";
import type { TheoryOfImpact, IntentPrediction } from "../core/config/intent-constants";
import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import { TRANSMISSION } from "../core/config/intent-constants";

// -- Tokenization -------------------------------------------------------------

/**
 * Split a string into lowercase tokens on non-alphanumeric boundaries
 * and camelCase transitions. Filters out single-char tokens.
 */
function tokenize(s: string): string[] {
  return s
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((word) => word.split(/(?=[A-Z])/))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length > 1);
}

// -- Path metrics -------------------------------------------------------------

interface PathMetrics {
  gamma: number;
  confidence: number;
  edgeKinds: string[];
}

/**
 * Compute transmission gamma, confidence product and edge kinds along a path.
 *
 * Returns null if any edge in the path is unresolvable (anti-fabrication).
 * Never substitutes fallback values for missing edges.
 */
function computePathMetrics(
  path: number[],
  symbolGraph: InMemorySymbolGraph,
  reverseMultiplier: number,
): PathMetrics | null {
  if (path.length < 2) return { gamma: 1.0, confidence: 1.0, edgeKinds: [] };

  let gamma = 1.0;
  let confidence = 1.0;
  const edgeKinds: string[] = [];

  for (let i = 0; i < path.length - 1; i++) {
    const from = path[i];
    const to = path[i + 1];

    let edgeKind: SymbolEdgeKind | null = null;
    let edgeConf = 1.0;
    let isReverse = false;

    // Forward: from -> to
    for (const edge of symbolGraph.forward.get(from) ?? []) {
      if (edge.toSymbolId === to) {
        edgeKind = edge.kind as SymbolEdgeKind;
        edgeConf = edge.confidence ?? 1.0;
        break;
      }
    }

    // Reverse: to -> from in forward map (traversed against direction)
    if (!edgeKind) {
      for (const edge of symbolGraph.forward.get(to) ?? []) {
        if (edge.toSymbolId === from) {
          edgeKind = edge.kind as SymbolEdgeKind;
          edgeConf = edge.confidence ?? 1.0;
          isReverse = true;
          break;
        }
      }
    }

    // Anti-fabrication: edge not found -> return null, never fabricate
    if (!edgeKind) return null;

    const baseGamma = TRANSMISSION[edgeKind];
    if (baseGamma === undefined) return null;

    gamma *= isReverse ? baseGamma * reverseMultiplier : baseGamma;
    confidence *= edgeConf;
    edgeKinds.push(edgeKind);
  }

  return { gamma, confidence, edgeKinds };
}

// -- Main generator -----------------------------------------------------------

/**
 * Generate a structured Theory of Impact for a predicted file.
 *
 * Each non-zero signal produces a non-null evidence string. Zero signals
 * produce null (no evidence claimed). The graph path evidence includes
 * hop count, edge kinds, cumulative gamma product and confidence product.
 *
 * @param query - the user's original task prompt (for token intersection)
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
  query: string,
  reverseMultiplier = 0.7,
): TheoryOfImpact {
  const result: TheoryOfImpact = {
    lexical_evidence: null,
    graph_path: null,
    temporal_pair: null,
    betweenness_rank: null,
  };

  // 1. Lexical evidence (query token intersection)
  if (signals.rawLexical > 0) {
    const sym = symbolGraph.symbols.get(topSymbolId);
    if (sym) {
      const queryTokens = new Set(tokenize(query));
      const nameMatches = tokenize(sym.name).filter((t) => queryTokens.has(t));
      const pathMatches = tokenize(sym.filePath).filter((t) => queryTokens.has(t));

      if (nameMatches.length > 0) {
        result.lexical_evidence = `tokens '${nameMatches.join("', '")}' match symbol name '${sym.name}'`;
      } else if (pathMatches.length > 0) {
        result.lexical_evidence = `tokens '${pathMatches.join("', '")}' match path '${sym.filePath}'`;
      } else {
        // Fallback when query tokens don't overlap (e.g. synonym matching in BM25+)
        result.lexical_evidence = `symbol '${sym.name}' in ${sym.filePath}`;
      }
    }
  }

  // 2. Graph path evidence (with confidence product, anti-fabrication)
  if (signals.graph > 0) {
    const path = propagationPaths.get(topSymbolId);
    if (path && path.length >= 2) {
      const metrics = computePathMetrics(path, symbolGraph, reverseMultiplier);
      if (metrics) {
        const hops = path.length - 1;
        const seedSym = symbolGraph.symbols.get(path[0]);
        const seedName = seedSym?.name ?? `symbol#${path[0]}`;
        const edgeChain = metrics.edgeKinds.join(" -> ");
        result.graph_path =
          `${hops}-hop from seed ${seedName} via ${edgeChain}` +
          ` (gamma: ${metrics.gamma.toFixed(2)}, confidence: ${metrics.confidence.toFixed(2)})`;
      }
      // metrics === null -> edge unresolvable, graph_path stays null (anti-fabrication)
    }
  }

  // 3. Temporal evidence
  if (signals.temporal > 0) {
    let bestSeed: string | null = null;
    let bestConf = 0;

    for (const seedFile of seedFiles) {
      const conf1 = changeCoupling.get(file)?.get(seedFile) ?? 0;
      if (conf1 > bestConf) {
        bestConf = conf1;
        bestSeed = seedFile;
      }
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
