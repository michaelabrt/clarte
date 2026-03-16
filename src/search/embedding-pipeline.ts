/**
 * Batch embedding pipeline. Computes embeddings for new/changed symbols.
 * Hash-gated: skips symbols whose body_hash hasn't changed since last embedding.
 * Processes in batches of 100 to avoid CPU/memory spikes.
 */

import type { DatabaseAdapter } from "../storage/db-adapter.js";
import type { EmbeddingModel } from "./embedding-model.js";
import { buildSymbolInput } from "./embedding-input.js";
import { VectorStore } from "./vector-store.js";

const BATCH_SIZE = 100;

interface StaleSymbolRow {
  id: number;
  file_path: string;
  name: string;
  kind: string;
  body_hash: string | null;
  body_tokens: string | null;
}

/**
 * Compute and store embeddings for all new/changed symbols.
 * Returns the number of symbols embedded.
 */
export async function runEmbeddingPipeline(db: DatabaseAdapter, model: EmbeddingModel): Promise<number> {
  const store = new VectorStore(db);
  if (!store.available) return 0;

  const stale = db
    .prepare(
      `SELECT s.id, s.file_path, s.name, s.kind, s.body_hash, s.body_tokens
     FROM symbols s
     LEFT JOIN symbol_embeddings se ON se.symbol_id = s.id
     WHERE se.symbol_id IS NULL
        OR COALESCE(se.body_hash, '') != COALESCE(s.body_hash, '')`,
    )
    .all<StaleSymbolRow>();

  if (stale.length === 0) return 0;

  let embedded = 0;
  for (let i = 0; i < stale.length; i += BATCH_SIZE) {
    const batch = stale.slice(i, i + BATCH_SIZE);
    const texts = batch.map((s) => buildSymbolInput(s.kind, s.file_path, s.name, s.body_tokens));
    const embeddings = await model.embed(texts);

    const entries = batch.map((s, j) => ({
      symbolId: s.id,
      embedding: embeddings[j],
      bodyHash: s.body_hash,
    }));
    store.upsertEmbeddings(entries);
    embedded += batch.length;
  }

  return embedded;
}
