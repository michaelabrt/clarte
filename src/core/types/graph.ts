import type { FileRole } from "./detection.js";

/** A single import edge in the project graph */
export interface ImportEdge {
  /** Source file (relative path) */
  from: string;
  /** Target file or package (relative path or bare specifier) */
  to: string;
  /** Whether this is an external package import */
  isExternal: boolean;
  /** Raw import specifier as written in source */
  specifier: string;
  /** Named imports (e.g. ['useState', 'useEffect']) */
  importedNames: string[];
  /** Whether this is a type-only import (import type { ... }) */
  isTypeOnly?: boolean;
  /** Whether this is a dynamic import (import('...')) */
  isDynamic?: boolean;
  /** Whether this edge was created by barrel resolution (re-routed from a barrel file to the source) */
  isBarrelRouted?: boolean;
  /** Whether this edge crosses monorepo package boundaries */
  crossPackage?: boolean;
}

/** Full import graph for a project */
export interface ImportGraph {
  /** All import edges */
  edges: ImportEdge[];
  /** Number of files that import each file */
  inDegree: Map<string, number>;
  /** Number of direct (non-barrel-routed) importers per file */
  directInDegree?: Map<string, number>;
  /** Centrality scores (0-1) — set to HITS authority for backward compat */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
  /** HITS authority scores (0-1): how much a file is depended upon */
  authority: Map<string, number>;
  /** HITS hub scores (0-1): how much a file depends on others */
  hubScores: Map<string, number>;
  /** Files detected as barrel/index files (>50% re-export statements) */
  barrelFiles?: Set<string>;
  /** Approximate betweenness centrality scores (0-1) from sampled Brandes */
  betweennessScores?: Map<string, number>;
  /** All function/method/class names defined in each file, for BM25 symbol indexing */
  symbolNames?: Map<string, string[]>;
  /** Deduped body tokens per symbol per file, for symbol-level BM25 scoring */
  symbolBodyTokens?: Map<string, Map<string, string[]>>;
  /** 1-based start line per symbol per file, for navigation hints */
  symbolStartLines?: Map<string, Map<string, number>>;
  /** Intra-file caller→callee edges per file, for navigation chain display */
  intraFileCalls?: Map<string, Array<{ caller: string; callee: string }>>;
  /** Phase 2: unified file graph extraction results per file */
  fileGraphResults?: Map<string, import("../graph/symbol-types.js").FileGraphResult>;
}

/** A highly-connected file identified by HITS analysis */
export interface HubFile {
  /** Relative file path */
  path: string;
  /** Centrality score (0-1) — set to authority for backward compat */
  centrality: number;
  /** HITS authority score (0-1): how much this file is depended upon */
  authority: number;
  /** HITS hub score (0-1): how much this file orchestrates others */
  hubScore: number;
  /** Functional role derived from authority/hub balance */
  role: FileRole;
  /** Number of files that import this file */
  importedBy: number;
  /** Number of internal files this file imports */
  imports: number;
}

/** A detected circular dependency chain */
export interface CircularDependency {
  /** File paths forming the cycle */
  chain: string[];
  /** Severity 0-1: 0 = all type-only imports, 1 = all runtime imports */
  severity?: number;
  /** Suggestion for breaking the cycle (e.g. "Convert X -> Y to type-only import") */
  breakHint?: string;
}

/** Instability metric (Robert C. Martin) for a file */
export interface FileInstability {
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1. Uses raw weighted values (type-only edges contribute 0.3x). */
  instability: number;
}

/** A detected community/cluster of tightly-connected files */
export interface Community {
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

/** A directed edge between two architectural layers */
export interface LayerEdge {
  from: string;
  to: string;
}

/** A detected architectural layer (e.g. types, stores, hooks) */
export interface ArchitecturalLayer {
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}
