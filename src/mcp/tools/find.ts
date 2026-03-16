/**
 * clarte_find MCP tool (RFC §4.4).
 *
 * "Where is the code that does X?" - BM25F + Semantic + RRF fusion.
 * Reuses the hybrid search pipeline from Phase 3, with BM25F corpus stats
 * cached in the SQLite meta table for instant query-time use.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter.js";
import { HybridSearchProvider } from "../../search/hybrid-search.js";
import type { RankedResult } from "../../search/rrf-fusion.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FindInput {
  query: string;
}

interface FindResultEntry {
  file: string;
  symbols: string[];
  match_type: "lexical" | "semantic" | "semantic+lexical";
  confidence: number;
}

export interface FindOutput {
  query: string;
  results: FindResultEntry[];
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface FtsMatchRow {
  file_path: string;
  symbol_name: string;
  rank: number;
}

interface SymbolRow {
  name: string;
  start_line: number;
  authority: number | null;
}

// ── BM25F corpus stats cache (singleton per server lifetime) ─────────────────

interface Bm25fStats {
  docCount: number;
  avgFieldLengths: Record<string, number>;
  docFreqs: Record<string, number>;
}

let cachedStats: Bm25fStats | null = null;

function loadBm25fStats(db: DatabaseAdapter): Bm25fStats {
  if (cachedStats) return cachedStats;

  const getMeta = db.prepare("SELECT value FROM meta WHERE key = ?");

  const docCountStr = getMeta.get<{ value: string }>("bm25f_doc_count")?.value;
  const avgLenStr = getMeta.get<{ value: string }>("bm25f_avg_field_lengths")?.value;
  const docFreqStr = getMeta.get<{ value: string }>("bm25f_doc_freqs")?.value;

  cachedStats = {
    docCount: docCountStr ? Number(docCountStr) : 0,
    avgFieldLengths: avgLenStr ? JSON.parse(avgLenStr) : {},
    docFreqs: docFreqStr ? JSON.parse(docFreqStr) : {},
  };

  return cachedStats;
}

/** Reset cached stats (for testing). */
export function _resetFindCache(): void {
  cachedStats = null;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Search for files matching a natural language query.
 *
 * Pipeline:
 * 1. FTS5 candidate retrieval via BM25F (using cached corpus stats)
 * 2. Semantic nearest-neighbor retrieval (if embedding model available)
 * 3. RRF fusion of both ranked lists
 * 4. Top 5 files with per-file symbol annotations
 */
export async function executeFind(db: DatabaseAdapter, input: FindInput): Promise<FindOutput> {
  const { query } = input;
  const MAX_RESULTS = 5;

  // Load BM25F corpus stats (cached in-process after first call)
  loadBm25fStats(db);

  // Step 1: FTS5 candidate retrieval via BM25F ranking
  const bm25fFiles = fts5Search(db, query);

  // Step 2 + 3: Hybrid search (semantic + RRF fusion, or BM25F-only fallback)
  const hybrid = new HybridSearchProvider(db);
  const fusedResults = await hybrid.search(query, bm25fFiles, 50);

  // Determine which files came from which ranker
  const bm25fSet = new Set(bm25fFiles);
  // Semantic files are those in fused results NOT in bm25f set
  // (approximation - if a file appears in both, it's "semantic+lexical")

  // Step 4: Build output with per-file symbol annotations
  const topResults = fusedResults.slice(0, MAX_RESULTS);
  const maxScore = topResults[0]?.score ?? 1;

  const results = topResults.map((r) => annotateResult(db, r, bm25fSet, maxScore));

  return { query, results };
}

// ── FTS5 BM25F search ────────────────────────────────────────────────────────

/**
 * Run FTS5 full-text search and return file paths ranked by BM25F score.
 * Uses Porter stemming + unicode61 tokenizer (configured in schema).
 */
function fts5Search(db: DatabaseAdapter, query: string): string[] {
  // Sanitize query for FTS5 (escape special characters, split into tokens)
  const tokens = query
    .replace(/[^\w\s]/g, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);

  if (tokens.length === 0) return [];

  // FTS5 query: OR-join all tokens for broad recall
  const ftsQuery = tokens.join(" OR ");

  try {
    const stmt = db.prepare(`
      SELECT file_path, symbol_name, rank
      FROM fts_symbols
      WHERE fts_symbols MATCH ?
      ORDER BY rank
      LIMIT 100
    `);
    const rows = stmt.all<FtsMatchRow>(ftsQuery);

    // Aggregate to file level: best rank per file
    const fileRanks = new Map<string, number>();
    for (const row of rows) {
      const current = fileRanks.get(row.file_path);
      if (current === undefined || row.rank < current) {
        fileRanks.set(row.file_path, row.rank);
      }
    }

    // Sort by rank (lower = better in FTS5)
    return [...fileRanks.entries()].sort((a, b) => a[1] - b[1]).map(([path]) => path);
  } catch {
    // FTS5 not available or query error
    return [];
  }
}

// ── Result annotation ────────────────────────────────────────────────────────

/**
 * Annotate a ranked result with top symbols, match type and normalized confidence.
 */
function annotateResult(
  db: DatabaseAdapter,
  result: RankedResult,
  bm25fSet: Set<string>,
  maxScore: number,
): FindResultEntry {
  // Determine match type
  const inBm25f = bm25fSet.has(result.path);
  // If score is higher than what a single ranker could produce, both contributed
  const singleRankerMax = 1 / 61; // rank 0 in RRF with k=60
  const likelyBothRankers = result.score > singleRankerMax * 1.1;

  let match_type: "lexical" | "semantic" | "semantic+lexical";
  if (likelyBothRankers) {
    match_type = "semantic+lexical";
  } else if (inBm25f) {
    match_type = "lexical";
  } else {
    match_type = "semantic";
  }

  // Get top 3 symbols by authority for this file
  const symStmt = db.prepare(`
    SELECT name, start_line, authority
    FROM symbols
    WHERE file_path = ?
    ORDER BY authority DESC NULLS LAST
    LIMIT 3
  `);
  const symRows = symStmt.all<SymbolRow>(result.path);
  const symbols = symRows.map((r) => r.name);

  // Normalize confidence to [0, 1]
  const confidence = maxScore > 0 ? Math.round((result.score / maxScore) * 100) / 100 : 0;

  return {
    file: result.path,
    symbols,
    match_type,
    confidence,
  };
}
