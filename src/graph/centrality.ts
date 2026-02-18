import type { FileRole, ImportEdge, ImportGraph } from "../types.js";
import { buildAdjacency } from "../utils.js";
import { HITS, ROLE_THRESHOLDS } from "../config/thresholds.js";

/**
 * Compute HITS authority and hub scores for all files.
 *
 * Edge weight: (1 - typeOnlyDiscount) * dynamicDiscount * specificity
 * - typeOnlyDiscount = 0.7 if isTypeOnly, else 0
 * - dynamicDiscount = 0.5 if isDynamic, else 1.0
 * - specificity = log2(importedNames.length + 1) / log2(6), clamped min 0.2
 *
 * Barrel file correction: edges targeting barrel files contribute 0.3x authority.
 *
 * Uses teleportation smoothing (alpha=0.15) to avoid extreme score distributions
 * in star-shaped graphs. Hub update uses prior-iteration authority (standard HITS).
 */
export function computeHITS(
  files: string[],
  edges: ImportEdge[],
  /** Rationale: 30 iterations is sufficient for convergence on graphs up to ~5k nodes. Typical projects converge in 8-15. */
  maxIterations = 30,
  /** Rationale: 1e-6 precision catches meaningful score differences while avoiding float noise. */
  epsilon = 1e-6,
  barrelFiles?: Set<string>,
): { authority: Map<string, number>; hub: Map<string, number> } {
  const n = files.length;
  if (n === 0) return { authority: new Map(), hub: new Map() };

  // Single file: HITS would produce 0/0 after normalization. Assign neutral scores.
  if (n === 1) {
    return {
      authority: new Map([[files[0], 0.5]]),
      hub: new Map([[files[0], 0.5]]),
    };
  }

  const fileSet = new Set(files);
  const barrels = barrelFiles ?? new Set<string>();
  const alpha = HITS.TELEPORT_ALPHA;
  const baseScore = 1 / n;

  // Build weighted adjacency lists (internal edges only)
  // forward: from -> [{to, weight}]   (for hub update)
  // reverse: to -> [{from, weight}]   (for authority update)
  const forward = new Map<string, Array<{ to: string; weight: number }>>();
  const reverse = new Map<string, Array<{ from: string; weight: number }>>();
  for (const file of files) {
    forward.set(file, []);
    reverse.set(file, []);
  }

  for (const edge of edges) {
    if (edge.isExternal) continue;
    if (!fileSet.has(edge.from) || !fileSet.has(edge.to)) continue;

    const typeOnlyDiscount = edge.isTypeOnly ? HITS.TYPE_ONLY_DISCOUNT : 0;
    const dynamicDiscount = edge.isDynamic ? HITS.DYNAMIC_MULTIPLIER : 1.0;
    const nameCount = edge.importedNames.length;
    const specificity =
      nameCount > 0
        ? Math.max(HITS.MIN_SPECIFICITY, Math.log2(nameCount + 1) / Math.log2(HITS.SPECIFICITY_LOG_BASE))
        : HITS.MIN_SPECIFICITY;
    let weight = (1 - typeOnlyDiscount) * dynamicDiscount * specificity;

    // Barrel file authority discount: edges targeting barrels contribute less
    if (barrels.has(edge.to)) {
      weight *= HITS.BARREL_DISCOUNT;
    }

    // Barrel outgoing discount: re-exports contribute less authority to targets.
    // If both edge.from and edge.to are barrels, the discount compounds to
    // BARREL_DISCOUNT^2 (e.g. 0.3 * 0.3 = 0.09). This is intentional:
    // barrel-to-barrel edges (a re-export file re-exporting from another re-export
    // file) are very low signal and should contribute negligibly to scores.
    if (barrels.has(edge.from)) {
      weight *= HITS.BARREL_DISCOUNT;
    }

    forward.get(edge.from)!.push({ to: edge.to, weight });
    reverse.get(edge.to)!.push({ from: edge.from, weight });
  }

  let auth = new Float64Array(n).fill(1);
  let hub = new Float64Array(n).fill(1);
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) fileIndex.set(files[i], i);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAuth = new Float64Array(n);
    const newHub = new Float64Array(n);

    // Update authorities with teleportation:
    // newAuth[v] = alpha * baseScore + (1 - alpha) * Σ hub[u] * w(u->v)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { from, weight } of reverse.get(file)!) {
        sum += hub[fileIndex.get(from)!] * weight;
      }
      newAuth[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // Update hubs with teleportation (using PRIOR auth, not newAuth):
    // newHub[v] = alpha * baseScore + (1 - alpha) * Σ auth[w] * w(v->w)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { to, weight } of forward.get(file)!) {
        sum += auth[fileIndex.get(to)!] * weight;
      }
      newHub[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // L2 normalize
    let authNorm = 0;
    let hubNorm = 0;
    for (let i = 0; i < n; i++) {
      authNorm += newAuth[i] * newAuth[i];
      hubNorm += newHub[i] * newHub[i];
    }
    authNorm = Math.sqrt(authNorm) || 1;
    hubNorm = Math.sqrt(hubNorm) || 1;
    for (let i = 0; i < n; i++) {
      newAuth[i] /= authNorm;
      newHub[i] /= hubNorm;
    }

    // Convergence check
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newAuth[i] - auth[i]) + Math.abs(newHub[i] - hub[i]));
    }

    auth = newAuth;
    hub = newHub;

    if (maxDelta < epsilon) break;
  }

  // Min-max normalize to 0-1
  let authMin = Infinity,
    authMax = -Infinity;
  let hubMin = Infinity,
    hubMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (auth[i] < authMin) authMin = auth[i];
    if (auth[i] > authMax) authMax = auth[i];
    if (hub[i] < hubMin) hubMin = hub[i];
    if (hub[i] > hubMax) hubMax = hub[i];
  }
  const NORM_EPSILON = 1e-9;
  const authRange = authMax - authMin;
  const hubRange = hubMax - hubMin;

  const authorityMap = new Map<string, number>();
  const hubMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    authorityMap.set(files[i], authRange > NORM_EPSILON ? (auth[i] - authMin) / authRange : 0);
    hubMap.set(files[i], hubRange > NORM_EPSILON ? (hub[i] - hubMin) / hubRange : 0);
  }

  return { authority: authorityMap, hub: hubMap };
}

