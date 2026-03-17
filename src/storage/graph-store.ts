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

interface FileRow {
  path: string;
  hash: string;
  role: string | null;
  authority: number | null;
  hub_score: number | null;
  betweenness: number | null;
  instability: number | null;
  community_id: number | null;
  layer: string | null;
  is_barrel: number;
  is_dead: number;
  is_chokepoint: number;
  separates_components: number;
  is_cross_cutting: number;
  layer_spread: number;
  has_tests: number;
  layers: string | null;
  test_files: string | null;
  intra_file_calls: string | null;
}

interface EdgeRow {
  from_path: string;
  to_path: string;
  imported_names: string | null;
  is_type_only: number;
  is_dynamic: number;
  is_barrel_routed: number;
  cross_package: number;
}

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
}

// ── GraphStore class ───────────────────────────────────────────────────────────

export class GraphStore {
  private readonly db: DatabaseAdapter;

  // Read statements
  private readonly stmtSelectFiles: StatementAdapter;
  private readonly stmtSelectEdges: StatementAdapter;
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
      SELECT file_a, file_b, co_changes, confidence, conf_ab, conf_ba FROM change_coupling
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
      INSERT OR REPLACE INTO files (
        path, hash, role, authority, hub_score, betweenness, instability,
        community_id, layer, is_barrel, is_dead, is_chokepoint,
        separates_components, is_cross_cutting, layer_spread, has_tests,
        layers, test_files, intra_file_calls, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.stmtUpsertSymbol = db.prepare(`
      INSERT OR REPLACE INTO symbols (
        file_path, name, kind, start_line, end_line, authority, body_hash,
        body_tokens, import_names, is_exported
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      INSERT OR REPLACE INTO change_coupling (file_a, file_b, co_changes, confidence, conf_ab, conf_ba)
      VALUES (?, ?, ?, ?, ?, ?)
    `);

    this.stmtSetMeta = db.prepare(`
      INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)
    `);

    // F1: FTS column is symbol_name (RFC-aligned), not name
    this.stmtFtsInsert = db.prepare(`
      INSERT INTO fts_symbols(rowid, file_path, symbol_name, body_tokens, import_names)
      VALUES (?, ?, ?, ?, ?)
    `);
  }

  // ── Read interface ──────────────────────────────────────────────────────────

  /**
   * Load the complete file graph from SQLite.
   * Returns nodes + forward and reverse adjacency lists.
   * Target: <5ms for 10K files.
   */
  loadFileGraph(): InMemoryFileGraph {
    const fileRows = this.stmtSelectFiles.all<FileRow>();
    const edgeRows = this.stmtSelectEdges.all<EdgeRow>();

    const nodes = new Map<string, InMemoryFileNode>();
    for (const row of fileRows) {
      nodes.set(row.path, fileRowToNode(row));
    }

    const forward = new Map<string, InMemoryEdge[]>();
    const reverse = new Map<string, InMemoryEdge[]>();

    for (const row of edgeRows) {
      const edge = edgeRowToEdge(row);

      let fwd = forward.get(row.from_path);
      if (!fwd) {
        fwd = [];
        forward.set(row.from_path, fwd);
      }
      fwd.push(edge);

      let rev = reverse.get(row.to_path);
      if (!rev) {
        rev = [];
        reverse.set(row.to_path, rev);
      }
      rev.push(edge);
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

    const fileRows = this.stmtSelectFilesLean.allRaw();
    const edgeRows = this.stmtSelectEdgesLean.allRaw();

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
        );
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

// ── Positional column indices for lean raw queries ──────────────────────────────
// Must match the SELECT column order in stmtSelectFilesLean / stmtSelectEdgesLean.

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

// ── Row-to-node converters ─────────────────────────────────────────────────────

function fileRowToNode(row: FileRow): InMemoryFileNode {
  return {
    path: row.path,
    hash: row.hash,
    role: row.role,
    authority: row.authority ?? 0,
    hubScore: row.hub_score ?? 0,
    betweenness: row.betweenness ?? 0,
    instability: row.instability,
    communityId: row.community_id,
    layer: row.layer,
    isBarrel: row.is_barrel === 1,
    isDead: row.is_dead === 1,
    isChokepoint: row.is_chokepoint === 1,
    separatesComponents: row.separates_components ?? 0,
    isCrossCutting: row.is_cross_cutting === 1,
    layerSpread: row.layer_spread ?? 0,
    hasTests: row.has_tests === 1,
    layers: parseJsonArray(row.layers),
    testFiles: parseJsonArray(row.test_files),
    intraFileCalls: parseIntraFileCalls(row.intra_file_calls),
  };
}

function edgeRowToEdge(row: EdgeRow): InMemoryEdge {
  return {
    fromPath: row.from_path,
    toPath: row.to_path,
    importedNames: parseJsonArray(row.imported_names),
    isTypeOnly: row.is_type_only === 1,
    isDynamic: row.is_dynamic === 1,
    isBarrelRouted: row.is_barrel_routed === 1,
    crossPackage: row.cross_package === 1,
  };
}

function parseJsonArray(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? (parsed as string[]) : [];
  } catch {
    return [];
  }
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
