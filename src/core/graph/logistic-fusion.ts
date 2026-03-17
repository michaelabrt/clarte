/**
 * Repository-specific auto-tuning of fusion weights via logistic regression.
 *
 * Trains a custom lambda vector [lambda_L, lambda_G, lambda_T, lambda_B]
 * from commit history. Uses pairwise co-change as ground truth and tiered
 * hard negative mining to learn the boundary between "structurally related"
 * and "actually co-changed."
 *
 * The training runs during offline indexing; the learned weights are stored
 * in the meta table and applied at query time. Fusion formula stays O(1).
 */

import type { InMemoryFileGraph } from "../../storage/types";
import type { ParsedCommit } from "../git/analysis";
import {
  FUSION_TRAINING_COMMITS,
  FUSION_NEGATIVE_RATIO,
  FUSION_LEARNING_RATE,
  FUSION_MAX_ITERATIONS,
  FUSION_CONVERGENCE_EPSILON,
  FUSION_L2_LAMBDA,
  FUSION_MIN_COMMITS,
  FUSION_MAX_HOPS,
} from "../config/fusion-constants";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FusionWeights {
  lambdaL: number;
  lambdaG: number;
  lambdaT: number;
  lambdaB: number;
}

interface TrainingExample {
  features: [number, number, number, number]; // [L, G, T, B]
  label: number; // 0 or 1
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Train repository-specific fusion weights from commit history.
 *
 * Returns null if insufficient data (< FUSION_MIN_COMMITS commits or
 * < 10 positive examples). Caller should fall back to hardcoded weights.
 *
 * Time budget: <50ms for 500 commits on a 1000-file graph.
 */
export function trainFusionWeights(
  commits: ParsedCommit[],
  fileGraph: InMemoryFileGraph,
  changeCoupling: Map<string, Map<string, number>>,
): FusionWeights | null {
  if (commits.length < FUSION_MIN_COMMITS) return null;

  // Use the most recent N commits
  const sample = commits.slice(0, FUSION_TRAINING_COMMITS);

  // Pre-compute max betweenness for normalization
  let maxBetweenness = 0;
  for (const node of fileGraph.nodes.values()) {
    if (node.betweenness > maxBetweenness) maxBetweenness = node.betweenness;
  }

  const examples: TrainingExample[] = [];

  for (const commit of sample) {
    const files = commit.files.filter((f) => fileGraph.nodes.has(f));
    if (files.length < 2) continue;

    const changedSet = new Set(files);

    // BFS distance map from all changed files (multi-source)
    const distFromChanged = bfsDistanceMultiSource(files, fileGraph, FUSION_MAX_HOPS);

    // For each changed file, treat others as seeds, compute features
    for (const candidate of files) {
      const seeds = files.filter((f) => f !== candidate);
      if (seeds.length === 0) continue;

      const features = computeFeatures(candidate, seeds, fileGraph, changeCoupling, maxBetweenness, distFromChanged);
      examples.push({ features, label: 1 });
    }

    // Hard negatives: graph-adjacent files not in the commit
    const negatives = mineHardNegatives(files, changedSet, fileGraph, distFromChanged);
    const negSample = negatives.slice(0, files.length * FUSION_NEGATIVE_RATIO);

    for (const neg of negSample) {
      const features = computeFeatures(neg, files, fileGraph, changeCoupling, maxBetweenness, distFromChanged);
      examples.push({ features, label: 0 });
    }
  }

  if (examples.length < 10 || examples.filter((e) => e.label === 1).length < 5) return null;

  // Normalize features to [0, 1] per column
  const normalized = normalizeFeatures(examples);

  return fitLogisticRegression(normalized);
}

// ── Feature computation ──────────────────────────────────────────────────────

function computeFeatures(
  candidate: string,
  seeds: string[],
  fileGraph: InMemoryFileGraph,
  changeCoupling: Map<string, Map<string, number>>,
  maxBetweenness: number,
  distMap: Map<string, number>,
): [number, number, number, number] {
  // L: max path token Jaccard between candidate and any seed
  let L = 0;
  for (const seed of seeds) {
    const j = pathTokenJaccard(seed, candidate);
    if (j > L) L = j;
  }

  // G: graph proximity (1 / (distance + 1)), using pre-computed BFS from seeds
  const dist = distMap.get(candidate);
  const G = dist !== undefined ? 1 / (dist + 1) : 0;

  // T: max change coupling confidence between candidate and any seed
  let T = 0;
  const candidateCoupling = changeCoupling.get(candidate);
  for (const seed of seeds) {
    // Check both directions
    const fwd = candidateCoupling?.get(seed) ?? 0;
    const rev = changeCoupling.get(seed)?.get(candidate) ?? 0;
    const maxConf = Math.max(fwd, rev);
    if (maxConf > T) T = maxConf;
  }

  // B: normalized betweenness of candidate
  const node = fileGraph.nodes.get(candidate);
  const B = node && maxBetweenness > 0 ? node.betweenness / maxBetweenness : 0;

  return [L, G, T, B];
}

// ── Hard negative mining ─────────────────────────────────────────────────────

/**
 * Mine hard negatives: files structurally close to changed files but not in the commit.
 *
 * Tier 1 (hardest): Direct imports of changed files
 * Tier 2: Same community members
 * Tier 3: 2-hop reachable files
 *
 * Returns candidates sorted by tier (hardest first).
 */
function mineHardNegatives(
  changedFiles: string[],
  changedSet: Set<string>,
  fileGraph: InMemoryFileGraph,
  distMap: Map<string, number>,
): string[] {
  const tier1 = new Set<string>();
  const tier2 = new Set<string>();
  const tier3 = new Set<string>();

  // Collect communities of changed files
  const changedCommunities = new Set<number | null>();
  for (const f of changedFiles) {
    const node = fileGraph.nodes.get(f);
    if (node) changedCommunities.add(node.communityId ?? null);
  }

  // Tier 1: Direct imports (forward + reverse neighbors)
  for (const f of changedFiles) {
    for (const edge of fileGraph.forward.get(f) ?? []) {
      if (!changedSet.has(edge.toPath)) tier1.add(edge.toPath);
    }
    for (const edge of fileGraph.reverse.get(f) ?? []) {
      if (!changedSet.has(edge.fromPath)) tier1.add(edge.fromPath);
    }
  }

  // Tier 2: Same community members (not already in tier 1)
  for (const [path, node] of fileGraph.nodes) {
    if (changedSet.has(path) || tier1.has(path)) continue;
    if (changedCommunities.has(node.communityId ?? null)) tier2.add(path);
  }

  // Tier 3: 2-hop reachable (from BFS distance map)
  for (const [path, dist] of distMap) {
    if (dist > 0 && dist <= 2 && !changedSet.has(path) && !tier1.has(path) && !tier2.has(path)) {
      tier3.add(path);
    }
  }

  return [...tier1, ...tier2, ...tier3];
}

// ── Logistic regression solver ───────────────────────────────────────────────

/**
 * Fit a logistic regression model with L2 regularization via batch gradient descent.
 *
 * Learns 5 parameters (4 features + bias). The bias is discarded; feature
 * weights are clamped to >= 0 and normalized to sum to 1.0.
 */
function fitLogisticRegression(examples: TrainingExample[]): FusionWeights {
  const N = examples.length;
  const w = new Float64Array(5); // [bias, w_L, w_G, w_T, w_B]

  for (let iter = 0; iter < FUSION_MAX_ITERATIONS; iter++) {
    const grad = new Float64Array(5);

    for (let i = 0; i < N; i++) {
      const x = examples[i].features;
      const y = examples[i].label;

      // z = bias + w^T x
      let z = w[0];
      for (let j = 0; j < 4; j++) z += w[j + 1] * x[j];

      // Numerically stable sigmoid
      const p = z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z));
      const err = p - y;

      grad[0] += err;
      for (let j = 0; j < 4; j++) grad[j + 1] += err * x[j];
    }

