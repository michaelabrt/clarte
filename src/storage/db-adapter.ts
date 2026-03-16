/**
 * Synchronous SQLite database adapter with 3-tier fallback chain:
 *   Tier 1: better-sqlite3 (native, fastest, prebuilt binaries for major platforms)
 *   Tier 2: bun:sqlite (zero-dependency, Bun-only)
 *   Tier 3: sql.js (WASM, works everywhere)
 *
 * All database operations are synchronous once a connection is established.
 * Only `createDatabase()` is async (one-time startup cost).
 */

// ── Unified adapter interface ──────────────────────────────────────────────────

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface StatementAdapter {
  run(...params: unknown[]): RunResult;
  get<T = Record<string, unknown>>(...params: unknown[]): T | undefined;
  all<T = Record<string, unknown>>(...params: unknown[]): T[];
}

export interface DatabaseAdapter {
  prepare(sql: string): StatementAdapter;
  exec(sql: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

// ── Shared structural type for both better-sqlite3 and bun:sqlite ─────────────

type DatabaseLike = {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
  close: () => void;
};

// ── Tier 1: better-sqlite3 adapter ────────────────────────────────────────────

function wrapBetterSqlite3(db: {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
  close: () => void;
}): DatabaseAdapter {
  return {
    prepare(sql: string): StatementAdapter {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): RunResult {
          return stmt.run(...params) as RunResult;
        },
        get<T>(...params: unknown[]): T | undefined {
          return stmt.get(...params) as T | undefined;
        },
        all<T>(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
      };
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn);
    },
    close(): void {
      db.close();
    },
  };
}

// ── Tier 2: bun:sqlite adapter ────────────────────────────────────────────────

function wrapBunSqlite(db: {
  prepare: (sql: string) => {
    run: (...params: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
    get: (...params: unknown[]) => unknown | null;
    all: (...params: unknown[]) => unknown[];
  };
  exec: (sql: string) => void;
  transaction: <T>(fn: () => T) => () => T;
  close: () => void;
}): DatabaseAdapter {
  return {
    prepare(sql: string): StatementAdapter {
      const stmt = db.prepare(sql);
      return {
        run(...params: unknown[]): RunResult {
          return stmt.run(...params) as RunResult;
        },
        get<T>(...params: unknown[]): T | undefined {
          const result = stmt.get(...params);
          // bun:sqlite returns null instead of undefined on no-match
          return (result === null ? undefined : result) as T | undefined;
        },
        all<T>(...params: unknown[]): T[] {
          return stmt.all(...params) as T[];
        },
      };
    },
    exec(sql: string): void {
      db.exec(sql);
    },
    transaction<T>(fn: () => T): () => T {
      return db.transaction(fn);
    },
    close(): void {
      db.close();
    },
  };
}

// ── Tier 3: sql.js adapter ────────────────────────────────────────────────────

interface SqlJsDatabase {
  run(sql: string, params?: unknown[]): void;
  prepare(sql: string): {
    bind: (params: unknown[]) => boolean;
    step: () => boolean;
    getAsObject: (params?: unknown) => Record<string, unknown>;
    reset: () => void;
    free: () => void;
    run: (params?: unknown[]) => void;
  };
  exec(sql: string): Array<{ columns: string[]; values: unknown[][] }>;
  export(): Uint8Array;
  close(): void;
}

function wrapSqlJs(db: SqlJsDatabase, dbPath: string): DatabaseAdapter {
  // sql.js needs explicit file saves after writes
  let pendingWrites = false;
  const stmtCache = new Map<string, ReturnType<SqlJsDatabase["prepare"]>>();

  const getOrPrepare = (sql: string): ReturnType<SqlJsDatabase["prepare"]> => {
    let stmt = stmtCache.get(sql);
    if (!stmt) {
      stmt = db.prepare(sql);
      stmtCache.set(sql, stmt);
    }
    return stmt;
  };

  const saveToFile = (): void => {
    if (!pendingWrites || dbPath === ":memory:") return;
    try {
      const { writeFileSync } = await_require("node:fs");
      writeFileSync(dbPath, Buffer.from(db.export()));
      pendingWrites = false;
    } catch {
      // non-fatal: in-memory state is still correct
    }
  };

  function await_require(mod: string): { writeFileSync: (path: string, data: Buffer) => void } {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require(mod) as { writeFileSync: (path: string, data: Buffer) => void };
  }

  function execStatements(sql: string): void {
    db.run(sql);
    pendingWrites = true;
  }

  const makeStatement = (sql: string): StatementAdapter => ({
    run(...params: unknown[]): RunResult {
      let lastInsertRowid = 0;
      let changes = 0;
      try {
        const stmt = getOrPrepare(sql);
        stmt.reset();
        stmt.run(params);
        const result = db.exec("SELECT last_insert_rowid(), changes()");
        if (result[0]) {
          lastInsertRowid = (result[0].values[0]?.[0] as number) ?? 0;
          changes = (result[0].values[0]?.[1] as number) ?? 0;
        }
        pendingWrites = true;
      } catch {
        // ignore
      }
      return { changes, lastInsertRowid };
    },
    get<T>(...params: unknown[]): T | undefined {
      try {
        const stmt = getOrPrepare(sql);
        stmt.reset();
        stmt.bind(params);
        if (stmt.step()) {
          const row = stmt.getAsObject() as T;
          return row;
        }
        return undefined;
      } catch {
        return undefined;
      }
    },
    all<T>(...params: unknown[]): T[] {
      const rows: T[] = [];
      try {
        const stmt = getOrPrepare(sql);
        stmt.reset();
        stmt.bind(params);
        while (stmt.step()) {
          rows.push(stmt.getAsObject() as T);
        }
      } catch {
        // ignore
      }
      return rows;
    },
  });

  return {
    prepare(sql: string): StatementAdapter {
      return makeStatement(sql);
    },
    exec(sql: string): void {
      execStatements(sql);
      saveToFile();
    },
    transaction<T>(fn: () => T): () => T {
      return (): T => {
        db.run("BEGIN");
        try {
          const result = fn();
          db.run("COMMIT");
          pendingWrites = true;
          saveToFile();
          return result;
        } catch (err) {
          db.run("ROLLBACK");
          throw err;
        }
      };
    },
    close(): void {
      saveToFile();
      for (const stmt of stmtCache.values()) {
        try {
          stmt.free();
        } catch {
          // ignore
        }
      }
      stmtCache.clear();
      db.close();
    },
  };
}

// ── Factory function ───────────────────────────────────────────────────────────

/** @internal - for testing only */
export type TierLoader = (dbPath: string) => Promise<DatabaseAdapter | null>;

/** @internal - for testing only */
export async function createDatabaseWithTiers(dbPath: string, tiers: TierLoader[]): Promise<DatabaseAdapter> {
  for (const tier of tiers) {
    const db = await tier(dbPath);
    if (db) return db;
  }
  throw new Error(
    "Could not load SQLite binding. Attempted: better-sqlite3, bun:sqlite, sql.js. " +
      "Install better-sqlite3 (npm install better-sqlite3) or run under Bun.",
  );
}

const tier1Loader: TierLoader = async (dbPath) => {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const BetterSqlite3 = req("better-sqlite3") as new (path: string) => DatabaseLike;
    const db = new BetterSqlite3(dbPath);
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] using better-sqlite3\n");
    return wrapBetterSqlite3(db);
  } catch {
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] better-sqlite3 unavailable, trying bun:sqlite\n");
    return null;
  }
};

