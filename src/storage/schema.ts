/**
 * SQLite schema DDL for the clarte graph database.
 * All tables, indexes, virtual tables and pragmas defined here.
 *
 * Schema version: 3
 *   v1 -> v2: added symbols.is_exported, symbol_edges.confidence,
 *             FTS5 column rename (name -> symbol_name), dropped content-sync.
 *   v2 -> v3: added kv_cache table, removed dead vec_symbols virtual table.
 */

import type { DatabaseAdapter } from "./db-adapter.js";

export const SCHEMA_VERSION = "3";

/**
 * Initialize the database schema within a single transaction.
 * Idempotent: safe to call on an existing database.
 * Sets WAL mode and foreign keys before creating tables.
 *
 * Throws if the database was created by a newer version of clarte.
 */
export function initSchema(db: DatabaseAdapter): void {
  // Pragmas must be set outside a transaction
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA synchronous = NORMAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA cache_size = -64000");

  // Check schema version before applying DDL
  const currentVersion = getSchemaVersion(db);

  const createAll = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS files (
        path                  TEXT    PRIMARY KEY,
        hash                  TEXT    NOT NULL,
        role                  TEXT,
        authority             REAL,
        hub_score             REAL,
        betweenness           REAL,
        instability           REAL,
        community_id          INTEGER,
        layer                 TEXT,
        is_barrel             INTEGER DEFAULT 0,
        is_dead               INTEGER DEFAULT 0,
        is_chokepoint         INTEGER DEFAULT 0,
        -- Phase 1 compatibility columns
        separates_components  INTEGER DEFAULT 0,
        is_cross_cutting      INTEGER DEFAULT 0,
        layer_spread          INTEGER DEFAULT 0,
        has_tests             INTEGER DEFAULT 0,
        layers                TEXT,
        test_files            TEXT,
        intra_file_calls      TEXT,
        updated_at            TEXT    NOT NULL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS symbols (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path    TEXT    NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        name         TEXT    NOT NULL,
        kind         TEXT    NOT NULL,
        start_line   INTEGER NOT NULL,
        end_line     INTEGER,
        authority    REAL,
        body_hash    TEXT,
        -- Stored here for FTS5 and steer module reconstruction
        body_tokens  TEXT,
        import_names TEXT,
        is_exported  INTEGER DEFAULT 0,
        UNIQUE(file_path, name, start_line)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_file ON symbols(file_path)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS file_edges (
        from_path         TEXT    NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        to_path           TEXT    NOT NULL REFERENCES files(path) ON DELETE CASCADE,
        imported_names    TEXT,
        is_type_only      INTEGER DEFAULT 0,
        is_dynamic        INTEGER DEFAULT 0,
        is_barrel_routed  INTEGER DEFAULT 0,
        cross_package     INTEGER DEFAULT 0,
        PRIMARY KEY (from_path, to_path)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_file_edges_to ON file_edges(to_path)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_edges (
        from_symbol_id  INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        to_symbol_id    INTEGER NOT NULL REFERENCES symbols(id) ON DELETE CASCADE,
        kind            TEXT    NOT NULL,
        line            INTEGER,
        ordinal         INTEGER,
        confidence      REAL,
        PRIMARY KEY (from_symbol_id, to_symbol_id, kind)
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_sym_edges_to ON symbol_edges(to_symbol_id)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_files_community ON files(community_id)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS call_sites (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        caller_file  TEXT    NOT NULL,
        caller_fn    TEXT,
        callee_name  TEXT    NOT NULL,
        callee_file  TEXT,
        line         INTEGER NOT NULL,
        FOREIGN KEY (caller_file) REFERENCES files(path) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_callee ON call_sites(callee_file, callee_name)`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_calls_caller ON call_sites(caller_file)`);

    db.exec(`
      CREATE TABLE IF NOT EXISTS communities (
        id       INTEGER PRIMARY KEY,
        label    TEXT,
        cohesion REAL
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS change_coupling (
        file_a      TEXT    NOT NULL,
        file_b      TEXT    NOT NULL,
        co_changes  INTEGER NOT NULL,
        confidence  REAL    NOT NULL,
        conf_ab     REAL,
        conf_ba     REAL,
        PRIMARY KEY (file_a, file_b)
      )
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key   TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // FTS5 virtual table for symbol full-text search.
    // Standalone (no content-sync) so column names are independent of the symbols table.
    tryCreateFts5(db);

    // Regular table for embedding BLOB storage (always available, no extensions needed).
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_embeddings (
        symbol_id INTEGER PRIMARY KEY REFERENCES symbols(id) ON DELETE CASCADE,
        embedding BLOB NOT NULL,
        body_hash TEXT
      )
    `);

    // General-purpose key-value cache (replaces project-cache.json, git-cache.json, history.json).
    db.exec(`
      CREATE TABLE IF NOT EXISTS kv_cache (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        expires_at INTEGER
      )
    `);

    // Write schema version on first creation (OR IGNORE keeps existing value)
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
    db.exec(`INSERT OR IGNORE INTO meta (key, value) VALUES ('created_at', '${new Date().toISOString()}')`);
  });

  createAll();

  // Migrate existing databases forward
  if (currentVersion === 1) {
    migrateV1toV2(db);
    migrateV2toV3(db);
  } else if (currentVersion === 2) {
    migrateV2toV3(db);
  }
}

/**
 * Read the current schema version from the meta table.
 * Returns undefined for a fresh database with no meta table.
 * Throws if the database was created by a newer version of clarte.
 */
function getSchemaVersion(db: DatabaseAdapter): number | undefined {
  try {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>();
    if (!row) return undefined;

    const dbVersion = parseInt(row.value, 10);
    const codeVersion = parseInt(SCHEMA_VERSION, 10);

    if (dbVersion > codeVersion) {
      throw new Error(
        `Database was created by a newer version of clarte (schema v${dbVersion}). ` +
          `This installation supports schema v${SCHEMA_VERSION}. Upgrade clarte to open this database.`,
      );
    }

    return dbVersion;
  } catch (err) {
    const msg = (err as Error).message;
    // "no such table: meta" means fresh DB - that's fine
    if (msg.includes("no such table")) return undefined;
    throw err;
  }
}

/**
 * Migrate a v1 database to v2:
 * - Add symbols.is_exported column
 * - Add symbol_edges.confidence column
 * - Recreate FTS5 table (column rename name -> symbol_name, drop content-sync)
 * - Repopulate FTS from existing symbols
 */
function migrateV1toV2(db: DatabaseAdapter): void {
  tryAddColumn(db, "symbols", "is_exported INTEGER DEFAULT 0");
  tryAddColumn(db, "symbol_edges", "confidence REAL");

  // Recreate FTS5: drop old content-sync table, create standalone with renamed column
  try {
    db.exec("DROP TABLE IF EXISTS fts_symbols");
  } catch {
    // FTS5 not available or table didn't exist
  }
  tryCreateFts5(db);

  // Repopulate FTS from existing symbols
  try {
    db.exec(`
      INSERT INTO fts_symbols(rowid, file_path, symbol_name, body_tokens, import_names)
      SELECT id, file_path, name, COALESCE(body_tokens, ''), COALESCE(import_names, '')
      FROM symbols
    `);
  } catch {
    // FTS5 not available
  }

  // Stamp the new version
  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
}

function tryAddColumn(db: DatabaseAdapter, table: string, columnDef: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDef}`);
  } catch {
    // Column already exists (fresh DB) or other issue - safe to ignore
  }
}

/**
 * Migrate a v2 database to v3:
 * - Add kv_cache table
 */
function migrateV2toV3(db: DatabaseAdapter): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kv_cache (
      key        TEXT PRIMARY KEY,
      value      TEXT NOT NULL,
      expires_at INTEGER
    )
  `);

  db.exec(`INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '${SCHEMA_VERSION}')`);
}

function tryCreateFts5(db: DatabaseAdapter): void {
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_symbols USING fts5(
        file_path,
        symbol_name,
        body_tokens,
        import_names,
        tokenize='porter unicode61'
      )
    `);
  } catch {
    // FTS5 may not be available in all SQLite builds - skip gracefully
    process.stderr.write("[clarte] FTS5 not available: symbol full-text search disabled\n");
  }
}
