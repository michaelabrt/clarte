/**
 * RFC-002 §1.4: Phase 2 seeding - betweenness chokepoint re-propagation.
 *
 * After Phase 1 Dijkstra, identifies structural chokepoints in the task
 * subgraph that received negligible intent signal. Re-propagates 1 hop
 * from these chokepoints and merges via max.
 *
 * Betweenness is computed via full Brandes on the symbol subgraph
 * (~500 nodes, O(V*E) ~ 500K ops, well within the 20ms budget).
 */

import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { SymbolSubgraph } from "../core/graph/intent-subgraph";
import { propagateIntent } from "./intent-propagation";
import { BETWEENNESS_PERCENTILE, INTENT_MIN, PHASE2_MAX_HOPS } from "../core/config/intent-constants";

// ── Types ───────────────────────────────────────────────────────────────────

export interface Phase2Result {
  /** symbol_id -> max(phase1, phase2) score */
  mergedScores: Map<number, number>;
  /** Symbol IDs identified as chokepoints */
  chokepoints: number[];
  /** Whether Phase 2 actually ran */
  phase2Triggered: boolean;
}

// ── Brandes betweenness on symbol subgraph ──────────────────────────────────

/**
 * Full Brandes betweenness centrality on the directed symbol subgraph.
 * Returns normalized scores in [0, 1].
 *
 * Since |V_tau| ~ 500, full (not sampled) Brandes is tractable.
 * Uses only forward edges (import direction) per RFC specification.
 */
export function computeSubgraphBetweenness(subgraph: SymbolSubgraph): Map<number, number> {
  const nodeIds = Array.from(subgraph.nodes.keys());
  const n = nodeIds.length;
  if (n <= 2) return new Map(nodeIds.map((id) => [id, 0]));

  const cb = new Map<number, number>();
  for (const id of nodeIds) cb.set(id, 0);

  // Brandes single-source BFS for each source node
  for (const s of nodeIds) {
    const stack: number[] = [];
    const pred = new Map<number, number[]>();
    const sigma = new Map<number, number>();
    const d = new Map<number, number>();
    const delta = new Map<number, number>();

    for (const v of nodeIds) {
      pred.set(v, []);
      sigma.set(v, 0);
      d.set(v, -1);
      delta.set(v, 0);
    }
    sigma.set(s, 1);
    d.set(s, 0);

    // BFS from s using forward edges only
    const queue: number[] = [s];
    let head = 0;
    while (head < queue.length) {
      const v = queue[head++];
      stack.push(v);
      const dv = d.get(v) ?? 0;

      for (const edge of subgraph.forward.get(v) ?? []) {
        const w = edge.targetId;
        if (!subgraph.nodes.has(w)) continue;

        // First time discovering w
        if ((d.get(w) ?? -1) < 0) {
          d.set(w, dv + 1);
          queue.push(w);
        }
        // Shortest path to w via v
        if (d.get(w) === dv + 1) {
          sigma.set(w, (sigma.get(w) ?? 0) + (sigma.get(v) ?? 0));
          pred.get(w)?.push(v);
        }
      }
    }

    // Accumulation phase (reverse topological order)
    while (stack.length > 0) {
      const w = stack.pop() as number;
      const sigmaW = sigma.get(w) ?? 1;
      if (sigmaW === 0) continue;

      for (const v of pred.get(w) ?? []) {
        const contribution = ((sigma.get(v) ?? 0) / sigmaW) * (1 + (delta.get(w) ?? 0));
        delta.set(v, (delta.get(v) ?? 0) + contribution);
      }
      if (w !== s) {
        cb.set(w, (cb.get(w) ?? 0) + (delta.get(w) ?? 0));
      }
    }
  }

  // Normalize to [0, 1]
  let maxCb = 0;
  for (const [, v] of cb) if (v > maxCb) maxCb = v;

  if (maxCb > 0) {
    for (const [id, v] of cb) cb.set(id, v / maxCb);
  }

  return cb;
}

// ── Percentile computation ──────────────────────────────────────────────────

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = values.slice().sort((a, b) => a - b);
  const idx = Math.floor(p * sorted.length);
  return sorted[Math.min(idx, sorted.length - 1)];
}

// ── Phase 2 seeding ─────────────────────────────────────────────────────────

/**
 * Identify structural chokepoints that received negligible Phase 1 intent
 * and re-propagate from them.
 *
 * A chokepoint is a symbol with:
 *   betweenness > 75th percentile AND phase1Score < INTENT_MIN (0.1)
 *
 * Re-propagation runs 1 hop from chokepoints. Final scores are max-merged
 * with Phase 1 scores to prevent double-counting.
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

  const phase2 = propagateIntent(chokeSeeds, subgraph, transmission, reverseMultiplier, ghostDiscount, PHASE2_MAX_HOPS);

  // Max-merge: for each symbol, take max(phase1, phase2)
  const mergedScores = new Map<number, number>();
  const allIds = new Set([...phase1Scores.keys(), ...phase2.scores.keys()]);
  for (const id of allIds) {
    mergedScores.set(id, Math.max(phase1Scores.get(id) ?? 0, phase2.scores.get(id) ?? 0));
  }

  return { mergedScores, chokepoints, phase2Triggered: true };
}
