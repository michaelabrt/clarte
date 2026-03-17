// ── Katz Centrality ──────────────────────────────────────────────────────────

/** Fraction of 1/rho(A) used as the attenuation factor alpha */
export const KATZ_ALPHA_FRACTION = 0.85;

/** Hard cap on Katz iterations */
export const KATZ_MAX_ITERATIONS = 50;

/** L2 norm convergence threshold for Katz iteration */
export const KATZ_CONVERGENCE_EPSILON = 1e-6;

/** Scores below this are dropped from the output */
export const KATZ_MIN_SCORE = 1e-4;

/** Power iteration steps for spectral radius estimation */
export const KATZ_SPECTRAL_ITERATIONS = 10;

// ── Bipartite LSA ────────────────────────────────────────────────────────────

/** Number of latent dimensions for truncated SVD */
export const LSA_RANK = 32;

/** Oversampling parameter p for randomized SVD (total columns = rank + oversampling) */
export const LSA_OVERSAMPLING = 10;

/** Power iterations for improved SVD approximation quality */
export const LSA_POWER_ITERATIONS = 2;

/** Minimum cosine similarity to the seed centroid for LSA expansion */
export const LSA_COSINE_THRESHOLD = 0.3;

/** Conceptual seeds enter at this fraction of the minimum BM25F seed score */
export const LSA_EXPANSION_DISCOUNT = 0.4;

/** Maximum number of conceptual seeds added by LSA expansion */
export const LSA_MAX_EXPANSIONS = 5;

/** Minimum codebase size for LSA to produce meaningful structure */
export const LSA_MIN_FILES = 50;

// ── Blame-Boundary Temporal Decay ────────────────────────────────────────────

/** Decay rate for blame recency: -ln(BLAME_FLOOR) / 90 ~ 0.0333 */
export const BLAME_LAMBDA = 0.0333;

/** Minimum blame decay value for ancient or untracked symbols */
export const BLAME_FLOOR = 0.05;

/** Maximum concurrent git blame processes */
export const BLAME_BATCH_SIZE = 50;

/** Default days-since-modified for symbols with no blame data */
export const BLAME_DEFAULT_DAYS = 365;
