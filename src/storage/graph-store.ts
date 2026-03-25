/**
 * GraphStore: synchronous SQLite-backed persistence for the clarte graph.
 *
 * All reads use prepared statements. All writes execute within transactions.
 * The constructor takes an already-initialized DatabaseAdapter (see loader.ts).
 */

import type { DatabaseAdapter, StatementAdapter } from "./db-adapter";
import type {
  CallSiteRecord,
  ChangeCouplingRecord,
  CommunityRecord,
  EdgePriorRecord,
  FileEdgeRecord,
  FileRecord,
  InMemoryEdge,
  InMemoryFileGraph,
  InMemoryFileNode,
  InMemorySymbolGraph,
  InMemorySymbolNode,
  InMemorySymEdge,
  LeanEdge,
  LeanFileGraph,
  LeanFileNode,
  SymbolEdgeRecord,
  SymbolRecord,
} from "./types";

// ── Row types returned by SQL queries ─────────────────────────────────────────

interface SymbolRow {
  id: number;
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line: number | null;
  authority: number | null;
  body_hash: string | null;
  body_tokens: string | null;
  is_exported: number;
}

interface SymEdgeRow {
  from_symbol_id: number;
  to_symbol_id: number;
  kind: string;
  line: number | null;
  ordinal: number | null;
  confidence: number | null;
}

export interface CallSiteRow {
  id: number;
  caller_file: string;
  caller_fn: string | null;
  callee_name: string;
  callee_file: string | null;
  line: number;
}

interface MetaRow {
  value: string;
}

interface KvCacheRow {
  key: string;
  value: string;
  expires_at: number | null;
}

interface EdgePriorRow {
  from_path: string;
  to_path: string;
  alpha: number;
  beta: number;
}

interface HashRow {
  path: string;
  hash: string;
}

interface InsertIdRow {
  id: number;
}

interface CommunityRow {
  id: number;
  label: string | null;
  cohesion: number | null;
}

interface ChangeCouplingRow {
  file_a: string;
  file_b: string;
  co_changes: number;
  confidence: number;
  conf_ab: number | null;
  conf_ba: number | null;
  last_cochange_days: number | null;
}

// ── Positional column indices for raw queries ───────────────────────────────────
// Must match the SELECT column order in the corresponding prepared statements.

const FULL_FILE_COL = {
  PATH: 0,
  HASH: 1,
  ROLE: 2,
  AUTHORITY: 3,
  HUB_SCORE: 4,
  BETWEENNESS: 5,
  INSTABILITY: 6,
  COMMUNITY_ID: 7,
  LAYER: 8,
  IS_BARREL: 9,
  IS_DEAD: 10,
  IS_CHOKEPOINT: 11,
  SEPARATES_COMPONENTS: 12,
  IS_CROSS_CUTTING: 13,
  LAYER_SPREAD: 14,
  HAS_TESTS: 15,
  LAYERS: 16,
  TEST_FILES: 17,
  INTRA_FILE_CALLS: 18,
} as const;

const FULL_EDGE_COL = {
  FROM_PATH: 0,
  TO_PATH: 1,
  IMPORTED_NAMES: 2,
  IS_TYPE_ONLY: 3,
  IS_DYNAMIC: 4,
  IS_BARREL_ROUTED: 5,
  CROSS_PACKAGE: 6,
} as const;

const LEAN_FILE_COL = {
  PATH: 0,
  HASH: 1,
  AUTHORITY: 2,
  HUB_SCORE: 3,
  BETWEENNESS: 4,
  IS_BARREL: 5,
  IS_DEAD: 6,
  IS_CHOKEPOINT: 7,
  COMMUNITY_ID: 8,
} as const;

const LEAN_EDGE_COL = {
  FROM_PATH: 0,
  TO_PATH: 1,
  IS_TYPE_ONLY: 2,
  IS_DYNAMIC: 3,
  IS_BARREL_ROUTED: 4,
} as const;

// ── GraphStore class ───────────────────────────────────────────────────────────

export class GraphStore {
  private readonly db: DatabaseAdapter;

  // Read statements (row-based fallback + JSON-serialized fast path)
  private readonly stmtSelectFiles: StatementAdapter;
  private readonly stmtSelectEdges: StatementAdapter;
  private readonly stmtSelectFilesJson: StatementAdapter;
  private readonly stmtSelectEdgesJson: StatementAdapter;
  private readonly stmtSelectSymbols: StatementAdapter;
  private readonly stmtSelectSymEdges: StatementAdapter;
  private readonly stmtSelectCallSites: StatementAdapter;
  private readonly stmtSelectHashes: StatementAdapter;
  private readonly stmtGetMeta: StatementAdapter;
  private readonly stmtLoadCommunities: StatementAdapter;
  private readonly stmtLoadChangeCoupling: StatementAdapter;
  private readonly stmtLoadAllCallSites: StatementAdapter;

  // Lean (column-pruned) read statements
  private readonly stmtSelectFilesLean: StatementAdapter;
  private readonly stmtSelectEdgesLean: StatementAdapter;
  private readonly stmtSelectFilesLeanJson: StatementAdapter;
  private readonly stmtSelectEdgesLeanJson: StatementAdapter;

