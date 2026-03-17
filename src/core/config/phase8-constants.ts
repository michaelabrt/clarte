export const FUSION_TRAINING_COMMITS = 500;
export const FUSION_NEGATIVE_RATIO = 3;
export const FUSION_LEARNING_RATE = 0.1;
export const FUSION_MAX_ITERATIONS = 200;
export const FUSION_CONVERGENCE_EPSILON = 1e-6;
export const FUSION_L2_LAMBDA = 0.01;
export const FUSION_MIN_COMMITS = 30;
export const FUSION_MAX_HOPS = 3;

export const INF_FLOOR = 0.05;
export const INF_CEILING = 1.0;
export const HUB_SINK_FLOOR = 0.05;

export const EWMA_DECAY = 0.995;

/** Higher = more inertia before observations shift the weight */
export const EWMA_PRIOR_STRENGTH = 15;

export const EWMA_WEIGHT_FLOOR = 0.01;