    // Average gradients + L2 regularization (skip bias for L2)
    let maxGrad = 0;
    grad[0] /= N;
    if (Math.abs(grad[0]) > maxGrad) maxGrad = Math.abs(grad[0]);
    for (let j = 1; j < 5; j++) {
      grad[j] = grad[j] / N + FUSION_L2_LAMBDA * w[j];
      if (Math.abs(grad[j]) > maxGrad) maxGrad = Math.abs(grad[j]);
    }

    // Update
    for (let j = 0; j < 5; j++) w[j] -= FUSION_LEARNING_RATE * grad[j];

    if (maxGrad < FUSION_CONVERGENCE_EPSILON) break;
  }

  // Extract feature weights, clamp >= 0, normalize to sum = 1
  const raw = [Math.max(0, w[1]), Math.max(0, w[2]), Math.max(0, w[3]), Math.max(0, w[4])];
  const sum = raw[0] + raw[1] + raw[2] + raw[3];

  if (sum === 0) {
    return { lambdaL: 0.25, lambdaG: 0.25, lambdaT: 0.25, lambdaB: 0.25 };
  }

  return {
    lambdaL: raw[0] / sum,
    lambdaG: raw[1] / sum,
    lambdaT: raw[2] / sum,
    lambdaB: raw[3] / sum,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Multi-source BFS on the undirected import graph, depth-limited. */
function bfsDistanceMultiSource(startFiles: string[], graph: InMemoryFileGraph, maxHops: number): Map<string, number> {
  const dist = new Map<string, number>();
  const queue: Array<[string, number]> = [];

  for (const f of startFiles) {
    dist.set(f, 0);
    queue.push([f, 0]);
  }

  let head = 0;
  while (head < queue.length) {
    const [current, d] = queue[head++];
    if (d >= maxHops) continue;

    const fwd = graph.forward.get(current);
    if (fwd) {
      for (const edge of fwd) {
        if (!dist.has(edge.toPath)) {
          dist.set(edge.toPath, d + 1);
          queue.push([edge.toPath, d + 1]);
        }
      }
    }

    const rev = graph.reverse.get(current);
    if (rev) {
      for (const edge of rev) {
        if (!dist.has(edge.fromPath)) {
          dist.set(edge.fromPath, d + 1);
          queue.push([edge.fromPath, d + 1]);
        }
      }
    }
  }

  return dist;
}

/** Jaccard similarity of file path tokens. */
function pathTokenJaccard(a: string, b: string): number {
  const tokensA = tokenizePath(a);
  const tokensB = tokenizePath(b);

  let intersection = 0;
  for (const t of tokensA) if (tokensB.has(t)) intersection++;
  const union = tokensA.size + tokensB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function tokenizePath(path: string): Set<string> {
  return new Set(
    path
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .split(/[/.\-_]+/)
      .join(" ")
      .toLowerCase()
      .split(/\s+/)
      .filter((t) => t.length > 1),
  );
}

/** Per-column max-normalization to [0, 1]. */
function normalizeFeatures(examples: TrainingExample[]): TrainingExample[] {
  const maxVals = [0, 0, 0, 0];

  for (const ex of examples) {
    for (let j = 0; j < 4; j++) {
      if (ex.features[j] > maxVals[j]) maxVals[j] = ex.features[j];
    }
  }

  return examples.map((ex) => ({
    label: ex.label,
    features: [
      maxVals[0] > 0 ? ex.features[0] / maxVals[0] : 0,
      maxVals[1] > 0 ? ex.features[1] / maxVals[1] : 0,
      maxVals[2] > 0 ? ex.features[2] / maxVals[2] : 0,
      maxVals[3] > 0 ? ex.features[3] / maxVals[3] : 0,
    ],
  }));
}
