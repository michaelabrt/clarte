/**
 * GraphStore: synchronous SQLite-backed persistence for the clarte graph.
 *
 * All reads use prepared statements. All writes execute within transactions.
 * The constructor takes an already-initialized DatabaseAdapter (see loader.ts).
 */

import type { DatabaseAdapter, StatementAdapter } from "./db-adapter.js";
import type {
  FileRecord,
  SymbolRecord,
  FileEdgeRecord,
  SymbolEdgeRecord,
  CallSiteRecord,
  CommunityRecord,
  ChangeCouplingRecord,
  InMemoryFileGraph,
  InMemoryFileNode,
  InMemoryEdge,
  InMemorySymbolGraph,
  InMemorySymbolNode,
  InMemorySymEdge,
} from "./types.js";

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
}

interface SymEdgeRow {
  from_symbol_id: number;
  to_symbol_id: number;
  kind: string;
  line: number | null;
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

  // Write statements
  private readonly stmtUpsertFile: StatementAdapter;
  private readonly stmtUpsertSymbol: StatementAdapter;
  private readonly stmtSelectSymbolId: StatementAdapter;
  private readonly stmtUpsertFileEdge: StatementAdapter;
  private readonly stmtUpsertSymbolEdge: StatementAdapter;
  private readonly stmtInsertCallSite: StatementAdapter;
  private readonly stmtDeleteCallSitesByFile: StatementAdapter;
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
      SELECT id, file_path, name, kind, start_line, end_line, authority, body_hash, body_tokens
      FROM symbols
    `);

    this.stmtSelectSymEdges = db.prepare(`
      SELECT from_symbol_id, to_symbol_id, kind, line
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
        body_tokens, import_names
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      INSERT OR REPLACE INTO symbol_edges (from_symbol_id, to_symbol_id, kind, line)
      VALUES (?, ?, ?, ?)
    `);

    this.stmtInsertCallSite = db.prepare(`
      INSERT INTO call_sites (caller_file, caller_fn, callee_name, callee_file, line)
      VALUES (?, ?, ?, ?, ?)
    `);

    this.stmtDeleteCallSitesByFile = db.prepare(`
      DELETE FROM call_sites WHERE caller_file = ?
    `);

    // FTS5 delete via the 'delete' command
    this.stmtDeleteFtsByFile = db.prepare(`
      INSERT INTO fts_symbols(fts_symbols, rowid, file_path, name, body_tokens, import_names)
      SELECT 'delete', id, file_path, name, '', '' FROM symbols WHERE file_path = ?
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

    this.stmtFtsInsert = db.prepare(`
      INSERT INTO fts_symbols(rowid, file_path, name, body_tokens, import_names)
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
   * Get all stored file hashes.
   */
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
   * Also updates the FTS5 index.
   */
  upsertSymbols(symbols: SymbolRecord[]): number[] {
    const ids: number[] = [];

    const run = this.db.transaction(() => {
      for (const s of symbols) {
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
   */
  upsertSymbolEdges(edges: SymbolEdgeRecord[]): void {
    const run = this.db.transaction(() => {
      for (const e of edges) {
        this.stmtUpsertSymbolEdge.run(e.from_symbol_id, e.to_symbol_id, e.kind, e.line ?? null);
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
   * Also removes FTS5 index entries.
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
