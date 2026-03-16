/**
 * Reciprocal Rank Fusion (Cormack, Clarke & Buettcher 2009).
 * Combines ranked result lists from independent retrieval systems.
 *
 * Score for document d = SUM over rankers R of 1 / (k + rank_R(d))
 * where k = 60 (standard constant from the original paper).
 */

export interface RankedResult {
  path: string;
  score: number;
}

const DEFAULT_K = 60;

/**
 * Fuse BM25F and semantic ranked lists via RRF.
 * Both inputs are file paths ordered by relevance (rank 0 = best).
 *
 * BM25F spreading activation runs BEFORE this function is called.
 * Semantic results are NOT expanded (embedding proximity already captures
 * transitive relevance).
 */
export function rrfFusion(bm25fResults: string[], semanticResults: string[], k = DEFAULT_K): RankedResult[] {
  const scores = new Map<string, number>();

  for (let i = 0; i < bm25fResults.length; i++) {
    const path = bm25fResults[i];
    scores.set(path, (scores.get(path) ?? 0) + 1 / (k + i + 1));
  }

  for (let i = 0; i < semanticResults.length; i++) {
    const path = semanticResults[i];
    scores.set(path, (scores.get(path) ?? 0) + 1 / (k + i + 1));
  }

  return [...scores.entries()].sort((a, b) => b[1] - a[1]).map(([path, score]) => ({ path, score }));
}
