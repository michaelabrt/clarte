import { describe, it, expect } from "vitest";
import {
  createDatabase,
  createDatabaseWithTiers,
  _bunSqliteTier,
  _sqlJsTier,
  type TierLoader,
} from "../../storage/db-adapter";
import { initSchema } from "../../storage/schema";

const nullTier: TierLoader = async () => null;

const workingTier: TierLoader = async (dbPath) => {
  return createDatabase(dbPath);
};

// ── createDatabaseWithTiers fallback chain ─────────────────────────────────────

describe("createDatabaseWithTiers", () => {
  it("falls through to second tier when first returns null", async () => {
    const db = await createDatabaseWithTiers(":memory:", [nullTier, workingTier]);
    expect(db).toBeDefined();
    db.exec("CREATE TABLE t (x INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(42);
    const row = db.prepare("SELECT x FROM t").get<{ x: number }>();
    expect(row?.x).toBe(42);
    db.close();
  });

  it("falls through to third tier when first two return null", async () => {
    const db = await createDatabaseWithTiers(":memory:", [nullTier, nullTier, workingTier]);
    expect(db).toBeDefined();
    db.close();
  });

  it("throws descriptive error listing all three tiers when none succeed", async () => {
    await expect(createDatabaseWithTiers(":memory:", [nullTier, nullTier, nullTier])).rejects.toThrow(
      /better-sqlite3.*bun:sqlite.*sql\.js/,
    );
  });
});

// ── Tier 2: bun:sqlite ─────────────────────────────────────────────────────────

describe("bun:sqlite tier (AC 1.1.4)", () => {
  it("produces a working DatabaseAdapter when available", async () => {
    const db = await _bunSqliteTier(":memory:");
    if (!db) {
      // bun:sqlite not available in this runtime - skip
      return;
    }
    db.exec("CREATE TABLE t (x INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(99);
    const row = db.prepare("SELECT x FROM t").get<{ x: number }>();
    expect(row?.x).toBe(99);
    db.close();
  });

  it("bun:sqlite adapter supports transactions", async () => {
    const db = await _bunSqliteTier(":memory:");
    if (!db) return;
    db.exec("CREATE TABLE t (x INTEGER)");
    const txn = db.transaction(() => {
      db.prepare("INSERT INTO t VALUES (?)").run(1);
      db.prepare("INSERT INTO t VALUES (?)").run(2);
    });
    txn();
    const count = db.prepare("SELECT COUNT(*) as c FROM t").get<{ c: number }>();
    expect(count?.c).toBe(2);
    db.close();
  });
});

// ── Tier 3: sql.js ─────────────────────────────────────────────────────────────

describe("sql.js tier (AC 1.1.5)", () => {
  it("produces a working DatabaseAdapter when available", async () => {
    const db = await _sqlJsTier(":memory:");
    if (!db) {
      // sql.js is optional - skip if not installed
      return;
    }
    db.exec("CREATE TABLE t (x INTEGER)");
    db.prepare("INSERT INTO t VALUES (?)").run(7);
    const row = db.prepare("SELECT x FROM t").get<{ x: number }>();
    expect(row?.x).toBe(7);
    db.close();
  });
});

// ── createDatabase smoke test ──────────────────────────────────────────────────

describe("createDatabase (:memory:)", () => {
  it("creates a working in-memory database", async () => {
    const db = await createDatabase(":memory:");
    initSchema(db);
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("test", "value");
    const row = db.prepare("SELECT value FROM meta WHERE key = ?").get<{ value: string }>("test");
    expect(row?.value).toBe("value");
    db.close();
  });
});