/** @internal - for testing: directly exercises the bun:sqlite binding */
export const _bunSqliteTier: TierLoader = async (dbPath) => {
  try {
    // Dynamic import prevents bundlers from tree-shaking or failing on non-Bun
    const mod = (await import("bun:sqlite" as never as string)) as { Database: new (path: string) => DatabaseLike };
    const db = new mod.Database(dbPath);
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] using bun:sqlite\n");
    return wrapBunSqlite(db);
  } catch {
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] bun:sqlite unavailable, trying sql.js\n");
    return null;
  }
};

/** @internal - for testing: directly exercises the sql.js WASM binding */
export const _sqlJsTier: TierLoader = async (dbPath) => {
  try {
    const sqlJsMod = (await import("sql.js" as never as string)) as {
      default?: (opts: {
        locateFile: (f: string) => string;
      }) => Promise<{ Database: new (data?: Buffer) => SqlJsDatabase }>;
      (opts: { locateFile: (f: string) => string }): Promise<{ Database: new (data?: Buffer) => SqlJsDatabase }>;
    };
    const initSqlJs = sqlJsMod.default ?? sqlJsMod;

    // Load existing database file or start fresh (for :memory: always start fresh)
    let initData: Buffer | undefined;
    if (dbPath !== ":memory:") {
      try {
        const { readFileSync } = await import("node:fs");
        initData = readFileSync(dbPath);
      } catch {
        // File doesn't exist yet - create fresh
      }
    }

    // Resolve WASM file path relative to the sql.js package dist directory.
    // Bare `locateFile: (f) => f` fails because it looks in CWD, not the package dir.
    const sqlPkgUrl = import.meta.resolve("sql.js");
    const sqlDistDir = new URL(".", sqlPkgUrl).pathname;
    const SQL = await initSqlJs({ locateFile: (file: string) => `${sqlDistDir}${file}` });
    const db: SqlJsDatabase = initData ? new SQL.Database(initData) : new SQL.Database();
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] using sql.js (WASM)\n");
    return wrapSqlJs(db, dbPath);
  } catch {
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] sql.js unavailable\n");
    return null;
  }
};

/**
 * Create a synchronous SQLite database connection.
 * Tries each binding tier in order and returns the first that succeeds.
 * Logs which tier was selected at debug level (CLARTE_DEBUG=1).
 */
export async function createDatabase(dbPath: string): Promise<DatabaseAdapter> {
  return createDatabaseWithTiers(dbPath, [tier1Loader, _bunSqliteTier, _sqlJsTier]);
}

// ── Read-only factory (F.5: for MCP server) ──────────────────────────────────

const readonlyTier1Loader: TierLoader = async (dbPath) => {
  try {
    const { createRequire } = await import("node:module");
    const req = createRequire(import.meta.url);
    const BetterSqlite3 = req("better-sqlite3") as new (path: string, options?: { readonly?: boolean }) => DatabaseLike;
    const db = new BetterSqlite3(dbPath, { readonly: true });
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] using better-sqlite3 (read-only)\n");
    return wrapBetterSqlite3(db);
  } catch {
    return null;
  }
};

const readonlyBunTier: TierLoader = async (dbPath) => {
  try {
    const mod = (await import("bun:sqlite" as never as string)) as {
      Database: new (path: string, options?: { readonly?: boolean }) => DatabaseLike;
    };
    const db = new mod.Database(dbPath, { readonly: true });
    if (process.env.CLARTE_DEBUG) process.stderr.write("[clarte:db] using bun:sqlite (read-only)\n");
    return wrapBunSqlite(db);
  } catch {
    return null;
  }
};

/**
 * Create a read-only SQLite database connection.
 * Used by the MCP server to prevent accidental writes and avoid WAL lock contention
 * with the main clarte indexer process.
 */
export async function createReadonlyDatabase(dbPath: string): Promise<DatabaseAdapter> {
  return createDatabaseWithTiers(dbPath, [readonlyTier1Loader, readonlyBunTier, _sqlJsTier]);
}