  // KV cache statements
  private readonly stmtGetCache: StatementAdapter;
  private readonly stmtSetCache: StatementAdapter;
  private readonly stmtDeleteCache: StatementAdapter;

  // Write statements
  private readonly stmtUpsertFile: StatementAdapter;
  private readonly stmtUpsertSymbol: StatementAdapter;
  private readonly stmtSelectSymbolId: StatementAdapter;
  private readonly stmtUpsertFileEdge: StatementAdapter;
  private readonly stmtUpsertSymbolEdge: StatementAdapter;
  private readonly stmtInsertCallSite: StatementAdapter;
  private readonly stmtDeleteCallSitesByFile: StatementAdapter;
  private readonly stmtDeleteFtsByRowid: StatementAdapter;
  private readonly stmtDeleteFtsByFile: StatementAdapter;
  private readonly stmtDeleteFile: StatementAdapter;
  private readonly stmtUpsertCommunity: StatementAdapter;
  private readonly stmtDeleteAllCommunities: StatementAdapter;
  private readonly stmtDeleteAllChangeCoupling: StatementAdapter;
  private readonly stmtUpsertChangeCoupling: StatementAdapter;
  private readonly stmtSetMeta: StatementAdapter;
  private readonly stmtFtsInsert: StatementAdapter;

  // Edge prior statements
  private readonly stmtLoadEdgePriors: StatementAdapter;
  private readonly stmtUpsertEdgePrior: StatementAdapter;
  private readonly stmtDeleteAllEdgePriors: StatementAdapter;

