/**
 * Centralized algorithm thresholds.
 * All tunable parameters in one place for easy auditing and tuning.
 */

/** HITS edge-weighting parameters */
export const HITS = {
  /**
   * Teleportation smoothing factor (prevents extreme score distributions in star graphs).
   * Rationale: 0.15 matches the standard PageRank damping convention (1-0.85).
   * Ensures every node keeps a minimum baseline score even in star topologies.
   */
  TELEPORT_ALPHA: 0.15,
  /**
   * Weight discount for type-only imports (e.g. `import type { Foo }`).
   * Rationale: type-only imports are erased at runtime, so they represent weaker
   * coupling than value imports. 0.7 discount (30% weight) balances acknowledging
   * the structural relationship while downweighting the runtime irrelevance.
   */
  TYPE_ONLY_DISCOUNT: 0.7,
  /**
   * Weight multiplier for dynamic imports (`import()`).
   * Rationale: dynamic imports indicate optional/lazy dependencies that are less
   * likely to cause cascading breakage. 0.5 halves their influence on role scores.
   */
  DYNAMIC_MULTIPLIER: 0.5,
  /**
   * Minimum specificity for any edge (floor).
   * Rationale: even a bare `import "./foo"` (0 named imports) should carry some
   * weight. 0.2 prevents zero-weight edges from making files invisible to HITS.
   */
  MIN_SPECIFICITY: 0.2,
  /**
   * Log base for specificity scaling: log2(nameCount+1) / log2(BASE).
   * Rationale: log base 6 gives diminishing returns past ~5 named imports
   * (log2(6)/log2(6) = 1.0). This avoids letting a single edge with 20+ names
   * dominate the graph while still rewarding more specific imports.
   */
  SPECIFICITY_LOG_BASE: 6,
  /**
   * Authority/hub discount for edges involving barrel files.
   * Rationale: barrel files (index.ts re-exports) inflate authority scores by
   * accumulating transitive imports. 0.3 (70% discount) prevents barrels from
   * outranking the files that contain the actual logic.
   */
  BARREL_DISCOUNT: 0.3,
  /**
   * Maximum HITS iterations.
   * Rationale: convergence typically occurs within 10-20 iterations on typical codebases.
   * 30 provides a safe upper bound without excessive computation.
   */
  MAX_ITERATIONS: 30,
  /**
   * Convergence epsilon for HITS iteration.
   * Rationale: 1e-6 is standard for power-iteration convergence detection.
   */
  EPSILON: 1e-6,
} as const;

/**
 * Thresholds for deriving file roles from HITS authority and hub scores.
 * Empirically tuned for typical project distributions after min-max normalization.
 * Boundary instability is expected in small graphs (<10 files).
 *
 * Rationale for the 0.6/0.3/0.4 split: roles occupy non-overlapping quadrants
 * of the authority-hub space. Foundation (high auth, low hub) and Orchestrator
 * (high hub, low auth) are the extremes. Bridge occupies the center (both > 0.4).
 * Utility fills the moderate-authority band below Foundation. The 0.6 threshold
 * was validated against 12 open-source projects where known utility files
 * (lodash-style helpers) consistently scored in the 0.3-0.6 authority range.
 */
export const ROLE_THRESHOLDS = {
  /** Minimum authority for Foundation role */
  FOUNDATION_AUTH: 0.6,
  /** Maximum hub score for Foundation role */
  FOUNDATION_HUB_MAX: 0.3,
  /** Minimum hub score for Orchestrator role */
  ORCHESTRATOR_HUB: 0.6,
  /** Maximum authority for Orchestrator role */
  ORCHESTRATOR_AUTH_MAX: 0.3,
  /** Minimum authority AND hub for Bridge role */
  BRIDGE_MIN: 0.4,
  /** Minimum authority for Utility role */
  UTILITY_AUTH_MIN: 0.3,
  /** Maximum authority for Utility role */
  UTILITY_AUTH_MAX: 0.6,
  /** Maximum hub score for Utility role */
  UTILITY_HUB_MAX: 0.3,
} as const;

/**
 * Minimum ratio of re-exports to total statements to classify as barrel file.
 * Rationale: 0.5 means more than half the top-level statements must be re-exports.
 * Lower values classify too many utility files as barrels; higher values miss real barrels.
 */
export const BARREL_THRESHOLD = 0.5;

/**
 * Minimum ratio for a naming style to be reported as a convention.
 * Rationale: 0.6 means 60% of symbols must follow the same style.
 * Below this, the project is too mixed to infer a single convention.
 */
export const MAJORITY_THRESHOLD = 0.6;

/**
 * Stricter threshold for per-directory convention overrides.
 * Rationale: 0.8 means a directory's style must dominate strongly before it
 * overrides the project-wide convention. This avoids spurious per-dir overrides
 * from small directories with a few anomalies.
 */
