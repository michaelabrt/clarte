/**
 * HybridSearchProvider: orchestrates BM25F + semantic search with RRF fusion.
 * Falls back to BM25F-only when the embedding model is unavailable.
 *
 * Usage:
 *   const provider = new HybridSearchProvider(db);
 *   const results = await provider.search(query, bm25fRankedFiles);
 */

import type { DatabaseAdapter } from "../storage/db-adapter";
import type { EmbeddingModel } from "./embedding-model";
import { loadEmbeddingModel } from "./embedding-model";
import { VectorStore } from "./vector-store";
import { rrfFusion, type RankedResult } from "./rrf-fusion";

export class HybridSearchProvider {
  private model: EmbeddingModel | null = null;
  private modelPromise: Promise<EmbeddingModel | null> | null = null;
  private readonly vectorStore: VectorStore;

  constructor(db: DatabaseAdapter) {
    this.vectorStore = new VectorStore(db);
  }

  /**
   * [Dean & Stonebraker] Search combining BM25F results with semantic retrieval.
   * When candidatePaths is provided, semantic search is bounded to those files
   * (ANN pre-filter), reducing flat-scan cost from O(N) to O(|candidates|).
   *
   * @param query           Natural language query
   * @param bm25fFiles      Pre-computed BM25F ranked file paths (spreading activation already applied)
   * @param limit           Max results from the semantic branch
   * @param candidatePaths  Optional BM25F candidate pool for ANN pre-filtering (RFC §3.3)
   */
  async search(
    query: string,
    bm25fFiles: string[],
    limit = 50,
    candidatePaths?: Set<string>,
  ): Promise<RankedResult[]> {
    const semanticFiles = await this.semanticSearch(query, limit, candidatePaths);

    if (semanticFiles.length === 0) {
      return bm25fFiles.map((path, i) => ({ path, score: 1 / (60 + i + 1) }));
    }

    return rrfFusion(bm25fFiles, semanticFiles);
  }

  private async semanticSearch(
    query: string,
    limit: number,
    candidatePaths?: Set<string>,
  ): Promise<string[]> {
    if (!this.modelPromise) {
      this.modelPromise = loadEmbeddingModel();
    }
    this.model = await this.modelPromise;
    if (!this.model) return [];
    if (this.vectorStore.count() === 0) return [];

    const [queryEmbedding] = await this.model.embed([query]);
    const results = this.vectorStore.findNearest(queryEmbedding, limit, candidatePaths);
    return results.map((r) => r.path);
  }
}
