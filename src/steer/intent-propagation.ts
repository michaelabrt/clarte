/**
 * RFC-002 §1.5: Dijkstra-based intent propagation on the symbol subgraph.
 *
 * Computes max-product paths (max_pi prod gamma(u,v)) by transforming
 * to shortest paths in -log(gamma) space. Multi-source Dijkstra from
 * seed symbols with hop-limited relaxation.
 *
 * Numerical bounds: min gamma = 0.126 (ghost uses_type reverse:
 * 0.3 * 0.7 * 0.6), max 3-hop distance = 3 * -ln(0.126) ~ 6.2,
 * min score = e^-6.2 ~ 0.002. Well above float64 precision.
 */

import type { SymbolEdgeKind } from "../core/graph/symbol-types";
import type { SymbolSubgraph, SymbolSubEdge } from "../core/graph/intent-subgraph";

// ── Types ───────────────────────────────────────────────────────────────────

export interface PropagationResult {
  /** symbol_id -> propagated intent score G(s, q) in [0, 1] */
  scores: Map<number, number>;
  /** symbol_id -> path of symbol_ids from nearest seed */
  paths: Map<number, number[]>;
  /** symbol_id -> hop count from nearest seed */
  hops: Map<number, number>;
}

// ── Binary min-heap ─────────────────────────────────────────────────────────
// Array-backed for ~500-node subgraphs. No Fibonacci heap needed.

interface HeapEntry {
  id: number;
  dist: number;
}

class MinHeap {
  private data: HeapEntry[] = [];

  get size(): number {
    return this.data.length;
  }

  push(entry: HeapEntry): void {
    this.data.push(entry);
    this.siftUp(this.data.length - 1);
  }

  pop(): HeapEntry | undefined {
    const top = this.data[0];
    const last = this.data.pop();
    if (this.data.length > 0 && last) {
      this.data[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private siftUp(i: number): void {
    const d = this.data;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (d[parent].dist <= d[i].dist) break;
      [d[parent], d[i]] = [d[i], d[parent]];
      i = parent;
    }
  }

  private siftDown(i: number): void {
    const d = this.data;
    const n = d.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && d[left].dist < d[smallest].dist) smallest = left;
      if (right < n && d[right].dist < d[smallest].dist) smallest = right;
      if (smallest === i) break;
      [d[smallest], d[i]] = [d[i], d[smallest]];
      i = smallest;
    }
  }
}

// ── Propagation ─────────────────────────────────────────────────────────────

/**
 * Compute the edge gamma for a subgraph edge.
 *
 * gamma = transmission[kind], modified by reverse multiplier and ghost
 * discount. Resolution confidence is NOT applied here (RFC-002 §1.5):
 * propagation transmits full signal regardless of resolution tier.
 * Confidence is preserved on the edge for downstream consumers (ToI,
 * verification) but does not attenuate gamma.
 *
 * Returns 0 for unknown/ghost kinds that have no base transmission entry,
 * which the caller skips via the degenerate-edge guard.
 */
function edgeGamma(
  edge: SymbolSubEdge,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
): number {
  // Resolve base kind: strip "ghost:" prefix for Phase 5 ghost edges.
  const kindStr = edge.kind as string;
  const isGhost = kindStr.startsWith("ghost:");
  const baseKind = isGhost ? kindStr.slice(6) : kindStr;

  const baseGamma = transmission[baseKind as SymbolEdgeKind];
  if (baseGamma === undefined) return 0; // unknown kind fallback

  let gamma = baseGamma;
  if (edge.isReverse) gamma *= reverseMultiplier;
  if (isGhost) gamma *= ghostDiscount;
  return gamma;
}

/**
 * Multi-source Dijkstra intent propagation in -log(gamma) space.
 *
 * Seeds are initialized at distance 0 (score 1.0). Intent transmits along
 * edges with gamma coefficients; the max-product path wins (= shortest
 * path in -log space). Hop counting enforces the depth limit.
 *
 * @param seeds - symbol_id -> seed lexical score L(s, q). Score values are
 *   not used in propagation (seeds always start at distance 0 / score 1.0);
 *   they are consumed later by the fusion layer.
 * @param subgraph - extracted symbol neighborhood
 * @param transmission - gamma(kind) for each edge kind
 * @param reverseMultiplier - multiplier for reverse-direction traversal
 * @param ghostDiscount - multiplier for ghost edges
 * @param maxHops - maximum path length in edges
 */
