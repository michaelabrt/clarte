/**
 * Internal types used within core orchestration files.
 * Not part of the public API — not re-exported from types/index.ts.
 */
import type {
  ArchitecturalLayer,
  ArchViolation,
  Chokepoint,
  CircularDependency,
  Community,
  ConfigConstraints,
  CrossCuttingFile,
  FileInstability,
  GraphTopology,
  HubFile,
  InferredConventions,
  LayerConsistency,
  LayerEdge,
  MonorepoAnalysis,
  StructuralTemporalMismatch,
  TestMapping,
  TightCoupling,
} from "./index.js";

/** Shared logging context passed to phase helpers */
export interface LogCtx {
  jsonMode: boolean;
  verbose: boolean;
}

/** Result of the graph analysis phase (all deterministic/cacheable results) */
export interface GraphPhaseResult {
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  layerEdges: LayerEdge[];
  instabilities: FileInstability[];
  communities: Community[];
  deadFiles: string[];
  crossCuttingFiles: CrossCuttingFile[];
  layerConsistency?: LayerConsistency;
  chokepoints: Chokepoint[];
  graphTopology: GraphTopology;
  tightCouplings?: TightCoupling[];
  archViolations?: ArchViolation[];
}

/** Timing breakdown for each analysis phase */
export interface PhaseTiming {
  graphPhaseMs: number;
  gitPhaseMs: number;
  projectPhaseMs: number;
  deltaPhaseMs: number;
  totalMs: number;
  graphCacheHit: boolean;
  projectCacheHit: boolean;
  /** Wall-clock time for the overlapped git+project parallel group */
  parallelGroupMs: number;
}

/** Result of the project analysis phase (config, conventions, tests, monorepo) */
export interface ProjectPhaseResult {
  configConstraints: ConfigConstraints | undefined;
  conventions?: InferredConventions;
  testMapping?: TestMapping;
  structuralMismatches?: StructuralTemporalMismatch[];
  monorepoAnalysis?: MonorepoAnalysis;
  changeImpact?: Map<string, Array<{ file: string; score: number }>>;
}
