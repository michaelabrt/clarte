/**
 * Phase 6 constants: Advanced Disambiguation and Probabilistic Flow Tracing.
 */

// ── Part 1: Constraint-Scored Call Resolution ────────────────────────────────

/** Exponent on HITS authority in proximity scoring: alpha(c)^beta */
export const PROXIMITY_AUTHORITY_BETA = 0.5;

/** Minimum Laplace-smoothed Jaccard to accept a candidate */
export const PROXIMITY_MIN_JACCARD = 0.05;

/** Symbol neighborhood size below which file-level Jaccard is used instead */
export const PROXIMITY_COLD_START_THRESHOLD = 3;

/** Laplace smoothing constant for Jaccard: (|A∩B|+alpha) / (|A∪B|+2*alpha) */
export const PROXIMITY_LAPLACE_ALPHA = 1;

// Locality multipliers (spatial scalars replacing flat export bonus)
export const LOCALITY_SAME_FILE = 10.0;
export const LOCALITY_SAME_COMMUNITY = 2.0;
export const LOCALITY_CROSS_EXPORTED = 1.0;
// Cross-community + unexported OR cross-file + unexported: candidate dropped (0.0)

// ── Part 2: Probabilistic Execution Flow Tracing ─────────────────────────────

/** Exponent on HITS authority in transition weight: alpha(v)^beta */
export const MARKOV_AUTHORITY_BETA = 0.7;

/** Floor for symbol authority to prevent zero transition weights */
export const MARKOV_AUTHORITY_FLOOR = 0.01;

/** Minimum temporal decay value for file pairs with no/ancient co-change data */
export const MARKOV_TEMPORAL_FLOOR = 0.05;

/** Decay rate: -ln(TEMPORAL_FLOOR) / 90 days ~ 0.0333 */
export const MARKOV_TEMPORAL_LAMBDA = 0.0333;

/** Forward propagation stops when total transitive mass < epsilon */
export const MARKOV_CONVERGENCE_EPSILON = 1e-4;

/** Hard cap on propagation iterations */
export const MARKOV_MAX_STEPS = 20;

/** Minimum visit probability to include a symbol in the flow signature */
export const MARKOV_VISIT_THRESHOLD = 0.01;

/** Maximum states in the output flow signature */
export const MARKOV_MAX_FLOW_STATES = 30;

/**
 * Mass floor below which a node's contribution is skipped during propagation.
 * Prevents O(V) work on effectively-zero entries. Well above float64 epsilon (2.2e-16).
 */
export const MARKOV_MASS_FLOOR = 1e-10;

// Domain-Terminal Filtering
/** Weight multiplier for cross-community utility sinks (loggers, formatters) */
export const UTILITY_TERMINAL_PENALTY = 0.05;

/** Indegree threshold above which a cross-community terminal is considered a utility sink */
export const UTILITY_INDEGREE_THRESHOLD = 5;

// ── Part 1 supplement: authority floor for proximity scoring ──────────────────

/**
 * Floor for candidate authority in proximity scoring: max(alpha, floor).
 * Prevents zero-authority candidates from being invisible to the Jaccard product.
 * Mirrors MARKOV_AUTHORITY_FLOOR but semantically distinct (disambiguation vs. flow).
 */
export const PROXIMITY_AUTHORITY_FLOOR = 0.01;