/**
 * Derive a functional role from HITS authority and hub scores.
 * If isBarrel is true, the file always gets the "Barrel" role (checked before thresholds).
 *
 * Thresholds (0.6, 0.3, 0.4) are empirically tuned for typical project distributions
 * after min-max normalization of HITS scores. Boundary instability is expected in
 * small graphs (<10 files) where score ranges compress.
 *
 * @see docs/algorithm-tuning.md
 */
export function deriveRole(authority: number, hubScore: number, isBarrel = false): FileRole {
  if (isBarrel) return "Barrel";
  if (authority > ROLE_THRESHOLDS.FOUNDATION_AUTH && hubScore < ROLE_THRESHOLDS.FOUNDATION_HUB_MAX) return "Foundation";
  if (hubScore > ROLE_THRESHOLDS.ORCHESTRATOR_HUB && authority < ROLE_THRESHOLDS.ORCHESTRATOR_AUTH_MAX)
    return "Orchestrator";
  if (authority > ROLE_THRESHOLDS.BRIDGE_MIN && hubScore > ROLE_THRESHOLDS.BRIDGE_MIN) return "Bridge";
  if (
    authority >= ROLE_THRESHOLDS.UTILITY_AUTH_MIN &&
    authority <= ROLE_THRESHOLDS.UTILITY_AUTH_MAX &&
    hubScore < ROLE_THRESHOLDS.UTILITY_HUB_MAX
  )
    return "Utility";
  return "Leaf";
}

/**
 * Compute a simple deterministic hash from a string.
 * Used to seed the random sampler for reproducible betweenness results.
 */
export function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned
}

/**
 * Simple seeded PRNG (xorshift32). Returns values in [0, 1).
 */
export function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Compute approximate betweenness centrality using sampled Brandes algorithm.
 *
 * Full Brandes is O(V*E); this samples min(k, V) source nodes for O(k*E).
 * Uses BFS on an undirected view of the import graph, tracking predecessors,
 * path counts (sigma), and dependency scores (delta).
 *
 * Results are normalized to 0-1 range (divided by max score).
 * Uses a seeded random for deterministic results across runs.
 */
export function computeBetweenness(
  graph: ImportGraph,
  /** Rationale: 50 samples gives <5% error on graphs up to ~2k nodes (empirically validated). Full Brandes is O(V*E); sampling keeps it O(k*E). */
  k = 50,
): Map<string, number> {
  // Build directed adjacency from internal edges.
  // We follow the actual import direction (importer -> imported) so betweenness
  // measures how many directed dependency chains pass through a file. A true
  // bottleneck sits on many transitive import paths; undirected conversion inflates
  // scores for leaf files that gain reverse-direction paths they don't actually have.
  const { adj, allFiles } = buildAdjacency(graph.edges, { directed: true });

  const files = [...allFiles].sort();
  const n = files.length;
  if (n === 0) return new Map();

  const betweenness = new Map<string, number>();
  for (const f of files) betweenness.set(f, 0);

  // Seed from sorted file list hash for determinism
  const seedStr = files.join(",");
  const rng = seededRandom(simpleHash(seedStr));

  const sampleSize = Math.min(k, n);
  let sources: string[];

  if (sampleSize >= n) {
    sources = files;
  } else {
    // Degree-proportional sampling: high-degree nodes produce more representative
    // shortest-path trees, reducing variance in the betweenness estimator.
    const shuffled = [...files];
    for (let i = 0; i < sampleSize; i++) {
      let totalWeight = 0;
      for (let j = i; j < n; j++) {
        totalWeight += (adj.get(shuffled[j])?.size ?? 0) + 1;
      }
      let target = rng() * totalWeight;
      let chosen = i;
      for (let j = i; j < n; j++) {
        target -= (adj.get(shuffled[j])?.size ?? 0) + 1;
        if (target <= 0) {
          chosen = j;
          break;
        }
      }
      [shuffled[i], shuffled[chosen]] = [shuffled[chosen], shuffled[i]];
    }
    sources = shuffled.slice(0, sampleSize);
  }

  // Brandes single-source BFS for each sampled source
  for (const s of sources) {
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const f of files) {
      pred.set(f, []);
      sigma.set(f, 0);
      dist.set(f, -1);
      delta.set(f, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];
    let qHead = 0;

    while (qHead < queue.length) {
      const v = queue[qHead++];
      stack.push(v);

      const dv = dist.get(v)!;
      for (const w of adj.get(v) ?? []) {
        // w found for the first time?
        if (dist.get(w)! < 0) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        // Shortest path to w via v?
        if (dist.get(w) === dv + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    // Accumulate dependencies (back-propagation)
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contribution);
      }
      if (w !== s) {
        betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
      }
    }
  }

  let maxScore = 0;
  for (const score of betweenness.values()) {
    if (score > maxScore) maxScore = score;
  }

  if (maxScore > 0) {
    for (const [file, score] of betweenness) {
      betweenness.set(file, score / maxScore);
    }
  }

  return betweenness;
}
