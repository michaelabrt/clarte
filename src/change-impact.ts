import type { GitAnalysis, ImportGraph } from "./types.js";
import { getOrSet } from "./utils.js";

/**
 * Predict which files are most likely to need changes when a given file is modified.
 * Uses Reciprocal Rank Fusion (RRF) across three independent rankings:
 *
 * 1. Structural proximity: BFS distance in import graph (both directions)
 * 2. Temporal coupling: co-change confidence from git history
 * 3. Directory proximity: shared path segments / max segments
 *
 * RRF formula: score(file) = sum(1 / (60 + rank_i(file))) for each ranking
 * where the file appears.
 */
export function predictChangeImpact(
  file: string,
  graph: ImportGraph,
  gitActivity: GitAnalysis | null,
): Array<{ file: string; score: number }> {
  // Collect all candidate files from rankings
  const rrfScores = new Map<string, number>();

  // Ranking 1: Structural proximity (BFS distance in both directions)
  const structuralRanking = computeStructuralRanking(file, graph);
  applyRRF(rrfScores, structuralRanking);

  // Ranking 2: Temporal coupling (co-change confidence)
  const temporalRanking = computeTemporalRanking(file, gitActivity);
  applyRRF(rrfScores, temporalRanking);

  // Ranking 3: Directory proximity (shared path segments)
  const allFiles = collectGraphFiles(graph);
  const directoryRanking = computeDirectoryRanking(file, allFiles);
  applyRRF(rrfScores, directoryRanking);

  // Remove the input file itself
  rrfScores.delete(file);

  // Sort by RRF score descending and return top 5 (alphabetical tiebreaker)
  return [...rrfScores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 5)
    .map(([f, score]) => ({ file: f, score }));
}

/**
 * Apply RRF scores from a ranking to the accumulator.
 * Each item gets 1 / (60 + rank) added to its score.
 */
function applyRRF(scores: Map<string, number>, ranking: string[]): void {
  for (let rank = 0; rank < ranking.length; rank++) {
    const f = ranking[rank];
    scores.set(f, (scores.get(f) ?? 0) + 1 / (60 + rank + 1)); // rank is 1-indexed
  }
}

/**
 * BFS-based structural proximity ranking.
 * Explores both import directions (files this file imports + files that import this file).
 * Returns files sorted by BFS distance ascending.
 */
function computeStructuralRanking(file: string, graph: ImportGraph): string[] {
  // Build bidirectional adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    getOrSet(adj, edge.from, () => new Set()).add(edge.to);
    getOrSet(adj, edge.to, () => new Set()).add(edge.from);
  }

  if (!adj.has(file)) return [];

  // BFS from the target file
  const distances = new Map<string, number>();
  const queue: string[] = [file];
  let qHead = 0;
  distances.set(file, 0);

  while (qHead < queue.length) {
    const current = queue[qHead++]!;
    const dist = distances.get(current)!;
    for (const neighbor of adj.get(current) ?? []) {
      if (!distances.has(neighbor)) {
        distances.set(neighbor, dist + 1);
        queue.push(neighbor);
      }
    }
  }

  // Remove self and sort by distance ascending (alphabetical tiebreaker)
  distances.delete(file);
  return [...distances.entries()]
    .sort((a, b) => a[1] - b[1] || a[0].localeCompare(b[0]))
    .map(([f]) => f);
}

/**
 * Temporal coupling ranking based on co-change confidence.
 * Returns files sorted by confidence descending.
 */
function computeTemporalRanking(file: string, gitActivity: GitAnalysis | null): string[] {
  if (!gitActivity?.changeCoupling) return [];

  const pairs: Array<{ other: string; confidence: number }> = [];
  for (const pair of gitActivity.changeCoupling) {
    if (pair.fileA === file) {
      pairs.push({ other: pair.fileB, confidence: pair.confidence });
    } else if (pair.fileB === file) {
      pairs.push({ other: pair.fileA, confidence: pair.confidence });
    }
  }

  return pairs
    .sort((a, b) => b.confidence - a.confidence || a.other.localeCompare(b.other))
    .map((p) => p.other);
}

/**
 * Collect all unique internal file paths from the import graph.
 */
function collectGraphFiles(graph: ImportGraph): string[] {
  const files = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    files.add(edge.from);
    files.add(edge.to);
  }
  return [...files];
}

/**
 * Directory proximity ranking: shared path segments / max segments.
 * Returns files sorted by similarity descending.
 */
function computeDirectoryRanking(file: string, allFiles: string[]): string[] {
  const fileParts = file.split("/");

  const scored: Array<{ file: string; similarity: number }> = [];
  for (const other of allFiles) {
    if (other === file) continue;
    const otherParts = other.split("/");
    let shared = 0;
    const maxLen = Math.min(fileParts.length, otherParts.length);
    for (let i = 0; i < maxLen; i++) {
      if (fileParts[i] === otherParts[i]) {
        shared++;
      } else {
        break;
      }
    }
    const maxSegments = Math.max(fileParts.length, otherParts.length);
    const similarity = maxSegments > 0 ? shared / maxSegments : 0;
    if (similarity > 0) {
      scored.push({ file: other, similarity });
    }
  }

  return scored
    .sort((a, b) => b.similarity - a.similarity || a.file.localeCompare(b.file))
    .map((s) => s.file);
}
