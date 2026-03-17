/**
 * Execution flow tracing constants.
 *
 * Tuning parameters for the flow tracing pipeline: dominator trees,
 * k-diverse-shortest-paths and community-aware path annotation.
 */

// ── Traversal limits ─────────────────────────────────────────────────────────

/** Maximum traversal depth for flow paths. Up from current 5. */
export const MAX_FLOW_DEPTH = 10;

/** Maximum number of flows returned per query. Up from current 3. */
export const MAX_FLOWS = 5;

/** Number of diverse paths to find per (entry, terminal) pair. */
export const K_DIVERSE_PATHS = 3;

/** Minimum path length (in edges) for a flow to be worth showing. */
export const MIN_FLOW_LENGTH = 2;

// ── Edge filtering ───────────────────────────────────────────────────────────

/**
 * Edge kinds traversed during flow tracing.
 * Structural edges + ghost edges representing runtime connections.
 * Excludes uses_type, satisfies, imports (not execution).
 */
export const FLOW_EDGE_KINDS = new Set([
  "calls",
  "extends",
  "decorates",
  "ghost:route",
  "ghost:di_inject",
  "ghost:event_bind",
]);

/** Weight multiplier for ghost edges in flow cost computation. Matches GHOST_DISCOUNT in intent-constants.ts. */
export const FLOW_GHOST_DISCOUNT = 0.6;

// ── Path diversity ───────────────────────────────────────────────────────────

/**
 * Overlap threshold for Yen's diversity filter.
 * Two paths sharing more than this fraction of nodes are considered redundant.
 */
export const PATH_OVERLAP_THRESHOLD = 0.7;

// ── Compression ──────────────────────────────────────────────────────────────

/**
 * Betweenness percentile above which a node is a "waypoint" shown
 * in compressed path views. Nodes below this are collapsed into
 * "[N calls]" summaries.
 */
export const COMPRESSION_BETWEENNESS_PERCENTILE = 0.7;

// ── Entry point detection ────────────────────────────────────────────────────

/** Minimum entry point score (0-1) to include in results. */
export const ENTRY_POINT_MIN_SCORE = 0.3;

/** Entry point signal weights (sum = 1.0). */
export const ENTRY_WEIGHTS = {
  /** No incoming calls + exported */
  NO_CALLERS: 0.3,
  /** Target of ghost:route edge */
  ROUTE_TARGET: 0.3,
  /** Matches framework convention (handle*, *Controller, etc.) */
  FRAMEWORK_MATCH: 0.2,
  /** High HITS hub score + exported */
  HUB_EXPORTED: 0.2,
} as const;

// ── Safety valves ────────────────────────────────────────────────────────────

/** Cap on (entry x terminal) pairs to prevent combinatorial explosion (3x3). */
export const MAX_ENTRY_TERMINAL_PAIRS = 9;

/** Fall back to simple BFS if flow-filtered subgraph exceeds this node count. */
export const FLOW_SUBGRAPH_MAX_NODES = 2000;
