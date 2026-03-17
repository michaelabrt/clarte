/**
 * Batch embedding pipeline. Computes embeddings for new/changed symbols.
 * Hash-gated: skips symbols whose body_hash hasn't changed since last embedding.
 * Processes in batches of 100 via paginated cursor to bound memory usage.
 */

import type { DatabaseAdapter } from "../storage/db-adapter";
import type { EmbeddingModel } from "./embedding-model";
import { buildSymbolInput } from "./embedding-input";
import { VectorStore } from "./vector-store";

const BATCH_SIZE = 100;

interface StaleSymbolRow {
  id: number;
  file_path: string;
  name: string;
  kind: string;
  body_hash: string | null;
  body_tokens: string | null;
}

const STALE_QUERY = `
  SELECT s.id, s.file_path, s.name, s.kind, s.body_hash, s.body_tokens
  FROM symbols s
  LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id
  WHERE se.symbol_id IS NULL
     OR COALESCE(se.body_hash, '') != COALESCE(s.body_hash, '')
  LIMIT ? OFFSET ?`;

/**
 * Compute and store embeddings for all new/changed symbols.
 * Uses paginated LIMIT/OFFSET to keep memory constant regardless of repo size.
 * Returns the number of symbols embedded.
 */
export async function runEmbeddingPipeline(db: DatabaseAdapter, model: EmbeddingModel): Promise<number> {
  const store = new VectorStore(db);
  if (!store.available) return 0;

  const stmt = db.prepare(STALE_QUERY);
  let embedded = 0;
  const offset = 0;

  for (;;) {
    const batch = stmt.all<StaleSymbolRow>(BATCH_SIZE, offset);
    if (batch.length === 0) break;

    const texts = batch.map((s) => buildSymbolInput(s.kind, s.file_path, s.name, s.body_tokens));
    const embeddings = await model.embed(texts);

    const entries = batch.map((s, j) => ({
      symbolId: s.id,
      embedding: embeddings[j],
      bodyHash: s.body_hash,
    }));
    store.upsertEmbeddings(entries);
    embedded += batch.length;

    // After upserting, previously-stale rows no longer match the WHERE clause.
    // Keep offset at 0 so the next page picks up the next batch of stale rows.
    // Only advance offset if the batch was NOT processed (shouldn't happen, but safety).
    if (batch.length < BATCH_SIZE) break;
  }

  return embedded;
}
