/** Maximum commits to sample for weight training */
export const FUSION_TRAINING_COMMITS = 500;

/** Hard negative sampling ratio (negatives per positive) */
export const FUSION_NEGATIVE_RATIO = 3;

/** Gradient descent learning rate */
export const FUSION_LEARNING_RATE = 0.1;

/** Maximum gradient descent iterations */
export const FUSION_MAX_ITERATIONS = 200;

/** Convergence threshold (max gradient component) */
export const FUSION_CONVERGENCE_EPSILON = 1e-6;

/** L2 regularization strength */
export const FUSION_L2_LAMBDA = 0.01;

/** Minimum commits required to train (below this, fall back to hardcoded weights) */
export const FUSION_MIN_COMMITS = 30;

/** Maximum BFS depth for graph proximity features */
export const FUSION_MAX_HOPS = 3;

/** Minimum attenuation factor (prevents complete choking) */
export const INF_FLOOR = 0.05;

/** Maximum attenuation factor */
export const INF_CEILING = 1.0;

/** Hub/sink ratio clamp lower bound */
export const HUB_SINK_FLOOR = 0.05;

/** Per-commit decay factor for EWMA counters */
export const EWMA_DECAY = 0.995;

/** Structural prior strength (higher = more inertia before observations shift the weight) */
export const EWMA_PRIOR_STRENGTH = 15;

/** Minimum expected weight to prevent edges from being fully zeroed */
export const EWMA_WEIGHT_FLOOR = 0.01;
