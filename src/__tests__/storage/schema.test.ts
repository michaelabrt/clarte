import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase } from "../../storage/db-adapter.js";
import { initSchema, SCHEMA_VERSION } from "../../storage/schema.js";
import type { DatabaseAdapter } from "../../storage/db-adapter.js";

describe("initSchema", () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    initSchema(db);
  });

  it("creates all 8 core tables", () => {
    const rows = db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all<{ name: string }>();
    const names = rows.map((r) => r.name);
    expect(names).toContain("files");
    expect(names).toContain("symbols");
    expect(names).toContain("file_edges");
    expect(names).toContain("symbol_edges");
    expect(names).toContain("call_sites");
    expect(names).toContain("communities");
    expect(names).toContain("change_coupling");
    expect(names).toContain("meta");
  });

  it("creates all 7 named indexes", () => {
    const rows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'")
      .all<{ name: string }>();
    const names = rows.map((r) => r.name);
    expect(names).toContain("idx_symbols_file");
    expect(names).toContain("idx_symbols_name");
    expect(names).toContain("idx_file_edges_to");
    expect(names).toContain("idx_sym_edges_to");
    expect(names).toContain("idx_calls_callee");
    expect(names).toContain("idx_calls_caller");
    expect(names).toContain("idx_files_community");
    expect(names.length).toBe(7);
  });

  it("is idempotent - calling twice does not throw", () => {
    expect(() => initSchema(db)).not.toThrow();
  });

  it("sets PRAGMA foreign_keys = ON", () => {
    const row = db.prepare("PRAGMA foreign_keys").get<{ foreign_keys: number }>();
    expect(row?.foreign_keys).toBe(1);
  });

  it("sets PRAGMA journal_mode = wal (or memory for :memory: DBs)", () => {
    const row = db.prepare("PRAGMA journal_mode").get<{ journal_mode: string }>();
    // :memory: databases report "memory" - WAL is only meaningful for file-based DBs
    expect(["wal", "memory"]).toContain(row?.journal_mode);
  });

  it("writes schema_version into meta", () => {
    const row = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get<{ value: string }>();
    expect(row?.value).toBe(SCHEMA_VERSION);
  });

  it("throws when stored schema_version is newer than current", () => {
    db.exec("UPDATE meta SET value = '999' WHERE key = 'schema_version'");
    expect(() => initSchema(db)).toThrow(/newer version/);
  });

  it("rejects FK violation: symbol with non-existent file_path", () => {
    expect(() => {
      db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
        "nonexistent.ts",
        "foo",
        "function",
        1,
      );
    }).toThrow();
  });

  it("cascades delete from files to symbols", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("a.ts", "abc", now);
    db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
      "a.ts",
      "foo",
      "function",
      1,
    );
    expect(db.prepare("SELECT COUNT(*) as c FROM symbols").get<{ c: number }>()?.c).toBe(1);
    db.prepare("DELETE FROM files WHERE path = ?").run("a.ts");
    expect(db.prepare("SELECT COUNT(*) as c FROM symbols").get<{ c: number }>()?.c).toBe(0);
  });

  it("enforces UNIQUE(file_path, name, start_line) on symbols", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("a.ts", "abc", now);
    db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
      "a.ts",
      "foo",
      "function",
      1,
    );
    expect(() => {
      db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
        "a.ts",
        "foo",
        "function",
        1,
      );
    }).toThrow();
  });

  it("allows same symbol pair in symbol_edges with different kind", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("a.ts", "abc", now);
    db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
      "a.ts",
      "foo",
      "function",
      1,
    );
    db.prepare("INSERT INTO symbols (file_path, name, kind, start_line) VALUES (?, ?, ?, ?)").run(
      "a.ts",
      "bar",
      "function",
      2,
    );
    const fooId = db.prepare("SELECT id FROM symbols WHERE name = 'foo'").get<{ id: number }>()?.id ?? 0;
    const barId = db.prepare("SELECT id FROM symbols WHERE name = 'bar'").get<{ id: number }>()?.id ?? 0;
    db.prepare("INSERT INTO symbol_edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, ?)").run(
      fooId,
      barId,
      "calls",
    );
    db.prepare("INSERT INTO symbol_edges (from_symbol_id, to_symbol_id, kind) VALUES (?, ?, ?)").run(
      fooId,
      barId,
      "imports",
    );
    const c = db.prepare("SELECT COUNT(*) as c FROM symbol_edges").get<{ c: number }>()?.c;
    expect(c).toBe(2);
  });

  it("cascades delete from files to file_edges", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("a.ts", "abc", now);
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("b.ts", "def", now);
    db.prepare("INSERT INTO file_edges (from_path, to_path) VALUES (?, ?)").run("a.ts", "b.ts");
    expect(db.prepare("SELECT COUNT(*) as c FROM file_edges").get<{ c: number }>()?.c).toBe(1);
    db.prepare("DELETE FROM files WHERE path = ?").run("a.ts");
    expect(db.prepare("SELECT COUNT(*) as c FROM file_edges").get<{ c: number }>()?.c).toBe(0);
  });

  it("cascades delete from files to call_sites", () => {
    const now = new Date().toISOString();
    db.prepare("INSERT INTO files (path, hash, updated_at) VALUES (?, ?, ?)").run("a.ts", "abc", now);
    db.prepare("INSERT INTO call_sites (caller_file, callee_name, line) VALUES (?, ?, ?)").run(
      "a.ts",
      "doSomething",
      10,
    );
    expect(db.prepare("SELECT COUNT(*) as c FROM call_sites").get<{ c: number }>()?.c).toBe(1);
    db.prepare("DELETE FROM files WHERE path = ?").run("a.ts");
    expect(db.prepare("SELECT COUNT(*) as c FROM call_sites").get<{ c: number }>()?.c).toBe(0);
  });
});
