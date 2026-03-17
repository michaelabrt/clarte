/**
 * Constraint-scored call resolution.
 *
 * Two-tiered architecture:
 * - Fast path (Tiers 1-3): import graph as structural proof (symbol-resolution.ts)
 * - Slow path (Tier 5): Laplace-smoothed Jaccard over symbol neighborhoods
 *   with locality multipliers and cold-start fallback to file-level neighborhoods.
 *
 * Locality scalar (replaces flat export bonus):
 *   Same file: x10.0, Same community: x2.0, Cross+exported: x1.0.
 *   Strict file-boundary visibility: unexported symbols are invisible
 *   outside their own file, regardless of community.
 *
 * Cold start: when |N_sym(caller)| < COLD_START_THRESHOLD, falls back to
 * file-level import neighborhood Jaccard for enough structural surface area.
 */

import type { InMemorySymbolGraph } from "../../storage/types";
import type { SymbolIndex, SymbolEntry } from "./symbol-resolution";
import type { ResolvedSymbolEdge } from "./symbol-types";
import { RESOLUTION_CONFIDENCE } from "./symbol-types";
import {
  PROXIMITY_AUTHORITY_BETA,
  PROXIMITY_AUTHORITY_FLOOR,
  PROXIMITY_MIN_JACCARD,
  PROXIMITY_COLD_START_THRESHOLD,
  PROXIMITY_LAPLACE_ALPHA,
  LOCALITY_SAME_FILE,
  LOCALITY_SAME_COMMUNITY,
  LOCALITY_CROSS_EXPORTED,
} from "../config/proximity-constants";

// ── Pre-computation ───────────────────────────────────────────────────────────

/**
 * Pre-compute 1-hop symbol neighborhoods for all symbols.
 * Each neighborhood is the set of symbol IDs directly connected (forward + reverse).
 * O(|E|) total.
 */
export function buildSymbolNeighborhoods(symbolGraph: InMemorySymbolGraph): Map<number, Set<number>> {
  const neighborhoods = new Map<number, Set<number>>();

  for (const [symbolId] of symbolGraph.symbols) {
    const neighbors = new Set<number>();

    for (const edge of symbolGraph.forward.get(symbolId) ?? []) {
      neighbors.add(edge.toSymbolId);
    }
    for (const edge of symbolGraph.reverse.get(symbolId) ?? []) {
      neighbors.add(edge.fromSymbolId);
    }

    neighborhoods.set(symbolId, neighbors);
  }

  return neighborhoods;
}

/**
 * Pre-compute 1-hop file-level import neighborhoods.
 * Used as fallback when symbol neighborhoods are too small (cold start).
 * O(|file_edges|).
 */
export function buildFileNeighborhoods(
  fileEdges: ReadonlyArray<{ fromPath: string; toPath: string }>,
): Map<string, Set<string>> {
  const neighborhoods = new Map<string, Set<string>>();

  for (const edge of fileEdges) {
    let fromSet = neighborhoods.get(edge.fromPath);
    if (!fromSet) {
      fromSet = new Set();
      neighborhoods.set(edge.fromPath, fromSet);
    }
    fromSet.add(edge.toPath);

    let toSet = neighborhoods.get(edge.toPath);
    if (!toSet) {
      toSet = new Set();
      neighborhoods.set(edge.toPath, toSet);
    }
    toSet.add(edge.fromPath);
  }

  return neighborhoods;
}

/**
 * Build symbol neighborhoods from resolved edges (no DB reload needed).
 * Used by the two-pass pipeline: pass 1 produces edges, neighborhoods
 * are built from those edges for Tier 5 in pass 2.
 * O(|edges|) total.
 */
export function buildNeighborhoodsFromResolvedEdges(
  edges: ResolvedSymbolEdge[],
  symbolIndex: SymbolIndex,
): Map<number, Set<number>> {
  const neighborhoods = new Map<number, Set<number>>();

  for (const edge of edges) {
    const fromEntries = symbolIndex.byFileAndName.get(`${edge.fromFile}::${edge.fromSymbol}`);
    const toEntries = symbolIndex.byFileAndName.get(`${edge.toFile}::${edge.toSymbol}`);
    if (!fromEntries?.[0] || !toEntries?.[0]) continue;

    const fromId = fromEntries[0].id;
    const toId = toEntries[0].id;

    let fromSet = neighborhoods.get(fromId);
    if (!fromSet) {
      fromSet = new Set();
      neighborhoods.set(fromId, fromSet);
    }
    fromSet.add(toId);

    let toSet = neighborhoods.get(toId);
    if (!toSet) {
      toSet = new Set();
      neighborhoods.set(toId, toSet);
    }
    toSet.add(fromId);
  }

  return neighborhoods;
}

// ── Scoring ───────────────────────────────────────────────────────────────────

/**
 * Laplace-smoothed Jaccard similarity.
 * J_smooth(A, B) = (|A ∩ B| + alpha) / (|A ∪ B| + 2*alpha)
 *
 * Why Laplace smoothing: standard Jaccard returns 0 when neighborhoods share
 * no members, making all non-overlapping candidates equally invisible. The
 * additive alpha (pseudocount) provides a non-zero floor so that candidates
 * with larger neighborhoods (|A ∪ B|) are penalized - a meaningful signal
 * even without intersection. With alpha=1, an empty intersection still
 * differentiates a 10-neighbor pair (J=0.083) from a 100-neighbor pair (J=0.0099).
 */
