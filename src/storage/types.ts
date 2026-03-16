/**
 * Record types for SQLite I/O and in-memory graph representations.
 * These are the data transfer objects between the database and the rest of the codebase.
 */

// ── SQLite insert/update record types ─────────────────────────────────────────

export interface FileRecord {
  path: string;
  hash: string;
  role?: string | null;
  authority?: number | null;
  hub_score?: number | null;
  betweenness?: number | null;
  instability?: number | null;
  community_id?: number | null;
  layer?: string | null;
  is_barrel?: number;
  is_dead?: number;
  is_chokepoint?: number;
  // Phase 1 compatibility columns (for PersistedGraph reconstruction)
  separates_components?: number;
  is_cross_cutting?: number;
  layer_spread?: number;
  has_tests?: number;
  layers?: string | null;
  test_files?: string | null;
  intra_file_calls?: string | null;
  updated_at: string;
}

export interface SymbolRecord {
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line?: number | null;
  authority?: number | null;
  body_hash?: string | null;
  /** Raw token string for FTS5 content-sync (space-joined body tokens) */
  body_tokens?: string | null;
  /** JSON array of import names for FTS5 content-sync */
  import_names?: string | null;
  /** Whether this symbol is exported from its file (F3) */
  is_exported?: number;
}

export interface FileEdgeRecord {
  from_path: string;
  to_path: string;
  imported_names?: string[];
  is_type_only?: number;
  is_dynamic?: number;
  is_barrel_routed?: number;
  cross_package?: number;
}

export interface SymbolEdgeRecord {
  from_symbol_id: number;
  to_symbol_id: number;
  kind: string;
  line?: number | null;
  ordinal?: number | null;
  /** Resolution confidence tier (F19) */
  confidence?: number | null;
}

export interface CallSiteRecord {
  caller_file: string;
  caller_fn?: string | null;
  callee_name: string;
  callee_file?: string | null;
  line: number;
}

export interface CommunityRecord {
  id: number;
  label?: string | null;
  cohesion?: number | null;
}

export interface ChangeCouplingRecord {
  file_a: string;
  file_b: string;
  co_changes: number;
  confidence: number;
  conf_ab?: number | null;
  conf_ba?: number | null;
}

// ── In-memory graph types (what GraphStore.loadFileGraph() returns) ───────────

export interface InMemoryFileNode {
  path: string;
  hash: string;
  role?: string | null;
  authority: number;
  hubScore: number;
  betweenness: number;
  instability?: number | null;
  communityId?: number | null;
  layer?: string | null;
  isBarrel: boolean;
  isDead: boolean;
  isChokepoint: boolean;
  // Phase 1 compatibility
  separatesComponents: number;
  isCrossCutting: boolean;
  layerSpread: number;
  hasTests: boolean;
  layers: string[];
  testFiles: string[];
  intraFileCalls: Array<[string, string]>;
}

export interface InMemoryEdge {
  fromPath: string;
  toPath: string;
  importedNames: string[];
  isTypeOnly: boolean;
  isDynamic: boolean;
  isBarrelRouted: boolean;
  crossPackage: boolean;
}

export interface InMemoryFileGraph {
  nodes: Map<string, InMemoryFileNode>;
  forward: Map<string, InMemoryEdge[]>;
  reverse: Map<string, InMemoryEdge[]>;
}

// ── In-memory symbol graph ─────────────────────────────────────────────────────

export interface InMemorySymbolNode {
  id: number;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
  endLine?: number | null;
  authority?: number | null;
  bodyHash?: string | null;
  bodyTokens?: string | null;
  isExported: boolean;
}

export interface InMemorySymEdge {
  fromSymbolId: number;
  toSymbolId: number;
  kind: string;
  line?: number | null;
  ordinal?: number | null;
  confidence?: number | null;
}

export interface InMemorySymbolGraph {
  symbols: Map<number, InMemorySymbolNode>;
  forward: Map<number, InMemorySymEdge[]>;
  reverse: Map<number, InMemorySymEdge[]>;
  byFile: Map<string, number[]>;
}
