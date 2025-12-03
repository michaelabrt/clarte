// Re-export facade: all implementations live in src/graph/ submodules.
// Existing imports from "./graph-analysis.js" continue to work unchanged.

export { findUsedExports, getHubFiles } from "./graph/hub-files.js";
export { detectCommunities } from "./graph/communities.js";
export { findDeadFiles } from "./graph/dead-files.js";
export { findCrossCuttingFiles } from "./graph/cross-cutting.js";
export { detectArchitecturalLayers, computeLayerConsistency } from "./graph/layers.js";
export { findChokepoints } from "./graph/chokepoints.js";
export { computeGraphTopology } from "./graph/topology.js";
export { findStructuralTemporalMismatches } from "./graph/mismatches.js";
export { findTightCouplings } from "./graph/tight-coupling.js";
export { INSTABILITY_THRESHOLD, computeInstability } from "./graph/instability.js";
export { checkArchitecturalFitness } from "./graph/fitness.js";
