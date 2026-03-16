/**
 * HybridSearchProvider: orchestrates BM25F + semantic search with RRF fusion.
 * Falls back to BM25F-only when the embedding model is unavailable.
 *
 * Usage:
 *   const provider = new HybridSearchProvider(db);
 *   const results = await provider.search(query, bm25fRankedFiles);
 */

import type { DatabaseAdapter } from "../storage/db-adapter.js";
import type { EmbeddingModel } from "./embedding-model.js";
import { loadEmbeddingModel } from "./embedding-model.js";
import { VectorStore } from "./vector-store.js";
import { rrfFusion, type RankedResult } from "./rrf-fusion.js";

export class HybridSearchProvider {
  private model: EmbeddingModel | null = null;
  private modelChecked = false;
  private readonly vectorStore: VectorStore;

  constructor(db: DatabaseAdapter) {
    this.vectorStore = new VectorStore(db);
  }

  /**
   * Search combining BM25F results with semantic retrieval.
   *
   * @param query       Natural language query
   * @param bm25fFiles  Pre-computed BM25F ranked file paths (spreading activation already applied)
   * @param limit       Max results from the semantic branch
   */
  async search(query: string, bm25fFiles: string[], limit = 50): Promise<RankedResult[]> {
    const semanticFiles = await this.semanticSearch(query, limit);

    if (semanticFiles.length === 0) {
      // Graceful fallback: BM25F-only with rank-based scores
      return bm25fFiles.map((path, i) => ({ path, score: 1 / (60 + i + 1) }));
    }

    return rrfFusion(bm25fFiles, semanticFiles);
  }

  private async semanticSearch(query: string, limit: number): Promise<string[]> {
    if (!this.modelChecked) {
      this.modelChecked = true;
      this.model = await loadEmbeddingModel();
    }
    if (!this.model) return [];
    if (this.vectorStore.count() === 0) return [];

    const [queryEmbedding] = await this.model.embed([query]);
    const results = this.vectorStore.findNearest(queryEmbedding, limit);
    return results.map((r) => r.path);
  }
}