export function propagateIntent(
  seeds: Map<number, number>,
  subgraph: SymbolSubgraph,
  transmission: Record<SymbolEdgeKind, number>,
  reverseMultiplier: number,
  ghostDiscount: number,
  maxHops: number,
): PropagationResult {
  const dist = new Map<number, number>();
  const hopCount = new Map<number, number>();
  const prev = new Map<number, number>();
  const finalized = new Set<number>();

  const pq = new MinHeap();

  // Initialize seeds at distance 0
  for (const [seedId] of seeds) {
    if (!subgraph.nodes.has(seedId)) continue;
    dist.set(seedId, 0);
    hopCount.set(seedId, 0);
    pq.push({ id: seedId, dist: 0 });
  }

  // Dijkstra main loop
  while (pq.size > 0) {
    const entry = pq.pop();
    if (!entry) break;
    const { id: u, dist: uDist } = entry;

    // Skip stale entries (we push duplicates instead of decreaseKey)
    if (finalized.has(u)) continue;
    finalized.add(u);

    const uHops = hopCount.get(u) ?? 0;

    // Iterate all neighbors: forward edges (natural direction) + reverse edges (against direction)
    const neighbors: SymbolSubEdge[] = [];
    const fwd = subgraph.forward.get(u);
    if (fwd) for (const e of fwd) neighbors.push(e);
    const rev = subgraph.reverse.get(u);
    if (rev) for (const e of rev) neighbors.push(e);

    for (const edge of neighbors) {
      const v = edge.targetId;
      if (finalized.has(v)) continue;

      const newHops = uHops + 1;
      if (newHops > maxHops) continue;

      const gamma = edgeGamma(edge, transmission, reverseMultiplier, ghostDiscount);
      if (!(gamma > 0) || gamma > 1) continue; // NaN-safe: !(NaN > 0) is true

      const edgeDist = -Math.log(gamma);
      const newDist = uDist + edgeDist;

      const currentDist = dist.get(v);
      if (currentDist === undefined || newDist < currentDist) {
        dist.set(v, newDist);
        hopCount.set(v, newHops);
        prev.set(v, u);
        pq.push({ id: v, dist: newDist });
      }
    }
  }

  // Convert distances to propagation scores: G(s) = exp(-dist[s])
  const scores = new Map<number, number>();
  for (const [id, d] of dist) {
    scores.set(id, seeds.has(id) ? 1.0 : Math.exp(-d));
  }

  // Reconstruct paths
  const paths = new Map<number, number[]>();
  for (const [id] of dist) {
    if (seeds.has(id)) {
      paths.set(id, []);
      continue;
    }
    const path: number[] = [];
    let cur = id;
    while (prev.has(cur)) {
      path.push(cur);
      cur = prev.get(cur) ?? cur;
    }
    path.push(cur); // the seed
    path.reverse();
    paths.set(id, path);
  }

  return { scores, paths, hops: hopCount };
}

// ── Path confidence products ────────────────────────────────────────────────

/**
 * Compute the product of edge resolution confidences along each Dijkstra path.
 *
 * For each symbol reached by propagation, walks the winning path and
 * multiplies the confidence values from each traversed edge.
 * Seeds (empty path) get confidence 1.0.
 *
 * Used by the orchestrator to populate FusionInput.pathConfidence before
 * calling fuseIntentScores. This ensures Tier-3 factory resolutions
 * (confidence=0.25) are penalized multiplicatively.
 */
export function computePathConfidenceProducts(
  paths: Map<number, number[]>,
  subgraph: SymbolSubgraph,
): Map<number, number> {
  const result = new Map<number, number>();

  for (const [symbolId, path] of paths) {
    if (path.length < 2) {
      result.set(symbolId, 1.0);
      continue;
    }

    let product = 1.0;
    for (let i = 0; i < path.length - 1; i++) {
      const u = path[i];
      const v = path[i + 1];
      let edgeConf: number | undefined;

      // Check forward edges from u to v
      for (const edge of subgraph.forward.get(u) ?? []) {
        if (edge.targetId === v) {
          edgeConf = edge.confidence;
          break;
        }
      }

      // Check reverse edges from u to v (traversed against direction)
      if (edgeConf === undefined) {
        for (const edge of subgraph.reverse.get(u) ?? []) {
          if (edge.targetId === v) {
            edgeConf = edge.confidence;
            break;
          }
        }
      }

      product *= edgeConf ?? 1.0;
    }

    result.set(symbolId, product);
  }

  return result;
}
