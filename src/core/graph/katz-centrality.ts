/**
 * Katz centrality solver for intent propagation.
 *
 * Replaces single-path Dijkstra with multi-path weighted centrality.
 * Katz centrality x = (I - alpha * A)^{-1} * seeds computes the
 * weighted sum of ALL walks from seeds, not just the shortest path.
 * This captures multi-path consensus: a symbol reachable via two
 * independent import chains scores higher than one reachable via
 * a single chain.
 *
 * Iterative solver: x_{k+1} = alpha * A^T * x_k + seeds
 * Convergence guaranteed for alpha < 1/rho(A).
 *
 * @deprecated propagateIntent in intent-propagation.ts is replaced by this module.
 */

import { GHOST_BASE_KIND, type SymbolEdgeKind } from "./symbol-types";
import type { SymbolSubgraph, SymbolSubEdge } from "./intent-subgraph";
import {
  KATZ_ALPHA_FRACTION,
  KATZ_MAX_ITERATIONS,
  KATZ_CONVERGENCE_EPSILON,
  KATZ_MIN_SCORE,
  KATZ_SPECTRAL_ITERATIONS,
} from "../config/semantic-constants";

// ── Edge weight ──────────────────────────────────────────────────────────────

/**
 * Compute the edge weight for Katz propagation.
 *
 * w = transmission[baseKind] * confidence * reverseMultiplier^isReverse * ghostDiscount^isGhost
 *
 * Differs from Dijkstra's edgeGamma by folding confidence into the weight
 * directly, rather than preserving it for a separate pathConfidence product.
 */
function katzEdgeWeight(
  edge: SymbolSubEdge,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
): number {
  const kindStr = edge.kind as string;
  const isGhost = kindStr.startsWith("ghost:");
  const baseKind = isGhost ? (GHOST_BASE_KIND[kindStr.slice(6)] ?? kindStr.slice(6)) : kindStr;
  const baseGamma = transmission[baseKind as SymbolEdgeKind];
  if (baseGamma === undefined) return 0;

  let w = baseGamma * edge.confidence;
  if (edge.isReverse) w *= reverseMultiplier;
  if (isGhost) w *= ghostDiscount;
  return w;
}

// ── Spectral radius estimation ───────────────────────────────────────────────

/**
 * Estimate spectral radius of the weighted subgraph adjacency matrix
 * via power iteration. Returns 0 for empty or disconnected graphs.
 */
export function estimateSpectralRadius(
  subgraph: SymbolSubgraph,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
  iterations: number = KATZ_SPECTRAL_ITERATIONS,
): number {
  const n = subgraph.nodes.size;
  if (n === 0) return 0;

  const nodeIds = Array.from(subgraph.nodes.keys());
  const invSqrtN = 1.0 / Math.sqrt(n);

  let v = new Map<number, number>();
  for (const id of nodeIds) v.set(id, invSqrtN);

  let rho = 0;

  for (let iter = 0; iter < iterations; iter++) {
    const y = new Map<number, number>();

    for (const [u, mass] of v) {
      for (const e of subgraph.forward.get(u) ?? []) {
        const w = katzEdgeWeight(e, transmission, reverseMultiplier, ghostDiscount);
        if (w <= 0) continue;
        y.set(e.targetId, (y.get(e.targetId) ?? 0) + w * mass);
      }
      for (const e of subgraph.reverse.get(u) ?? []) {
        const w = katzEdgeWeight(e, transmission, reverseMultiplier, ghostDiscount);
        if (w <= 0) continue;
        y.set(e.targetId, (y.get(e.targetId) ?? 0) + w * mass);
      }
    }

    let norm = 0;
    for (const val of y.values()) norm += val * val;
    norm = Math.sqrt(norm);

    if (norm === 0) return 0;
    rho = norm;

    v = new Map<number, number>();
    for (const [id, val] of y) v.set(id, val / norm);
  }

  return rho;
}

// ── Katz propagation ─────────────────────────────────────────────────────────

/**
 * Katz centrality propagation replacing Dijkstra intent propagation.
 *
 * Computes x = sum_{k=0}^{inf} alpha^k * A^k * seeds via iterative
 * relaxation. Multi-source: seeds are weighted by BM25F scores.
 *
 * Returns symbol_id -> normalized [0, 1] intent score. Scores below
 * KATZ_MIN_SCORE are dropped.
 *
 * @param seeds - symbol_id -> BM25F seed score
 * @param subgraph - extracted symbol neighborhood
 * @param transmission - gamma(kind) for each edge kind
 * @param reverseMultiplier - multiplier for reverse-direction traversal
 * @param ghostDiscount - multiplier for ghost edges
 */
export function propagateKatz(
  seeds: Map<number, number>,
  subgraph: SymbolSubgraph,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
): Map<number, number> {
  if (seeds.size === 0 || subgraph.nodes.size === 0) return new Map();

  // Filter seeds to nodes present in subgraph
  const seedBias = new Map<number, number>();
  for (const [id, score] of seeds) {
    if (subgraph.nodes.has(id)) seedBias.set(id, score);
  }
  if (seedBias.size === 0) return new Map();

  const rho = estimateSpectralRadius(subgraph, transmission, reverseMultiplier, ghostDiscount);
  if (rho <= 0) return normalizeAndFilter(seedBias);

  const alpha = KATZ_ALPHA_FRACTION / rho;
  let x = new Map(seedBias);

  for (let iter = 0; iter < KATZ_MAX_ITERATIONS; iter++) {
    const xNew = new Map(seedBias);

    // Push mass along all edges (bidirectional, matching Dijkstra traversal)
    for (const [u, mass] of x) {
      for (const e of subgraph.forward.get(u) ?? []) {
        const w = katzEdgeWeight(e, transmission, reverseMultiplier, ghostDiscount);
        if (w <= 0) continue;
        xNew.set(e.targetId, (xNew.get(e.targetId) ?? 0) + alpha * w * mass);
      }
      for (const e of subgraph.reverse.get(u) ?? []) {
        const w = katzEdgeWeight(e, transmission, reverseMultiplier, ghostDiscount);
        if (w <= 0) continue;
        xNew.set(e.targetId, (xNew.get(e.targetId) ?? 0) + alpha * w * mass);
      }
    }

    // L2 convergence check
    let l2Change = 0;
    for (const [id, val] of xNew) {
      const diff = val - (x.get(id) ?? 0);
      l2Change += diff * diff;
    }
    for (const [id] of x) {
      if (!xNew.has(id)) {
        const val = x.get(id) ?? 0;
        l2Change += val * val;
      }
    }
    l2Change = Math.sqrt(l2Change);

    x = xNew;
    if (l2Change < KATZ_CONVERGENCE_EPSILON) break;
  }

  return normalizeAndFilter(x);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function normalizeAndFilter(scores: Map<number, number>): Map<number, number> {
  let maxVal = 0;
  for (const val of scores.values()) {
    if (val > maxVal) maxVal = val;
  }
  if (maxVal <= 0) return new Map();

  const result = new Map<number, number>();
  for (const [id, val] of scores) {
    const normalized = val / maxVal;
    if (normalized >= KATZ_MIN_SCORE) {
      result.set(id, normalized);
    }
  }
  return result;
}
