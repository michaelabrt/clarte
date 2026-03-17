/**
 * clarte_find MCP tool.
 *
 * "Where is the code that does X?" - Full BM25F pipeline + Semantic + RRF fusion.
 *
 * ANN pre-filter: semantic search is bounded to BM25F top-1000
 * candidates instead of flat-scanning all embeddings.
 * Rationale field explains match provenance.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter";
import { HybridSearchProvider } from "../../search/hybrid-search";
import { rrfFusion } from "../../search/rrf-fusion";
import { resolveEditTargetsWithMeta, rankSymbols, type SymbolMatch } from "../../steer/targets-resolve";
import { buildPersistedGraphFromStore } from "../../storage/loader";
import { GraphStore } from "../../storage/graph-store";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FindInput {
  query: string;
}

interface FindResultEntry {
  file: string;
  symbols: string[];
  match_type: "lexical" | "semantic" | "semantic+lexical";
  confidence: number;
  /** Graph-derived explanation for why this file matched */
  rationale: string;
}

export interface FindOutput {
  query: string;
  results: FindResultEntry[];
}

// ── Module-level singletons (avoid per-call reconstruction) ──────────────────

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

// ── Constants ─────────────────────────────────────────────────────────────────

/**
 * BM25F candidate pool size for ANN pre-filtering.
 * Semantic search scans only these candidates instead of the full embedding store.
 * 1000 is the sweet spot: covers 95%+ recall while reducing scan cost by 50-500x.
 */
const ANN_CANDIDATE_POOL = 1000;

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Search for files matching a natural language query.
 *
 * Pipeline:
 * 1. Run full BM25F pipeline with extended candidate pool (N=1000 for ANN pre-filter)
 * 2. Run semantic retrieval within the BM25F candidate pool (ANN pre-filter)
 * 3. RRF fusion of top BM25F + semantic reranked list
 * 4. Top 5 files with per-file symbol annotations and rationale
 */
export async function executeFind(db: DatabaseAdapter, input: FindInput): Promise<FindOutput> {
  const { query } = input;
  const MAX_RESULTS = 5;

  const graph = getPersistedGraph(db);

  // Step 1: Extended BM25F candidate pool for ANN pre-filtering
  const allCandidates = resolveEditTargetsWithMeta(query, graph, ANN_CANDIDATE_POOL);
  const bm25fFiles = allCandidates.slice(0, 20).map((t) => t.file);
  const candidatePool = new Set(allCandidates.map((t) => t.file));

  // Step 2: Semantic search within BM25F candidate pool (ANN pre-filter)
  const hybrid = getHybridProvider(db);
  const semanticFiles = await getSemanticFiles(hybrid, query, candidatePool);

  // Step 3: RRF fusion (or BM25F-only if no semantic results)
  let fusedResults: Array<{ path: string; score: number }>;
  const hasSemanticResults = semanticFiles.length > 0;

  if (hasSemanticResults) {
    fusedResults = rrfFusion(bm25fFiles, semanticFiles);
  } else {
    fusedResults = bm25fFiles.map((path, i) => ({ path, score: 1 / (60 + i + 1) }));
  }

  // Step 4: Build output with annotations and rationale
  const topResults = fusedResults.slice(0, MAX_RESULTS);
  const maxScore = topResults[0]?.score ?? 1;
  const bm25fSet = new Set(bm25fFiles);
  const semanticSet = new Set(semanticFiles);

  const topFilePaths = topResults.map((r) => r.path);
  const symbolRanking = rankSymbols(topFilePaths, graph, query);

  const results = topResults.map((r) => {
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

    const syms = symbolRanking.get(r.path) ?? [];
    const symbols = syms.map((s: SymbolMatch) => s.name);
    const confidence = maxScore > 0 ? Math.round((r.score / maxScore) * 100) / 100 : 0;

    // Build rationale from match provenance
    const rationale = buildRationale(match_type, symbols, r.path, bm25fFiles);

    return { file: r.path, symbols, match_type, confidence, rationale };
  });

  return { query, results };
}

// ── Semantic search helper ───────────────────────────────────────────────────

/**
 * Run semantic search within BM25F candidate pool.
 * Passes candidatePaths to the hybrid provider to bound the cosine scan.
 */
async function getSemanticFiles(
  hybrid: HybridSearchProvider,
  query: string,
  candidatePool: Set<string>,
): Promise<string[]> {
  // With ANN pre-filter: semantic search only scans candidate pool
  // Empty pool still works (returns empty results gracefully)
  const results = await hybrid.search(query, [], 50, candidatePool);
  return results.map((r) => r.path);
}

// ── Rationale builder ─────────────────────────────────────────────────────────

/**
 * Generate human-readable rationale for why a file matched.
 * Uses match provenance (lexical/semantic/both) and symbol names from BM25F ranking.
 */
function buildRationale(
  matchType: "lexical" | "semantic" | "semantic+lexical",
  symbols: string[],
  filePath: string,
  bm25fTopFiles: string[],
): string {
  const bm25fRank = bm25fTopFiles.indexOf(filePath);
  const symList = symbols.length > 0 ? symbols.slice(0, 3).join(", ") : "file-level";

  switch (matchType) {
    case "lexical":
      return bm25fRank >= 0
        ? `BM25F lexical match (rank #${bm25fRank + 1}, symbols: ${symList})`
        : `BM25F lexical match via spreading activation (symbols: ${symList})`;
    case "semantic":
      return `Semantic similarity within BM25F candidate pool (symbols: ${symList})`;
    case "semantic+lexical":
      return `Combined BM25F (rank #${bm25fRank + 1}) + semantic similarity (symbols: ${symList})`;
  }
}
