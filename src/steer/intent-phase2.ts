/**
 * Betweenness chokepoint re-propagation seeding.
 *
 * After initial Dijkstra propagation, identifies structural chokepoints in the task
 * subgraph that received negligible intent signal. Re-propagates 1 hop
 * from these chokepoints and merges via max.
 *
 * Betweenness is computed via full Brandes on the symbol subgraph
 * (~500 nodes, O(V*E) ~ 500K ops, well within the 20ms budget).
 */

import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { SymbolSubgraph } from "../core/graph/intent-subgraph";
import { propagateKatz } from "../core/graph/katz-centrality";
import { BETWEENNESS_PERCENTILE, INTENT_MIN } from "../core/config/intent-constants";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Phase2Result {
  /** symbol_id -> max(phase1, phase2) score */
  mergedScores: Map<number, number>;
  /** Symbol IDs identified as chokepoints */
  chokepoints: number[];
  /** Whether chokepoint re-propagation ran */
  phase2Triggered: boolean;
}

// ── Brandes betweenness on symbol subgraph ──────────────────────────────────

/**
 * Full Brandes betweenness centrality on the directed symbol subgraph.
 * Returns normalized scores in [0, 1].
 *
 * Since |V_tau| ~ 500, full (not sampled) Brandes is tractable.
 * Uses only forward edges (import direction).
 */
export function computeSubgraphBetweenness(subgraph: SymbolSubgraph): Map<number, number> {
  const nodeIds = Array.from(subgraph.nodes.keys());
  const n = nodeIds.length;
  if (n <= 2) return new Map(nodeIds.map((id) => [id, 0]));

  // Map symbol IDs to contiguous indices for typed-array access
  const idToIdx = new Map<number, number>();
  for (let i = 0; i < n; i++) idToIdx.set(nodeIds[i], i);

  // Pre-build index-based adjacency (avoids Map lookups in inner loop)
  const adj: number[][] = new Array(n);
  for (let i = 0; i < n; i++) {
    const edges = subgraph.forward.get(nodeIds[i]);
    adj[i] = [];
    if (edges) {
      for (const e of edges) {
        const idx = idToIdx.get(e.targetId);
        if (idx !== undefined) adj[i].push(idx);
      }
    }
  }

  // Allocate working arrays once, reuse per source via .fill()
  const cb = new Float64Array(n);
  const sigma = new Float64Array(n);
  const d = new Int32Array(n);
  const delta = new Float64Array(n);
  const pred: number[][] = new Array(n);
  for (let i = 0; i < n; i++) pred[i] = [];
  const stack = new Int32Array(n);
  const queue = new Int32Array(n);

  for (let si = 0; si < n; si++) {
    // Reset working arrays
    sigma.fill(0);
    d.fill(-1);
    delta.fill(0);
    for (let i = 0; i < n; i++) pred[i].length = 0;

    sigma[si] = 1;
    d[si] = 0;

    let stackTop = 0;
    let qHead = 0;
    let qTail = 0;
    queue[qTail++] = si;

    // BFS from si using forward edges only
    while (qHead < qTail) {
      const v = queue[qHead++];
      stack[stackTop++] = v;
      const dv = d[v];

      for (const w of adj[v]) {
        if (d[w] < 0) {
          d[w] = dv + 1;
          queue[qTail++] = w;
        }
        if (d[w] === dv + 1) {
          sigma[w] += sigma[v];
          pred[w].push(v);
        }
      }
    }

    // Accumulation phase (reverse topological order)
    while (stackTop > 0) {
      const w = stack[--stackTop];
      const sigmaW = sigma[w];
      if (sigmaW === 0) continue;

      for (const v of pred[w]) {
        delta[v] += (sigma[v] / sigmaW) * (1 + delta[w]);
      }
      if (w !== si) {
        cb[w] += delta[w];
      }
    }
  }

  // Normalize to [0, 1] and convert back to Map
  let maxCb = 0;
  for (let i = 0; i < n; i++) if (cb[i] > maxCb) maxCb = cb[i];

  const result = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    result.set(nodeIds[i], maxCb > 0 ? cb[i] / maxCb : 0);
  }

  return result;
}

// ── Percentile computation ──────────────────────────────────────────────────

/**
 * Exclusive percentile: 0th = min, 100th = max.
 *
 * Deliberate improvement over the original floor(p * n) formula.
 * That formula selects the maximum value as the threshold when
 * floor(p * n) = n - 1, creating a dead zone where no element can
 * strictly exceed it. This makes chokepoint detection impossible for
 * small subgraphs (n < 8). Using floor(p * (n - 1)) instead guarantees
 * at least one element above the threshold when distinct values exist.
 * For large n the difference is one index position.
 */
function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.floor(p * (sorted.length - 1));
  return sorted[idx];
}

// ── Chokepoint seeding ──────────────────────────────────────────────────────

/**
 * Identify structural chokepoints that received negligible initial propagation intent
 * and re-propagate from them.
 *
 * A chokepoint is a symbol with:
 *   betweenness > 75th percentile AND initial score < INTENT_MIN (0.1)
 *
 * Re-propagation runs 1 hop from chokepoints. Final scores are max-merged
 * with initial scores to prevent double-counting.
 */
export function applyPhase2Seeding(
  phase1Scores: Map<number, number>,
  subgraph: SymbolSubgraph,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
): Phase2Result {
  // Compute task-scoped betweenness
  const betweenness = computeSubgraphBetweenness(subgraph);

  // Determine threshold
  const bValues = Array.from(betweenness.values());
  const bThreshold = percentile(bValues, BETWEENNESS_PERCENTILE);

  // Identify chokepoints: high betweenness + low phase1 score
  const chokepoints: number[] = [];
  for (const [id, b] of betweenness) {
    if (b > bThreshold && (phase1Scores.get(id) ?? 0) < INTENT_MIN) {
      chokepoints.push(id);
    }
  }

  // No chokepoints -> return phase1 scores unchanged
  if (chokepoints.length === 0) {
    return {
      mergedScores: new Map(phase1Scores),
      chokepoints: [],
      phase2Triggered: false,
    };
  }

  // Re-propagate from chokepoints with score 1.0 each
  const chokeSeeds = new Map<number, number>();
  for (const id of chokepoints) chokeSeeds.set(id, 1.0);

  const phase2Scores = propagateKatz(chokeSeeds, subgraph, transmission, reverseMultiplier, ghostDiscount);

  // Max-merge: for each symbol, take max(phase1, phase2)
  const mergedScores = new Map<number, number>();
  const allIds = new Set([...phase1Scores.keys(), ...phase2Scores.keys()]);
  for (const id of allIds) {
    mergedScores.set(id, Math.max(phase1Scores.get(id) ?? 0, phase2Scores.get(id) ?? 0));
  }

  return { mergedScores, chokepoints, phase2Triggered: true };
}