  constructor(db: DatabaseAdapter) {
    this.db = db;

    // ── Read statements ───────────────────────────────────────────────────────
    this.stmtSelectFiles = db.prepare(`
      SELECT path, hash, role, authority, hub_score, betweenness, instability,
             community_id, layer, is_barrel, is_dead, is_chokepoint,
             separates_components, is_cross_cutting, layer_spread, has_tests,
             layers, test_files, intra_file_calls
      FROM files
    `);

    this.stmtSelectEdges = db.prepare(`
      SELECT from_path, to_path, imported_names, is_type_only, is_dynamic,
             is_barrel_routed, cross_package
      FROM file_edges
    `);

    // JSON-serialized variants: SQLite builds one JSON string in C/WASM,
    // transferred as a single value, then parsed by V8's optimized JSON.parse.
    // Eliminates per-row WASM/JS boundary crossings in the sql.js adapter.
    this.stmtSelectFilesJson = db.prepare(`
      SELECT json_group_array(json_array(
        path, hash, role, authority, hub_score, betweenness, instability,
        community_id, layer, is_barrel, is_dead, is_chokepoint,
        separates_components, is_cross_cutting, layer_spread, has_tests,
        layers, test_files, intra_file_calls
      )) FROM files
    `);

    this.stmtSelectEdgesJson = db.prepare(`
      SELECT json_group_array(json_array(
        from_path, to_path, imported_names, is_type_only, is_dynamic,
        is_barrel_routed, cross_package
      )) FROM file_edges
    `);

    this.stmtSelectSymbols = db.prepare(`
      SELECT id, file_path, name, kind, start_line, end_line, authority,
             body_hash, body_tokens, is_exported
      FROM symbols
    `);

    this.stmtSelectSymEdges = db.prepare(`
      SELECT from_symbol_id, to_symbol_id, kind, line, ordinal, confidence
      FROM symbol_edges
    `);

    this.stmtSelectCallSites = db.prepare(`
      SELECT id, caller_file, caller_fn, callee_name, callee_file, line
      FROM call_sites WHERE caller_file = ?
    `);

    this.stmtSelectHashes = db.prepare(`
      SELECT path, hash FROM files
    `);

    this.stmtGetMeta = db.prepare(`
      SELECT value FROM meta WHERE key = ?
    `);

    this.stmtLoadCommunities = db.prepare(`
      SELECT id, label, cohesion FROM communities
    `);

    this.stmtLoadChangeCoupling = db.prepare(`
      SELECT file_a, file_b, co_changes, confidence, conf_ab, conf_ba, last_cochange_days FROM change_coupling
    `);

    this.stmtLoadAllCallSites = db.prepare(`
      SELECT id, caller_file, caller_fn, callee_name, callee_file, line FROM call_sites
    `);

    // ── Lean read statements (column-pruned for fast graph loading) ─────────────
    // Column order MUST match LEAN_FILE_COL / LEAN_EDGE_COL index constants below.
    this.stmtSelectFilesLean = db.prepare(`
      SELECT path, hash, authority, hub_score, betweenness,
             is_barrel, is_dead, is_chokepoint, community_id
      FROM files
    `);

    this.stmtSelectEdgesLean = db.prepare(`
      SELECT from_path, to_path, is_type_only, is_dynamic, is_barrel_routed
      FROM file_edges
    `);

    this.stmtSelectFilesLeanJson = db.prepare(`
      SELECT json_group_array(json_array(
        path, hash, authority, hub_score, betweenness,
        is_barrel, is_dead, is_chokepoint, community_id
      )) FROM files
    `);

    this.stmtSelectEdgesLeanJson = db.prepare(`
      SELECT json_group_array(json_array(
        from_path, to_path, is_type_only, is_dynamic, is_barrel_routed
      )) FROM file_edges
    `);

    // ── KV cache statements ───────────────────────────────────────────────────
    this.stmtGetCache = db.prepare(`
      SELECT value FROM kv_cache WHERE key = ? AND (expires_at IS NULL OR expires_at > ?)
    `);

    this.stmtSetCache = db.prepare(`
      INSERT OR REPLACE INTO kv_cache (key, value, expires_at) VALUES (?, ?, ?)
    `);

    this.stmtDeleteCache = db.prepare(`
      DELETE FROM kv_cache WHERE key = ?
    `);

    // ── Write statements ──────────────────────────────────────────────────────
    this.stmtUpsertFile = db.prepare(`
      INSERT INTO files (
        path, hash, role, authority, hub_score, betweenness, instability,
        community_id, layer, is_barrel, is_dead, is_chokepoint,
        separates_components, is_cross_cutting, layer_spread, has_tests,
        layers, test_files, intra_file_calls, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(path) DO UPDATE SET
        hash = CASE WHEN excluded.hash != '' THEN excluded.hash ELSE hash END,
        role = excluded.role,
        authority = excluded.authority,
        hub_score = excluded.hub_score,
        betweenness = excluded.betweenness,
        instability = excluded.instability,
        community_id = excluded.community_id,
        layer = excluded.layer,
        is_barrel = excluded.is_barrel,
        is_dead = excluded.is_dead,
        is_chokepoint = excluded.is_chokepoint,
        separates_components = excluded.separates_components,
        is_cross_cutting = excluded.is_cross_cutting,
        layer_spread = excluded.layer_spread,
        has_tests = excluded.has_tests,
        layers = excluded.layers,
        test_files = excluded.test_files,
        intra_file_calls = excluded.intra_file_calls,
        updated_at = excluded.updated_at
    `);

    this.stmtUpsertSymbol = db.prepare(`
      INSERT INTO symbols (
        file_path, name, kind, start_line, end_line, authority, body_hash,
        body_tokens, import_names, is_exported
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path, name, start_line) DO UPDATE SET
        kind = excluded.kind,
        end_line = COALESCE(excluded.end_line, end_line),
        authority = COALESCE(excluded.authority, authority),
        body_hash = COALESCE(excluded.body_hash, body_hash),
        body_tokens = COALESCE(excluded.body_tokens, body_tokens),
        import_names = COALESCE(excluded.import_names, import_names),
        is_exported = excluded.is_exported
    `);

    this.stmtSelectSymbolId = db.prepare(`
      SELECT id FROM symbols WHERE file_path = ? AND name = ? AND start_line = ?
    `);

    this.stmtUpsertFileEdge = db.prepare(`
      INSERT OR REPLACE INTO file_edges (
        from_path, to_path, imported_names, is_type_only, is_dynamic,
        is_barrel_routed, cross_package
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpsertSymbolEdge = db.prepare(`
      INSERT OR REPLACE INTO symbol_edges (
        from_symbol_id, to_symbol_id, kind, line, ordinal, confidence
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtInsertCallSite = db.prepare(`
      INSERT INTO call_sites (caller_file, caller_fn, callee_name, callee_file, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtDeleteCallSitesByFile = db.prepare(`
      DELETE FROM call_sites WHERE caller_file = ?
    `);

    // F20: Regular DELETE on standalone FTS5 table (no content-sync mismatch)
    this.stmtDeleteFtsByRowid = db.prepare(`
      DELETE FROM fts_symbols WHERE rowid = ?
    `);

    // F20: Delete all FTS entries for a file via symbol ID subquery
    this.stmtDeleteFtsByFile = db.prepare(`
      DELETE FROM fts_symbols WHERE rowid IN (SELECT id FROM symbols WHERE file_path = ?)
    `);

    this.stmtDeleteFile = db.prepare(`
      DELETE FROM files WHERE path = ?
    `);

    this.stmtUpsertCommunity = db.prepare(`
      INSERT OR REPLACE INTO communities (id, label, cohesion) VALUES (?, ?, ?)
    `);

    this.stmtDeleteAllCommunities = db.prepare(`
      DELETE FROM communities
    `);

    this.stmtDeleteAllChangeCoupling = db.prepare(`
      DELETE FROM change_coupling
    `);

    this.stmtUpsertChangeCoupling = db.prepare(`
      INSERT OR REPLACE INTO change_coupling (file_a, file_b, co_changes, confidence, conf_ab, conf_ba, last_cochange_days)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtSetMeta = db.prepare(`
      INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)
    `);

    // F1: FTS column is symbol_name, not name
    this.stmtFtsInsert = db.prepare(`
      INSERT INTO fts_symbols(rowid, file_path, symbol_name, body_tokens, import_names)
      VALUES (?, ?, ?, ?, ?)
    `);

    // ── Edge prior statements ────────────────────────────────────────────────
    this.stmtLoadEdgePriors = db.prepare(`
      SELECT from_path, to_path, alpha, beta FROM edge_priors
    `);

    this.stmtUpsertEdgePrior = db.prepare(`
      INSERT OR REPLACE INTO edge_priors (from_path, to_path, alpha, beta)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtDeleteAllEdgePriors = db.prepare(`
      DELETE FROM edge_priors
    `);
  }

  // ── Read interface ──────────────────────────────────────────────────────────

  /**
   * Load the complete file graph from SQLite.
   * Returns nodes + forward and reverse adjacency lists.
   * Target: <5ms for 10K files.
   */
  loadFileGraph(): InMemoryFileGraph {
    const t0 = process.env.CLARTE_DEBUG ? performance.now() : 0;

    // Fast path: use json_group_array to serialize in SQLite (C/WASM),
    // transfer as one string, parse with V8's optimized JSON.parse.
    // Falls back to row-by-row allRaw() if json functions are unavailable.
    let fileRows: unknown[][];
    let edgeRows: unknown[][];
    try {
      const fResult = this.stmtSelectFilesJson.get<{ [key: string]: string }>();
      const eResult = this.stmtSelectEdgesJson.get<{ [key: string]: string }>();
      const fJson = fResult ? Object.values(fResult)[0] : null;
      const eJson = eResult ? Object.values(eResult)[0] : null;
      fileRows = fJson ? (JSON.parse(fJson) as unknown[][]) : [];
      edgeRows = eJson ? (JSON.parse(eJson) as unknown[][]) : [];
    } catch {
      fileRows = this.stmtSelectFiles.allRaw();
      edgeRows = this.stmtSelectEdges.allRaw();
    }

    const F = FULL_FILE_COL;
    const nodes = new Map<string, InMemoryFileNode>();
    for (const r of fileRows) {
      const path = r[F.PATH] as string;
      // json_group_array encodes nested JSON columns as strings (double-encoded);
      // allRaw also returns them as strings. parseJsonArray handles both.
      nodes.set(path, {
        path,
        hash: r[F.HASH] as string,
        role: r[F.ROLE] as string | null,
        authority: (r[F.AUTHORITY] as number | null) ?? 0,
        hubScore: (r[F.HUB_SCORE] as number | null) ?? 0,
        betweenness: (r[F.BETWEENNESS] as number | null) ?? 0,
        instability: r[F.INSTABILITY] as number | null,
        communityId: r[F.COMMUNITY_ID] as number | null,
        layer: r[F.LAYER] as string | null,
        isBarrel: r[F.IS_BARREL] === 1,
        isDead: r[F.IS_DEAD] === 1,
        isChokepoint: r[F.IS_CHOKEPOINT] === 1,
        separatesComponents: (r[F.SEPARATES_COMPONENTS] as number) ?? 0,
        isCrossCutting: r[F.IS_CROSS_CUTTING] === 1,
        layerSpread: (r[F.LAYER_SPREAD] as number) ?? 0,
        hasTests: r[F.HAS_TESTS] === 1,
        layers: parseJsonArray(r[F.LAYERS] as string | null),
        testFiles: parseJsonArray(r[F.TEST_FILES] as string | null),
        intraFileCalls: parseIntraFileCalls(r[F.INTRA_FILE_CALLS] as string | null),
      });
    }

    const E = FULL_EDGE_COL;
    const forward = new Map<string, InMemoryEdge[]>();
    const reverse = new Map<string, InMemoryEdge[]>();

    for (const r of edgeRows) {
      const fromPath = r[E.FROM_PATH] as string;
      const toPath = r[E.TO_PATH] as string;
      const edge: InMemoryEdge = {
        fromPath,
        toPath,
        importedNames: parseJsonArray(r[E.IMPORTED_NAMES] as string | null),
        isTypeOnly: r[E.IS_TYPE_ONLY] === 1,
        isDynamic: r[E.IS_DYNAMIC] === 1,
        isBarrelRouted: r[E.IS_BARREL_ROUTED] === 1,
        crossPackage: r[E.CROSS_PACKAGE] === 1,
      };

      let fwd = forward.get(fromPath);
      if (!fwd) {
        fwd = [];
        forward.set(fromPath, fwd);
      }
      fwd.push(edge);

      let rev = reverse.get(toPath);
      if (!rev) {
        rev = [];
        reverse.set(toPath, rev);
      }
      rev.push(edge);
    }

    if (process.env.CLARTE_DEBUG) {
      const elapsed = performance.now() - t0;
      process.stderr.write(
        `[clarte:perf] loadFileGraph: ${elapsed.toFixed(2)}ms (${nodes.size} files, ${edgeRows.length} edges)\n`,
      );
    }

    return { nodes, forward, reverse };
  }

  /**
   * Fast-loading file graph using column pruning and raw positional arrays.
   *
   * Skips: role, instability, layer, separatesComponents, isCrossCutting,
   * layerSpread, hasTests, layers, testFiles, intraFileCalls, importedNames,
   * crossPackage. No JSON.parse calls.
   *
   * Returns a LeanFileGraph (not assignable to InMemoryFileGraph) to prevent
   * accidental use where full node data is needed.
   */
  loadFileGraphLean(): LeanFileGraph {
    const t0 = process.env.CLARTE_DEBUG ? performance.now() : 0;

    let fileRows: unknown[][];
    let edgeRows: unknown[][];
    try {
      const fResult = this.stmtSelectFilesLeanJson.get<{ [key: string]: string }>();
      const eResult = this.stmtSelectEdgesLeanJson.get<{ [key: string]: string }>();
      const fJson = fResult ? Object.values(fResult)[0] : null;
      const eJson = eResult ? Object.values(eResult)[0] : null;
      fileRows = fJson ? (JSON.parse(fJson) as unknown[][]) : [];
      edgeRows = eJson ? (JSON.parse(eJson) as unknown[][]) : [];
    } catch {
      fileRows = this.stmtSelectFilesLean.allRaw();
      edgeRows = this.stmtSelectEdgesLean.allRaw();
    }

    const nodes = new Map<string, LeanFileNode>();
    for (const row of fileRows) {
      const path = row[LEAN_FILE_COL.PATH] as string;
      nodes.set(path, {
        path,
        hash: row[LEAN_FILE_COL.HASH] as string,
        authority: (row[LEAN_FILE_COL.AUTHORITY] as number | null) ?? 0,
        hubScore: (row[LEAN_FILE_COL.HUB_SCORE] as number | null) ?? 0,
        betweenness: (row[LEAN_FILE_COL.BETWEENNESS] as number | null) ?? 0,
        isBarrel: row[LEAN_FILE_COL.IS_BARREL] === 1,
        isDead: row[LEAN_FILE_COL.IS_DEAD] === 1,
        isChokepoint: row[LEAN_FILE_COL.IS_CHOKEPOINT] === 1,
        communityId: row[LEAN_FILE_COL.COMMUNITY_ID] as number | null,
      });
    }

    // Direct edge construction: build adjacency lists inline, no intermediate objects
    const forward = new Map<string, LeanEdge[]>();
    const reverse = new Map<string, LeanEdge[]>();

    for (const row of edgeRows) {
      const fromPath = row[LEAN_EDGE_COL.FROM_PATH] as string;
      const toPath = row[LEAN_EDGE_COL.TO_PATH] as string;
      const edge: LeanEdge = {
        fromPath,
        toPath,
        isTypeOnly: row[LEAN_EDGE_COL.IS_TYPE_ONLY] === 1,
        isDynamic: row[LEAN_EDGE_COL.IS_DYNAMIC] === 1,
        isBarrelRouted: row[LEAN_EDGE_COL.IS_BARREL_ROUTED] === 1,
      };

      let fwd = forward.get(fromPath);
      if (!fwd) {
        fwd = [];
        forward.set(fromPath, fwd);
      }
      fwd.push(edge);

      let rev = reverse.get(toPath);
      if (!rev) {
        rev = [];
        reverse.set(toPath, rev);
      }
      rev.push(edge);
    }

    if (process.env.CLARTE_DEBUG) {
      const elapsed = performance.now() - t0;
      process.stderr.write(
        `[clarte:perf] loadFileGraphLean: ${elapsed.toFixed(2)}ms (${nodes.size} files, ${edgeRows.length} edges)\n`,
      );
    }

    return { nodes, forward, reverse };
  }

  /**
   * Load the complete symbol graph from SQLite.
   */
  loadSymbolGraph(): InMemorySymbolGraph {
    const symbolRows = this.stmtSelectSymbols.all<SymbolRow>();
    const symEdgeRows = this.stmtSelectSymEdges.all<SymEdgeRow>();

    const symbols = new Map<number, InMemorySymbolNode>();
    const byFile = new Map<string, number[]>();

    for (const row of symbolRows) {
      const node: InMemorySymbolNode = {
        id: row.id,
        filePath: row.file_path,
        name: row.name,
        kind: row.kind,
        startLine: row.start_line,
        endLine: row.end_line,
        authority: row.authority,
        bodyHash: row.body_hash,
        bodyTokens: row.body_tokens,
        isExported: row.is_exported === 1,
      };
      symbols.set(row.id, node);

      let ids = byFile.get(row.file_path);
      if (!ids) {
        ids = [];
        byFile.set(row.file_path, ids);
      }
      ids.push(row.id);
    }

    const forward = new Map<number, InMemorySymEdge[]>();
    const reverse = new Map<number, InMemorySymEdge[]>();

    for (const row of symEdgeRows) {
      const edge: InMemorySymEdge = {
        fromSymbolId: row.from_symbol_id,
        toSymbolId: row.to_symbol_id,
        kind: row.kind,
        line: row.line,
        ordinal: row.ordinal,
        confidence: row.confidence,
      };

      let fwd = forward.get(row.from_symbol_id);
      if (!fwd) {
        fwd = [];
        forward.set(row.from_symbol_id, fwd);
      }
      fwd.push(edge);

      let rev = reverse.get(row.to_symbol_id);
      if (!rev) {
        rev = [];
        reverse.set(row.to_symbol_id, rev);
      }
      rev.push(edge);
    }

    return { symbols, forward, reverse, byFile };
  }

  /**
   * Load call sites for a specific caller file.
   */
  loadCallSites(file: string): CallSiteRow[] {
    return this.stmtSelectCallSites.all<CallSiteRow>(file);
  }

  /**
   * Load all call sites (for full graph reconstruction).
   */
  loadAllCallSites(): CallSiteRow[] {
    return this.stmtLoadAllCallSites.all<CallSiteRow>();
  }

  /**
   * Compare current file hashes against stored hashes.
   * Returns paths that are new, changed, or deleted.
   */
  getStaleFiles(currentHashes: Map<string, string>): string[] {
    const dbRows = this.stmtSelectHashes.all<HashRow>();
    const dbHashes = new Map<string, string>();
    for (const row of dbRows) {
      dbHashes.set(row.path, row.hash);
    }

    const stale: string[] = [];

    for (const [path, hash] of currentHashes) {
      const stored = dbHashes.get(path);
      if (stored === undefined || stored !== hash) {
        stale.push(path);
      }
    }

    for (const path of dbHashes.keys()) {
      if (!currentHashes.has(path)) {
        stale.push(path);
      }
    }

    return stale;
  }

  /**
   * Get all stored file hashes, excluding stub files (hash="").
   */
  getAllHashes(): Map<string, string> {
    const rows = this.stmtSelectHashes.all<HashRow>();
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.hash !== "") map.set(row.path, row.hash);
    }
    return map;
  }

  /**
   * Read a value from the meta table.
   */
  getMeta(key: string): string | undefined {
    const row = this.stmtGetMeta.get<MetaRow>(key);
    return row?.value;
  }

  /**
   * Load all communities.
   */
  loadCommunities(): CommunityRow[] {
    return this.stmtLoadCommunities.all<CommunityRow>();
  }

  /**
   * Load all change coupling records.
   */
  loadChangeCoupling(): ChangeCouplingRow[] {
    return this.stmtLoadChangeCoupling.all<ChangeCouplingRow>();
  }

  // ── KV cache interface ──────────────────────────────────────────────────────

  /**
   * Read a value from the kv_cache table.
   * Returns undefined if the key does not exist or has expired.
   */
  getCache(key: string): string | undefined {
    const now = Math.floor(Date.now() / 1000);
    const row = this.stmtGetCache.get<KvCacheRow>(key, now);
    return row?.value;
  }

  /**
   * Write a value to the kv_cache table.
   * Optional expiresAt is a Unix timestamp (seconds).
   */
  setCache(key: string, value: string, expiresAt?: number): void {
    this.stmtSetCache.run(key, value, expiresAt ?? null);
  }

  /**
   * Delete a key from the kv_cache table.
   */
  deleteCache(key: string): void {
    this.stmtDeleteCache.run(key);
  }

  // ── Write interface ─────────────────────────────────────────────────────────

  /**
   * Upsert file records in a single transaction.
   */
  upsertFiles(files: FileRecord[]): void {
    const now = new Date().toISOString();
    const run = this.db.transaction(() => {
      for (const f of files) {
        this.stmtUpsertFile.run(
          f.path,
          f.hash,
          f.role ?? null,
          f.authority ?? null,
          f.hub_score ?? null,
          f.betweenness ?? null,
          f.instability ?? null,
          f.community_id ?? null,
          f.layer ?? null,
          f.is_barrel ?? 0,
          f.is_dead ?? 0,
          f.is_chokepoint ?? 0,
          f.separates_components ?? 0,
          f.is_cross_cutting ?? 0,
          f.layer_spread ?? 0,
          f.has_tests ?? 0,
          f.layers ?? null,
          f.test_files ?? null,
          f.intra_file_calls ?? null,
          f.updated_at || now,
        );
      }
    });
    run();
  }

  /**
   * Upsert symbol records. Returns inserted row IDs.
   * F21: Deletes old FTS entries before re-inserting to prevent index bloat.
   * F3: Persists is_exported.
   */
  upsertSymbols(symbols: SymbolRecord[]): number[] {
    const ids: number[] = [];

    const run = this.db.transaction(() => {
      for (const s of symbols) {
        // F21: Delete old FTS entry before upsert (prevents duplicates).
        // INSERT OR REPLACE deletes the old row (triggering a new AUTOINCREMENT id),
        // so the old FTS entry would become orphaned without this cleanup.
        const existingRow = this.stmtSelectSymbolId.get<InsertIdRow>(s.file_path, s.name, s.start_line);
        if (existingRow?.id) {
          try {
            this.stmtDeleteFtsByRowid.run(existingRow.id);
          } catch {
            // FTS5 not available
          }
        }

        // F3: Persist is_exported (10th parameter)
        this.stmtUpsertSymbol.run(
          s.file_path,
          s.name,
          s.kind,
          s.start_line,
          s.end_line ?? null,
          s.authority ?? null,
          s.body_hash ?? null,
          s.body_tokens ?? null,
          s.import_names ?? null,
          s.is_exported ?? 0,
        );

        const idRow = this.stmtSelectSymbolId.get<InsertIdRow>(s.file_path, s.name, s.start_line);
        const id = idRow?.id ?? 0;
        ids.push(id);

        if (id > 0) {
          try {
            this.stmtFtsInsert.run(id, s.file_path, s.name, s.body_tokens ?? "", s.import_names ?? "");
          } catch {
            // FTS5 not available
          }
        }
      }
    });
    run();

    return ids;
  }

  /**
   * Upsert file-level import edges.
   */
  upsertFileEdges(edges: FileEdgeRecord[]): void {
    const run = this.db.transaction(() => {
      for (const e of edges) {
        this.stmtUpsertFileEdge.run(
          e.from_path,
          e.to_path,
          e.imported_names ? JSON.stringify(e.imported_names) : null,
          e.is_type_only ?? 0,
          e.is_dynamic ?? 0,
          e.is_barrel_routed ?? 0,
          e.cross_package ?? 0,
        );
      }
    });
    run();
  }

  /**
   * Upsert symbol-level dependency edges.
   * F19: Persists confidence.
   */
  upsertSymbolEdges(edges: SymbolEdgeRecord[]): void {
    const run = this.db.transaction(() => {
      for (const e of edges) {
        this.stmtUpsertSymbolEdge.run(
          e.from_symbol_id,
          e.to_symbol_id,
          e.kind,
          e.line ?? null,
          e.ordinal ?? null,
          e.confidence ?? null,
        );
      }
    });
    run();
  }

  /**
   * Insert call sites, deleting and re-inserting per caller file.
   */
  upsertCallSites(sites: CallSiteRecord[]): void {
    if (sites.length === 0) return;

    const byFile = new Map<string, CallSiteRecord[]>();
    for (const s of sites) {
      let arr = byFile.get(s.caller_file);
      if (!arr) {
        arr = [];
        byFile.set(s.caller_file, arr);
      }
      arr.push(s);
    }

    const run = this.db.transaction(() => {
      for (const [callerFile, fileSites] of byFile) {
        this.stmtDeleteCallSitesByFile.run(callerFile);
        for (const s of fileSites) {
          this.stmtInsertCallSite.run(s.caller_file, s.caller_fn ?? null, s.callee_name, s.callee_file ?? null, s.line);
        }
      }
    });
    run();
  }

  /**
   * Replace all community records.
   */
  upsertCommunities(communities: CommunityRecord[]): void {
    const run = this.db.transaction(() => {
      this.stmtDeleteAllCommunities.run();
      for (const c of communities) {
        this.stmtUpsertCommunity.run(c.id, c.label ?? null, c.cohesion ?? null);
      }
    });
    run();
  }

  /**
   * Replace all change-coupling records.
   */
  upsertChangeCoupling(couplings: ChangeCouplingRecord[]): void {
    const run = this.db.transaction(() => {
      this.stmtDeleteAllChangeCoupling.run();
      for (const c of couplings) {
        this.stmtUpsertChangeCoupling.run(
          c.file_a,
          c.file_b,
          c.co_changes,
          c.confidence,
          c.conf_ab ?? null,
          c.conf_ba ?? null,
          c.last_cochange_days ?? null,
        );
      }
    });
    run();
  }

  // ── Edge prior interface ────────────────────────────────────────────────────

  /**
   * Load all Bayesian edge priors.
   */
  loadEdgePriors(): EdgePriorRow[] {
    return this.stmtLoadEdgePriors.all<EdgePriorRow>();
  }

  /**
   * Replace all edge priors in a single transaction.
   */
  upsertEdgePriors(priors: EdgePriorRecord[]): void {
    const run = this.db.transaction(() => {
      this.stmtDeleteAllEdgePriors.run();
      for (const p of priors) {
        this.stmtUpsertEdgePrior.run(p.from_path, p.to_path, p.alpha, p.beta);
      }
    });
    run();
  }

  /**
   * Delete a file and cascade to its symbols, edges and call sites.
   * F20: Removes FTS5 entries via regular DELETE (no content-sync mismatch).
   */
  deleteFile(filePath: string): void {
    const run = this.db.transaction(() => {
      try {
        this.stmtDeleteFtsByFile.run(filePath);
      } catch {
        // FTS5 not available
      }
      this.stmtDeleteFile.run(filePath);
    });
    run();
  }

  /**
   * Delete multiple files in a single transaction.
   */
  deleteFiles(paths: string[]): void {
    if (paths.length === 0) return;
    const run = this.db.transaction(() => {
      for (const p of paths) {
        try {
          this.stmtDeleteFtsByFile.run(p);
        } catch {
          // FTS5 not available
        }
        this.stmtDeleteFile.run(p);
      }
    });
    run();
  }

  /**
   * Set a meta key-value pair.
   */
  setMeta(key: string, value: string): void {
    this.stmtSetMeta.run(key, value);
  }

  /**
   * Compute and store BM25F corpus statistics for the symbols table.
   * Writes three meta keys: bm25f_avg_field_lengths, bm25f_doc_count, bm25f_doc_freqs.
   *
   * F10: Field lengths are token counts (via tokenizeBm25f / space-split),
   * not raw character LENGTH().
   */
  refreshBm25fStats(): void {
    interface CountRow {
      count: number;
    }
    interface SymbolTokenRow {
      file_path: string;
      name: string;
      body_tokens: string | null;
      import_names: string | null;
    }

    const countRow = this.db.prepare("SELECT COUNT(*) as count FROM symbols").get<CountRow>();
    const docCount = countRow?.count ?? 0;
    this.stmtSetMeta.run("bm25f_doc_count", String(docCount));

    const symbolRows = this.db
      .prepare("SELECT file_path, name, body_tokens, import_names FROM symbols")
      .all<SymbolTokenRow>();

    // F10: Compute average field lengths as token counts, not character lengths.
    // tokenizeBm25f splits on camelCase/separators matching BM25F query tokenization.
    // body_tokens are already space-separated; count terms directly.
    // import_names is a JSON array; count elements as tokens.
    let totalFilePathTokens = 0;
    let totalNameTokens = 0;
    let totalBodyTokens = 0;
    let totalImportTokens = 0;

    const df = new Map<string, number>();

    for (const row of symbolRows) {
      const fpTokens = tokenizeBm25f(row.file_path);
      const nameTokens = tokenizeBm25f(row.name);
      const bodyTokens = row.body_tokens ? row.body_tokens.split(/\s+/).filter((t) => t.length > 1) : [];
      const importTokenCount = countJsonArrayElements(row.import_names);

      totalFilePathTokens += fpTokens.length;
      totalNameTokens += nameTokens.length;
      totalBodyTokens += bodyTokens.length;
      totalImportTokens += importTokenCount;

      // Document frequency: unique terms per document
      const terms = new Set<string>([...fpTokens, ...nameTokens, ...bodyTokens]);
      for (const term of terms) {
        df.set(term, (df.get(term) ?? 0) + 1);
      }
    }

    this.stmtSetMeta.run(
      "bm25f_avg_field_lengths",
      JSON.stringify({
        file_path: docCount > 0 ? totalFilePathTokens / docCount : 0,
        symbol_name: docCount > 0 ? totalNameTokens / docCount : 0,
        body_tokens: docCount > 0 ? totalBodyTokens / docCount : 0,
        import_names: docCount > 0 ? totalImportTokens / docCount : 0,
      }),
    );

    const filteredDf = new Map<string, number>();
    for (const [term, count] of df) {
      if (count >= 2) filteredDf.set(term, count);
    }

    this.stmtSetMeta.run("bm25f_doc_freqs", JSON.stringify(Object.fromEntries(filteredDf)));
  }

  // ── Blame + LSA persistence ──────────────────────────────────────────────

  /**
   * Store per-symbol blame data keyed by commit hash.
   */
  storeSymbolBlame(commitHash: string, blame: Map<number, number>): void {
    const obj: Record<string, number> = {};
    for (const [id, days] of blame) obj[String(id)] = Math.round(days * 100) / 100;
    this.setCache(`blame_${commitHash}`, JSON.stringify(obj));
  }

  /**
   * Load per-symbol blame data for a commit hash.
   */
  loadSymbolBlame(commitHash: string): Map<number, number> | null {
    const raw = this.getCache(`blame_${commitHash}`);
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Record<string, number>;
      const result = new Map<number, number>();
      for (const [id, days] of Object.entries(obj)) result.set(Number(id), days);
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Store LSA file embeddings.
   */
  storeLSAEmbeddings(embeddings: Map<string, Float64Array>): void {
    const obj: Record<string, number[]> = {};
    for (const [file, emb] of embeddings) obj[file] = Array.from(emb);
    this.setCache("lsa_embeddings", JSON.stringify(obj));
  }

  /**
   * Load LSA file embeddings.
   */
  loadLSAEmbeddings(): Map<string, Float64Array> | null {
    const raw = this.getCache("lsa_embeddings");
    if (!raw) return null;
    try {
      const obj = JSON.parse(raw) as Record<string, number[]>;
      const result = new Map<string, Float64Array>();
      for (const [file, arr] of Object.entries(obj)) result.set(file, new Float64Array(arr));
      return result;
    } catch {
      return null;
    }
  }

  /**
   * Run a function within a transaction.
   */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  /**
   * Close the database connection.
   */
  close(): void {
    this.db.close();
  }
}

// ── JSON helpers ────────────────────────────────────────────────────────────────

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value || value.length < 3) return []; // null, "", "[]"
  // Fast path: values are always well-formed JSON string arrays written by this codebase.
  // Splitting '["a","b"]' directly is ~10x faster than JSON.parse for short arrays.
  return value.slice(2, -2).split('","');
}

function parseIntraFileCalls(value: string | null | undefined): Array<[string, string]> {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as Array<[string, string]>) : [];
  } catch {
    return [];
  }
}

function tokenizeBm25f(text: string): string[] {
  return text
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(/[_\-./:@\\]/)
    .join(" ")
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Count elements in a JSON array string (e.g., '["foo","bar"]' -> 2).
 * Each import name is roughly one token for BM25F field length purposes.
 */
function countJsonArrayElements(value: string | null | undefined): number {
  if (!value) return 0;
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}