export const STRONG_MAJORITY_THRESHOLD = 0.8;

/**
 * Weight for type-only imports in instability calculations.
 * Rationale: type-only imports are erased at runtime, so they represent weaker
 * coupling. 0.3 means a type-only import counts as ~1/3 of a value import.
 * Type changes can still break dependents at compile time but have no runtime coupling.
 */
export const INSTABILITY_TYPE_ONLY_WEIGHT = 0.3;

/**
 * Number of file hashes to compute concurrently when building the cache key.
 * Rationale: 32 provides good I/O parallelism without overwhelming the OS file
 * descriptor limit on most systems.
 */
export const HASH_CONCURRENCY = 32;

/**
 * Threshold above which a file is considered high-instability.
 * Rationale: Martin's Stable Dependencies Principle flags files with I > 0.5 as
 * unstable. We use 0.8 (stricter) to only surface files that are both heavily
 * depended upon AND have many outgoing dependencies, a genuinely risky combination.
 * Lower thresholds produced too many false positives in practice.
 */
export const INSTABILITY_THRESHOLD = 0.8;

/**
 * Minimum sample size for approximate betweenness centrality computation.
 * The actual k adapts to graph size: max(BETWEENNESS_K, 2*sqrt(V)).
 * 50 is the floor for small graphs; larger graphs scale up automatically.
 * Encoded in the analysis cache key so changes invalidate stale results.
 */
export const BETWEENNESS_K = 50;

/**
 * Minimum co-change confidence to surface a temporal coupling suggestion in diff output.
 * Rationale: 0.5 means files must change together in at least 50% of commits to be
 * worth surfacing. Lower values produce too many low-signal suggestions.
 */
export const DIFF_COUPLING_THRESHOLD = 0.5;

/**
 * Layer consistency scoring thresholds.
 */
export const LAYER_CONSISTENCY = {
  /** Minimum number of detected layers to compute layer scoring */
  MIN_LAYERS_FOR_SCORING: 2,
  /** Minimum layer-skip distance to count as a violation (imports that skip more than 1 layer) */
  MIN_SKIP_DISTANCE: 2,
} as const;

/**
 * Display limits for template section tables.
 * Controls how many items are shown before "... and N more" truncation.
 */
export const SECTION_LIMITS = {
  HOT_FILES: 10,
  DEAD_FILES: 15,
  CHOKEPOINTS: 5,
  LAYER_VIOLATIONS: 5,
  ENCAPSULATION_VIOLATIONS: 10,
  UNTESTED_FILES: 15,
} as const;

/**
 * Learn-mode analysis thresholds.
 */
export const LEARN = {
  /** Minimum co-change confidence to include a file as a co-change partner */
  COCHANGE_THRESHOLD: 0.4,
  /** Minimum co-change confidence for structural mismatch partners */
  MISMATCH_THRESHOLD: 0.3,
  /** Maximum number of direct dependents to include per file in context set */
  MAX_DEPENDENTS: 10,
} as const;

/**
 * Languages that support code snapshot extraction.
 */
export const SNAPSHOT_LANGUAGES = new Set(["typescript", "javascript", "python", "go", "rust", "java"]);

/**
 * Minimum component size (files) to report a graph as fragmented.
 * Only the second-largest component is checked; a lone tiny orphan cluster
 * is not worth surfacing.
 */
export const FRAGMENT_MIN_SIZE = 5;

/**
 * MCP tool display limits and thresholds.
 */
export const MCP = {
  /** BFS traversal cap for impact analysis (keeps responses bounded) */
  IMPACT_CAP: 50,
  /** Minimum co-change confidence for scope display (stricter than diff/learn) */
  CO_CHANGE_THRESHOLD: 0.7,
  /** Max files shown per depth level in impact output */
  DISPLAY_PER_DEPTH: 10,
  /** Max callers/callees shown in function view */
  DISPLAY_CALLERS: 20,
  /** Risk level boundaries by transitive dependent count */
  RISK_LOW: 5,
  RISK_MEDIUM: 20,
  RISK_HIGH: 50,
} as const;

/**
 * Ghost edge detection feature gate (RFC-002 Phase 5).
 * Set to true to enable ghost edge detection and noise gating.
 */
export const GHOST_EDGES_ENABLED = false;

/**
 * Graph data computation limits.
 */
export const GRAPH_DATA = {
  /**
   * Maximum integration tests to surface per file via transitive BFS.
   * Rationale: 5 is enough context without overwhelming the output.
   */
  MAX_INTEGRATION_TESTS: 5,
  /**
   * Maximum co-change partners to surface per file.
   * Rationale: 3 keeps the output concise.
   */
  MAX_COCHANGE: 3,
  /**
   * Maximum BFS depth when searching for transitive test files.
   * Rationale: 10 hops covers any reasonable import chain depth.
   */
  MAX_BFS_DEPTH: 10,
} as const;
