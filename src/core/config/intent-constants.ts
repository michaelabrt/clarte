/**
 * RFC-002 Intent Propagation constants and types.
 *
 * All tuning parameters for the predictive intelligence pipeline.
 * Constants match RFC-002 sections exactly; changing any value
 * invalidates cached prediction traces.
 */

import type { SymbolEdgeKind } from "../graph/symbol-types";

// ── Transmission coefficients (Section 1.5) ─────────────────────────────────
// gamma(u, v) for each edge kind in the forward direction.

export const TRANSMISSION: Record<SymbolEdgeKind, number> = {
  calls: 0.7,
  extends: 0.8,
  implements: 0.6,
  satisfies: 0.5,
  embeds: 0.75,
  uses_type: 0.3,
  decorates: 0.9,
  imports: 0.7,
};

/** Reverse-direction multiplier (Section 1.5 directional asymmetry). */
export const REVERSE_MULTIPLIER = 0.7;

/** Ghost edge discount (Section 4.2): ghost gamma = gamma_kind * GHOST_DISCOUNT. */
export const GHOST_DISCOUNT = 0.6;

// ── Propagation limits ──────────────────────────────────────────────────────

export const MAX_PROPAGATION_HOPS = 3;

// ── Phase 2 seeding (Section 1.4) ───────────────────────────────────────────

/** Chokepoint threshold: symbols above the 75th percentile of betweenness. */
export const BETWEENNESS_PERCENTILE = 0.75;

/** Below this propagated score, a symbol received negligible intent signal. */
export const INTENT_MIN = 0.1;

/** Re-propagation depth from chokepoints. */
export const PHASE2_MAX_HOPS = 1;

// ── Score fusion weights (Section 1.3) ──────────────────────────────────────
// lambda_L + lambda_G + lambda_T + lambda_B = 1.0

export const LAMBDA_LEXICAL = 0.35;
export const LAMBDA_GRAPH = 0.35;
export const LAMBDA_TEMPORAL = 0.15;
export const LAMBDA_BETWEENNESS = 0.15;

// ── Confidence thresholds (Section 2.6) ─────────────────────────────────────

export const THETA_HIGH = 0.7;
export const THETA_LOW = 0.3;

// ── Prediction limits (Section 1.7) ─────────────────────────────────────────

export const MIN_PREDICTIONS = 1;
export const MAX_PREDICTIONS = 5;

// ── Seed selection ──────────────────────────────────────────────────────────

export const SEED_TOP_K = 10;

// ── Context pruning (Section 3) ─────────────────────────────────────────────

export const MAX_CONTEXT_TOKENS = 1500;
export const GAMMA_MAX_COVERAGE = 0.8;
export const DIMINISHING_RETURNS_EPSILON = 0.05;
export const SUBMODULAR_FALLBACK_THRESHOLD = 2000;

// ── Ghost edge confidence (Section 4.2) ─────────────────────────────────────
// 0.6 * TIER_3_FACTORY (0.25) = 0.15

export const GHOST_CONFIDENCE = 0.15;

// ── Noise gate (Section 4.4) ────────────────────────────────────────────────

export const GHOST_FREQUENCY_THRESHOLD = 0.1;
export const GHOST_COMMUNITY_DISCOUNT = 0.5;

// ── Staleness (Section 2.5) ─────────────────────────────────────────────────

export const STALE_COMMIT_THRESHOLD = 10;
export const STALE_FILE_OVERLAP_THRESHOLD = 0.3;
export const STALE_GRAPH_DISCOUNT = 0.5;

// ── Smart Silence (Section 2.5) ─────────────────────────────────────────────

export const MIN_PROJECT_FILES = 5;

// ── Performance budget (Section 5.1) ────────────────────────────────────────

export const LATENCY_BUDGET_MS = 300;
export const STAGE_OVERDRAFT_MULTIPLIER = 2;

// ── Types ───────────────────────────────────────────────────────────────────

export interface SymbolMatch {
  name: string;
  score: number;
  line: number;
}

export interface IntentPrediction {
  file: string;
  rank: number;
  score: number;
  confidence: "high" | "medium";
  signals: {
    lexical: number;
    graph: number;
    temporal: number;
    betweenness: number;
  };
  theory: TheoryOfImpact;
  verification: VerificationResult;
  symbols: SymbolMatch[];
}

export interface TheoryOfImpact {
  lexical_evidence: string | null;
  graph_path: string | null;
  temporal_pair: string | null;
  betweenness_rank: number | null;
}

export interface VerificationResult {
  edge_exists: boolean;
  file_exists: boolean;
  symbol_exists: boolean;
  monotonic: boolean;
}

export interface PredictionTrace {
  timestamp: string;
  query_hash: string;
  graph_commit: string;
  timing_ms: {
    total: number;
    seed_selection: number;
    subgraph_extraction: number;
    intent_propagation: number;
    phase2_seeding: number | null;
    temporal_fusion: number;
    verification: number;
    context_pruning: number;
    rendering: number;
  };
  seeds: Array<{
    file: string;
    bm25f_score: number;
    token_matches: string[];
  }>;
  predictions: IntentPrediction[];
  suppressed: {
    reason: string | null;
    count: number;
  };
  context: {
    budget_tokens: number;
    used_tokens: number;
    symbols_selected: number;
    symbols_available: number;
    marginal_gain_at_stop: number;
  };
  feedback?: {
    precision: number;
    recall: number;
    mrr: number;
    edited_files: string[];
  };
}
