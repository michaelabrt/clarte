// Re-export facade: all public API from graph sub-modules.
// Downstream files can continue importing from "./graph.js" unchanged.

export type { RawImport } from "./ast-parse.js";
export {
  JS_EXTENSIONS,
  INDEX_FILES,
  SOURCE_IGNORE,
  type PathAlias,
  type BarrelExportMap,
  type ResolveContext,
  loadTsconfigPaths,
  resolveAliasImport,
  getSourceGlob,
  parseJsImports,
  parsePythonImports,
  parseGoImports,
  parseRustImports,
  parseJavaImports,
  parseImports,
  isRelativeSpecifier,
  resolveJsImport,
  loadGoModule,
  detectJavaSourceRoots,
  resolveImport,
  resolveBarrelFiles,
  getPackageName,
} from "./import-resolution.js";

export {
  computeHITS,
  deriveRole,
  simpleHash,
  seededRandom,
  computeBetweenness,
} from "./centrality.js";

export {
  findSCCs,
  findCircularDeps,
  findFeedbackEdges,
} from "./graph-cycles.js";

export {
  findUsedExports,
  getHubFiles,
  detectArchitecturalLayers,
  INSTABILITY_THRESHOLD,
  computeInstability,
  detectCommunities,
  findDeadFiles,
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
  computeGraphTopology,
  findStructuralTemporalMismatches,
  findTightCouplings,
  checkArchitecturalFitness,
} from "./graph-analysis.js";

export {
  detectBarrelFiles,
  buildImportGraph,
  mergeGraph,
} from "./graph-build.js";
