/**
 * Vector storage and retrieval for symbol embeddings.
 * Uses a regular SQLite table with BLOB-encoded Float32Arrays.
 * Cosine similarity via flat-scan TypedArray math (< 1ms for 10K vectors at 384 dims).
 */

import type { DatabaseAdapter, StatementAdapter } from "../storage/db-adapter";

const DIMENSIONS = 384;

export interface EmbeddingEntry {
  symbolId: number;
  embedding: Float32Array;
  bodyHash: string | null;
}

interface EmbeddingRow {
  symbol_id: number;
  embedding: Uint8Array;
  file_path: string;
}

interface CountRow {
  count: number;
}

export class VectorStore {
  private readonly db: DatabaseAdapter;
  private readonly stmts: {
    upsert: StatementAdapter;
    loadAll: StatementAdapter;
    count: StatementAdapter;
  } | null;
  private cache: Array<{ filePath: string; embedding: Float32Array }> | null = null;

  constructor(db: DatabaseAdapter) {
    this.db = db;
    try {
      this.stmts = {
        upsert: db.prepare(
          "INSERT OR REPLACE INTO symbol_embeddings (symbol_id, embedding, body_hash) VALUES (?, ?, ?)",
        ),
        loadAll: db.prepare(
          "SELECT se.symbol_id, se.embedding, s.file_path " +
            "FROM symbol_embeddings se JOIN symbols s ON s.id = se.symbol_id",
        ),
        count: db.prepare("SELECT COUNT(*) as count FROM symbol_embeddings"),
      };
    } catch {
      this.stmts = null;
    }
  }

  get available(): boolean {
    return this.stmts !== null;
  }

  /** Batch insert/update embeddings. Invalidates the in-memory cache. */
  upsertEmbeddings(entries: EmbeddingEntry[]): void {
    if (!this.stmts || entries.length === 0) return;
    this.cache = null;
    const { upsert } = this.stmts;
    const run = this.db.transaction(() => {
      for (const e of entries) {
        if (!isFiniteEmbedding(e.embedding)) {
          process.stderr.write(`[clarte] Skipping embedding for symbol ${e.symbolId}: contains NaN or Infinity\n`);
          continue;
        }
        upsert.run(e.symbolId, float32ToBlob(e.embedding), e.bodyHash ?? null);
      }
    });
    run();
  }

  /** Count stored embeddings. */
  count(): number {
    if (!this.stmts) return 0;
    const row = this.stmts.count.get<CountRow>();
    return row?.count ?? 0;
  }

  /**
   * Find nearest files to a query embedding.
   * When candidatePaths is provided, only computes cosine similarity for symbols
   * in those files (ANN pre-filter). Reduces O(N) full-scan to
   * O(|candidates|) where |candidates| is typically the BM25F top-1000.
   * Without candidatePaths, falls back to full-scan for backward compatibility.
   */
  findNearest(
    query: Float32Array,
    limit: number,
    candidatePaths?: Set<string>,
  ): Array<{ path: string; score: number }> {
    if (!this.stmts) return [];

    if (!this.cache) {
      const rows = this.stmts.loadAll.all<EmbeddingRow>();
      this.cache = rows.map((r) => ({
        filePath: r.file_path,
        embedding: blobToFloat32(r.embedding),
      }));
    }

    // ANN pre-filter: restrict scan to BM25F candidate paths when provided
    const searchSet = candidatePaths ? this.cache.filter((e) => candidatePaths.has(e.filePath)) : this.cache;

    const fileScores = new Map<string, number>();
    for (const entry of searchSet) {
      const sim = dotProduct(query, entry.embedding);
      const current = fileScores.get(entry.filePath) ?? -1;
      if (sim > current) fileScores.set(entry.filePath, sim);
    }

    return [...fileScores.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([path, score]) => ({ path, score }));
  }
}

// ── TypedArray conversion helpers ─────────────────────────────────────────────

/** Encode a Float32Array as a Buffer for BLOB storage. */
function float32ToBlob(f32: Float32Array): Buffer {
  return Buffer.from(new Uint8Array(f32.buffer, f32.byteOffset, f32.byteLength));
}

/**
 * Decode a BLOB (Buffer/Uint8Array) to Float32Array.
 * Copies bytes to guarantee 4-byte alignment regardless of source buffer layout.
 */
function blobToFloat32(blob: Uint8Array): Float32Array {
  const f32 = new Float32Array(DIMENSIONS);
  new Uint8Array(f32.buffer).set(blob);
  return f32;
}

/**
 * Dot product of two normalized vectors (= cosine similarity).
 * V8 auto-vectorizes this loop for Float32Array.
 */
function dotProduct(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
}

/** Check that every element in a Float32Array is finite (no NaN or Infinity). */
function isFiniteEmbedding(f32: Float32Array): boolean {
  for (let i = 0; i < f32.length; i++) {
    if (!Number.isFinite(f32[i])) return false;
  }
  return true;
}
