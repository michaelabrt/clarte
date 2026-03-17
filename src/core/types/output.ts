import type { ConfigConstraints } from "./detection";
import type {
  HubFile,
  CircularDependency,
  ArchitecturalLayer,
  LayerEdge,
  FileInstability,
  Community,
} from "./graph";
import type { GitAnalysis } from "./git";
import type {
  CrossCuttingFile,
  LayerConsistency,
  Chokepoint,
  InferredConventions,
  TestMapping,
  GraphTopology,
  StructuralTemporalMismatch,
  TightCoupling,
  MonorepoAnalysis,
  ArchViolation,
} from "./analysis";

/** A generated file ready to be written */
export interface GeneratedFile {
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

/** Progress callback for reporting sub-step progress */
export type ProgressCallback = (message: string) => void;

/** A rendered section of the context file with priority and token estimate */
export interface ContextSection {
  /** Unique section identifier */
  id: string;
  /** Priority level: 0 = always included, 1 = highest, 10 = lowest */
  priority: number;
  /** Rendered markdown content */
  content: string;
  /** Estimated token count */
  tokens: number;
}

/** A Claude Code skill definition */
export interface ClaudeSkill {
  /** Skill name (used as directory name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** If true, skill cannot invoke the model; it just injects content */
  disableModelInvocation: boolean;
  /** Comma-separated allowed tools (e.g. "Read, Grep, Glob") */
  allowedTools?: string;
  /** Markdown body of the skill */
  body: string;
}

/** 2-hop neighborhood of changed files in an import graph */
export interface NeighborhoodResult {
  /** All direct neighbors (union of importers + dependencies) */
  hop1: Set<string>;
  /** All 2-hop neighbors */
  hop2: Set<string>;
  /** Files that import a changed file (downstream dependents) */
  hop1Importers: Set<string>;
  /** Files imported by a changed file (upstream dependencies) */
  hop1Dependencies: Set<string>;
  /** 2-hop files that are downstream of hop1 */
  hop2Importers: Set<string>;
  /** 2-hop files that are upstream of hop1 */
  hop2Dependencies: Set<string>;
}

/** Bundle of all structural analysis results */
export interface ContextAnalysis {
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  /** Directed edges between architectural layers */
  layerEdges: LayerEdge[];
  gitActivity: GitAnalysis | null;
  /** Instability scores for files */
  instabilities: FileInstability[];
  /** Detected module clusters/communities */
  communities: Community[];
  /** Files with zero in-degree (not imported by anything) */
  deadFiles?: string[];
  /** Extracted config constraints (tsconfig, linter, formatter) */
  configConstraints?: ConfigConstraints;
  /** Files imported across multiple architectural layers */
  crossCuttingFiles?: CrossCuttingFile[];
  /** Layer dependency consistency score and violations */
  layerConsistency?: LayerConsistency;
  /** Architectural chokepoints (articulation points) */
  chokepoints?: Chokepoint[];
  /** Inferred coding conventions (naming, export style, import ordering) */
  conventions?: InferredConventions;
  /** Test-to-source file mapping */
  testMapping?: TestMapping;
  /** Graph topology metrics */
  graphTopology?: GraphTopology;
  /** File pairs that co-change frequently but are structurally distant */
  structuralMismatches?: StructuralTemporalMismatch[];
  /** File pairs with high import specificity (tight coupling) */
  tightCouplings?: TightCoupling[];
  /** Monorepo-specific analysis (cross-package edges, encapsulation violations) */
  monorepoAnalysis?: MonorepoAnalysis;
  /** Change impact predictions for hub files (file -> top affected files with RRF scores) */
  changeImpact?: Map<string, Array<{ file: string; score: number }>>;
  /** Architectural fitness violations */
  archViolations?: ArchViolation[];
  /** Number of days used for git analysis window (default: 90) */
  analysisDays?: number;
}
