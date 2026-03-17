/**
 * Bayesian EWMA edge priors.
 *
 * Each file-level edge carries a Beta(alpha, beta) distribution modeling
 * the probability that traversing this edge leads to a co-changed file.
 *
 * Priors are initialized from structural graph properties during full
 * indexing. On each new commit, affected edges are updated with O(1) EWMA
 * decay. Two floats per edge in SQLite; no history replay needed for
 * incremental updates.
 *
 * Expected weight = alpha / (alpha + beta), used as a multiplicative
 * factor on transition weights in Katz propagation and Markov flow.
 */

import type { InMemoryFileGraph, InMemoryEdge } from "../../storage/types";
import type { ParsedCommit } from "../git/analysis";
import { EWMA_DECAY, EWMA_PRIOR_STRENGTH, EWMA_WEIGHT_FLOOR } from "../config/phase8-constants";

// ── Types ────────────────────────────────────────────────────────────────────

export interface EdgePrior {
  fromPath: string;
  toPath: string;
  alpha: number;
  beta: number;
}

// ── Initialization ──────────────────────────────────────────────────────────

/**
 * Initialize Beta priors for all file-level edges from structural properties.
 *
 * The structural weight reflects edge type:
 *   Direct value import:  0.7 (high prior confidence)
 *   Barrel-routed:        0.5 (moderate - barrel indirection dilutes signal)
 *   Dynamic import:       0.4 (lower - runtime resolution adds uncertainty)
 *   Type-only import:     0.3 (lowest - type coupling rarely implies co-change)
 *
 * alpha = PRIOR_STRENGTH * structural_weight
 * beta  = PRIOR_STRENGTH * (1 - structural_weight)
 */
export function initializeEdgePriors(fileGraph: InMemoryFileGraph): EdgePrior[] {
  const priors: EdgePrior[] = [];

  for (const [, edges] of fileGraph.forward) {
    for (const edge of edges) {
      const w = structuralWeight(edge);
      priors.push({
        fromPath: edge.fromPath,
        toPath: edge.toPath,
        alpha: EWMA_PRIOR_STRENGTH * w,
        beta: EWMA_PRIOR_STRENGTH * (1 - w),
      });
    }
  }

  return priors;
}

/**
 * Process a batch of commits through EWMA, updating edge priors in place.
 *
 * Commits must be ordered oldest-first. For each commit, edges adjacent
 * to changed files are decayed by EWMA_DECAY^(commits since last touch),
 * then a +1 observation is added (alpha for co-change, beta for non-co-change).
 *
 * Returns the updated priors. Only edges that were touched are modified;
 * untouched edges receive a final bulk decay at the end.
 *
 * Complexity: O(sum(changed_edges_per_commit) + total_edges)
 */
export function updateEdgePriorsFromCommits(
  priors: Map<string, EdgePrior>,
  commits: ParsedCommit[],
  fileGraph: InMemoryFileGraph,
): EdgePrior[] {
  // Track last commit index each edge was updated at
  const lastUpdate = new Map<string, number>();

  for (let ci = 0; ci < commits.length; ci++) {
    const changedSet = new Set(commits[ci].files.filter((f) => fileGraph.nodes.has(f)));
    if (changedSet.size < 1) continue;

    // For each changed file, check its outgoing edges
    for (const changedFile of changedSet) {
      const edges = fileGraph.forward.get(changedFile);
      if (!edges) continue;

      for (const edge of edges) {
        const key = edgeKey(edge.fromPath, edge.toPath);
        const prior = priors.get(key);
        if (!prior) continue;

        // Decay since last update
        const lastIdx = lastUpdate.get(key) ?? -1;
        const gap = ci - lastIdx - 1;
        if (gap > 0) {
          const decay = EWMA_DECAY ** gap;
          prior.alpha *= decay;
          prior.beta *= decay;
        }
        lastUpdate.set(key, ci);

        // Observation: did the target file also change?
        if (changedSet.has(edge.toPath)) {
          prior.alpha += 1;
        } else {
          prior.beta += 1;
        }
      }
    }
  }

  // Final decay for untouched edges
  const totalCommits = commits.length;
  const result: EdgePrior[] = [];

  for (const [key, prior] of priors) {
    const lastIdx = lastUpdate.get(key) ?? -1;
    const remaining = totalCommits - lastIdx - 1;
    if (remaining > 0) {
      const decay = EWMA_DECAY ** remaining;
      prior.alpha *= decay;
      prior.beta *= decay;
    }
    result.push(prior);
  }

  return result;
}

/**
 * Compute expected edge weights from Beta priors.
 *
 * Returns a map of "fromPath||toPath" -> alpha/(alpha+beta), floored
 * at EWMA_WEIGHT_FLOOR to prevent edges from being fully zeroed.
 */
export function computeExpectedWeights(priors: EdgePrior[]): Map<string, number> {
  const weights = new Map<string, number>();

  for (const p of priors) {
    const total = p.alpha + p.beta;
    const w = total > 0 ? p.alpha / total : 0.5;
    weights.set(edgeKey(p.fromPath, p.toPath), Math.max(EWMA_WEIGHT_FLOOR, w));
  }

  return weights;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function structuralWeight(edge: InMemoryEdge): number {
  if (edge.isTypeOnly) return 0.3;
  if (edge.isDynamic) return 0.4;
  if (edge.isBarrelRouted) return 0.5;
  return 0.7;
}

function edgeKey(from: string, to: string): string {
  return `${from}||${to}`;
}
