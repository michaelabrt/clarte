/**
 * clarte_find MCP tool (RFC §4.4).
 *
 * "Where is the code that does X?" - Full BM25F pipeline + Semantic + RRF fusion.
 *
 * F.2 fix: Uses resolveEditTargetsWithMeta (the real BM25F pipeline with spreading
 * activation, test proxy, synonym expansion) instead of raw FTS5 ranking.
 * F.3 fix: match_type derived from TargetMatch.matchType (ground truth from the
 * scoring pipeline) instead of unreliable score heuristics.
 * F.4 fix: HybridSearchProvider hoisted to module singleton to avoid reloading
 * the 15MB+ vector cache on every call.
 * F.8 fix: BM25F corpus stats are used indirectly through the full pipeline.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter.js";
import { HybridSearchProvider } from "../../search/hybrid-search.js";
import { rrfFusion } from "../../search/rrf-fusion.js";
import { resolveEditTargetsWithMeta, rankSymbols, type SymbolMatch } from "../../steer/targets-resolve.js";
import { buildPersistedGraphFromStore } from "../../storage/loader.js";
import { GraphStore } from "../../storage/graph-store.js";

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

// ── Module-level singletons (F.4: avoid per-call reconstruction) ─────────────

let cachedHybrid: HybridSearchProvider | null = null;
let cachedGraph: ReturnType<typeof buildPersistedGraphFromStore> | null = null;
let cachedStore: GraphStore | null = null;

function getHybridProvider(db: DatabaseAdapter): HybridSearchProvider {
  if (!cachedHybrid) {
    cachedHybrid = new HybridSearchProvider(db);
  }
  return cachedHybrid;
}

function getPersistedGraph(db: DatabaseAdapter): ReturnType<typeof buildPersistedGraphFromStore> {
  if (cachedGraph) return cachedGraph;
  if (!cachedStore) {
    cachedStore = new GraphStore(db);
  }
  cachedGraph = buildPersistedGraphFromStore(cachedStore);
  return cachedGraph;
}

/** Reset all caches (for testing). */
export function _resetFindCache(): void {
  cachedHybrid = null;
  cachedGraph = null;
  cachedStore = null;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Search for files matching a natural language query.
 *
 * Pipeline (F.2: full BM25F, not raw FTS5):
 * 1. Run full BM25F pipeline via resolveEditTargetsWithMeta (includes spreading
 *    activation, test proxy, synonym expansion, import ceiling)
 * 2. Run semantic retrieval via HybridSearchProvider (if embedding model available)
 * 3. RRF fusion of BM25F ranked list + semantic ranked list
 * 4. Top 5 files with per-file symbol annotations
 */
export async function executeFind(db: DatabaseAdapter, input: FindInput): Promise<FindOutput> {
  const { query } = input;
  const MAX_RESULTS = 5;

  const graph = getPersistedGraph(db);

  // Step 1: Full BM25F pipeline with spreading activation, test proxy, synonyms
  const bm25fTargets = resolveEditTargetsWithMeta(query, graph, 20);
  const bm25fFiles = bm25fTargets.map((t) => t.file);

  // Step 2: Semantic search
  const hybrid = getHybridProvider(db);
  const semanticFiles = await getSemanticFiles(hybrid, query);

  // Step 3: RRF fusion (or BM25F-only if no semantic results)
  let fusedResults: Array<{ path: string; score: number }>;
  const hasSemanticResults = semanticFiles.length > 0;

  if (hasSemanticResults) {
    fusedResults = rrfFusion(bm25fFiles, semanticFiles);
  } else {
    // BM25F-only: convert to RRF-style scores for consistent confidence normalization
    fusedResults = bm25fFiles.map((path, i) => ({ path, score: 1 / (60 + i + 1) }));
  }

  // Step 4: Build output with annotations
  const topResults = fusedResults.slice(0, MAX_RESULTS);
  const maxScore = topResults[0]?.score ?? 1;
  const bm25fSet = new Set(bm25fFiles);
  const semanticSet = new Set(semanticFiles);

  // Rank symbols per file using BM25+ (query-relevant, not just by authority)
  const topFilePaths = topResults.map((r) => r.path);
  const symbolRanking = rankSymbols(topFilePaths, graph, query);

  const results = topResults.map((r) => {
    // F.3: match_type from ground truth, not score heuristics
    const inBm25f = bm25fSet.has(r.path);
    const inSemantic = semanticSet.has(r.path);

    let match_type: "lexical" | "semantic" | "semantic+lexical";
    if (inBm25f && inSemantic) {
      match_type = "semantic+lexical";
    } else if (inSemantic) {
      match_type = "semantic";
    } else {
      match_type = "lexical";
    }

    // Use query-relevant symbols (from rankSymbols) instead of just top-authority
    const syms = symbolRanking.get(r.path) ?? [];
    const symbols = syms.map((s: SymbolMatch) => s.name);

    const confidence = maxScore > 0 ? Math.round((r.score / maxScore) * 100) / 100 : 0;

    return { file: r.path, symbols, match_type, confidence };
  });

  return { query, results };
}

// ── Semantic search helper ───────────────────────────────────────────────────

/**
 * Run semantic search independently and return file paths.
 * Separated from the hybrid provider to get raw semantic results for match_type classification.
 */
async function getSemanticFiles(hybrid: HybridSearchProvider, query: string): Promise<string[]> {
  // Use a dummy empty BM25F list to get semantic-only results from the hybrid provider
  // If semantic is unavailable, this returns an empty array (the provider's fallback path
  // returns BM25F-only scores, but with an empty BM25F list that means zero results)
  const results = await hybrid.search(query, [], 50);
  // If semantic is unavailable, results will be empty (empty BM25F + no semantic = [])
  return results.map((r) => r.path);
}