export function smoothedJaccard<T>(a: ReadonlySet<T>, b: ReadonlySet<T>): number {
  const [smaller, larger] = a.size <= b.size ? [a, b] : [b, a];
  let intersection = 0;
  for (const item of smaller) {
    if (larger.has(item)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return (intersection + PROXIMITY_LAPLACE_ALPHA) / (union + 2 * PROXIMITY_LAPLACE_ALPHA);
}

/**
 * Locality multiplier based on spatial relationship between caller and candidate.
 *
 * Why: structural proximity is a strong disambiguation signal. Same-file
 * candidates are 10x more likely to be the intended target than cross-file
 * ones; same-community (Leiden cluster) symbols share a functional domain.
 *
 * Strict file-boundary visibility: unexported symbols return 0 outside
 * their own file, regardless of community membership. This prevents
 * the proximity scorer from "seeing through" module boundaries.
 */
function localityMultiplier(
  callerFile: string,
  candidateFile: string,
  callerCommunityId: number | null,
  candidateCommunityId: number | null,
  isExported: boolean,
): number {
  if (callerFile === candidateFile) return LOCALITY_SAME_FILE;
  // Strict: cross-file + unexported -> invisible
  if (!isExported) return 0;
  if (callerCommunityId !== null && callerCommunityId === candidateCommunityId) {
    return LOCALITY_SAME_COMMUNITY;
  }
  return LOCALITY_CROSS_EXPORTED;
}

// ── Main entry point ──────────────────────────────────────────────────────────

/**
 * Resolve an ambiguous call by structural proximity in the symbol graph.
 *
 * When the 4-tier import-proof resolution fails, scores all symbols with
 * the matching name by:
 *   1. Laplace-smoothed Jaccard between caller and candidate neighborhoods
 *   2. HITS authority of the candidate (alpha^beta)
 *   3. Locality multiplier (same file > same community > cross-community)
 *
 * Cold-start fallback: when the caller's symbol neighborhood has fewer than
 * COLD_START_THRESHOLD (3) members, uses file-level import neighborhood
 * Jaccard instead. In tie-breaking scenarios within the cold-start fallback,
 * the alpha(c_i)^beta HITS authority term serves as the natural deterministic
 * tiebreaker; HITS scores are never perfectly flat across symbols in a file
 * because barrel files get discounted and edge specificity varies.
 */
export function resolveByProximity(
  callerFile: string,
  callerSymbolId: number | null,
  calleeName: string,
  callerLine: number,
  callerFn: string | undefined,
  symbolNeighborhoods: Map<number, Set<number>>,
  fileNeighborhoods: Map<string, Set<string>>,
  symbolIndex: SymbolIndex,
  symbolGraph: InMemorySymbolGraph,
  fileCommunities: Map<string, number>,
): ResolvedSymbolEdge | null {
  const candidates = symbolIndex.byName.get(calleeName);
  if (!candidates || candidates.length === 0) return null;

  const callerNeighborhood =
    callerSymbolId !== null ? (symbolNeighborhoods.get(callerSymbolId) ?? new Set<number>()) : new Set<number>();
  const callerFileNeighborhood = fileNeighborhoods.get(callerFile) ?? new Set<string>();
  const callerCommunityId = fileCommunities.get(callerFile) ?? null;

  // Cold start: if symbol neighborhood is too small, use file-level Jaccard
  const useFallback = callerNeighborhood.size < PROXIMITY_COLD_START_THRESHOLD;

  let bestScore = 0;
  let bestCandidate: SymbolEntry | null = null;

  for (const candidate of candidates) {
    const candidateNode = symbolGraph.symbols.get(candidate.id);
    if (!candidateNode) continue;

    const candidateCommunityId = fileCommunities.get(candidate.filePath) ?? null;
    const locality = localityMultiplier(
      callerFile,
      candidate.filePath,
      callerCommunityId,
      candidateCommunityId,
      candidateNode.isExported,
    );
    if (locality === 0) continue;

    let jaccard: number;
    if (useFallback) {
      const candidateFileNeighborhood = fileNeighborhoods.get(candidate.filePath) ?? new Set<string>();
      jaccard = smoothedJaccard(callerFileNeighborhood, candidateFileNeighborhood);
    } else {
      const candidateNeighborhood = symbolNeighborhoods.get(candidate.id) ?? new Set<number>();
      jaccard = smoothedJaccard(callerNeighborhood, candidateNeighborhood);
    }

    if (jaccard < PROXIMITY_MIN_JACCARD) continue;

    const authority = Math.max(candidateNode.authority ?? 0, PROXIMITY_AUTHORITY_FLOOR);
    const score = jaccard * authority ** PROXIMITY_AUTHORITY_BETA * locality;

    if (score > bestScore) {
      bestScore = score;
      bestCandidate = candidate;
    }
  }

  if (!bestCandidate) return null;

  return {
    fromFile: callerFile,
    fromSymbol: callerFn ?? "",
    toFile: bestCandidate.filePath,
    toSymbol: bestCandidate.name,
    kind: "calls",
    line: callerLine,
    confidence: RESOLUTION_CONFIDENCE.TIER_5_PROXIMITY,
  };
}
