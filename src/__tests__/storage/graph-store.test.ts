import { describe, it, expect, beforeEach } from "vitest";
import { createDatabase } from "../../storage/db-adapter.js";
import { initSchema } from "../../storage/schema.js";
import { GraphStore } from "../../storage/graph-store.js";
import type { DatabaseAdapter } from "../../storage/db-adapter.js";
import type { FileRecord } from "../../storage/types.js";

const NOW = new Date().toISOString();

function makeFile(path: string, hash = "abc"): FileRecord {
  return { path, hash, updated_at: NOW };
}

describe("GraphStore smoke test", () => {
  it("can create DB, insert a file, and read it back", async () => {
    const db = await createDatabase(":memory:");
    initSchema(db);
    const store = new GraphStore(db);
    store.upsertFiles([makeFile("src/index.ts", "abc123")]);
    const graph = store.loadFileGraph();
    expect(graph.nodes.size).toBe(1);
    expect(graph.nodes.get("src/index.ts")?.hash).toBe("abc123");
    db.close();
  });
});

describe("GraphStore read interface", () => {
  let db: DatabaseAdapter;
  let store: GraphStore;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    initSchema(db);
    store = new GraphStore(db);
  });

  it("loadFileGraph returns correct node and edge counts", () => {
    store.upsertFiles([makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")]);
    store.upsertFileEdges([
      { from_path: "a.ts", to_path: "b.ts" },
      { from_path: "a.ts", to_path: "c.ts" },
    ]);
    const g = store.loadFileGraph();
    expect(g.nodes.size).toBe(3);
    expect(g.forward.get("a.ts")?.length).toBe(2);
  });

  it("loadFileGraph builds both forward and reverse adjacency lists", () => {
    store.upsertFiles([makeFile("a.ts"), makeFile("b.ts")]);
    store.upsertFileEdges([{ from_path: "a.ts", to_path: "b.ts" }]);
    const g = store.loadFileGraph();
    expect(g.forward.get("a.ts")?.[0].toPath).toBe("b.ts");
    expect(g.reverse.get("b.ts")?.[0].fromPath).toBe("a.ts");
  });

  it("imported_names round-trips correctly", () => {
    store.upsertFiles([makeFile("a.ts"), makeFile("b.ts")]);
    store.upsertFileEdges([
      { from_path: "a.ts", to_path: "b.ts", imported_names: ["foo", "bar"] },
    ]);
    const g = store.loadFileGraph();
    expect(g.forward.get("a.ts")?.[0].importedNames).toEqual(["foo", "bar"]);
  });

  it("loadSymbolGraph populates byFile index", () => {
    store.upsertFiles([makeFile("a.ts")]);
    store.upsertSymbols([
      { file_path: "a.ts", name: "foo", kind: "function", start_line: 1 },
      { file_path: "a.ts", name: "bar", kind: "function", start_line: 5 },
    ]);
    const sg = store.loadSymbolGraph();
    const ids = sg.byFile.get("a.ts");
    expect(ids?.length).toBe(2);
  });

  it("loadCallSites returns only records for the requested file", () => {
    store.upsertFiles([makeFile("caller.ts"), makeFile("other.ts")]);
    store.upsertCallSites([
      { caller_file: "caller.ts", callee_name: "doWork", line: 10 },
      { caller_file: "other.ts", callee_name: "doOther", line: 5 },
    ]);
    const sites = store.loadCallSites("caller.ts");
    expect(sites.length).toBe(1);
    expect(sites[0].callee_name).toBe("doWork");
  });

  it("getStaleFiles identifies new files", () => {
    store.upsertFiles([makeFile("a.ts", "hash1")]);
    const current = new Map([
      ["a.ts", "hash1"],
      ["b.ts", "hash2"],
    ]);
    const stale = store.getStaleFiles(current);
    expect(stale).toContain("b.ts");
  });

  it("getStaleFiles identifies changed files", () => {
    store.upsertFiles([makeFile("a.ts", "hash1")]);
    const current = new Map([["a.ts", "hash_changed"]]);
    const stale = store.getStaleFiles(current);
    expect(stale).toContain("a.ts");
  });

  it("getStaleFiles identifies deleted files", () => {
    store.upsertFiles([makeFile("a.ts", "hash1"), makeFile("b.ts", "hash2")]);
    const current = new Map([["a.ts", "hash1"]]); // b.ts deleted
    const stale = store.getStaleFiles(current);
    expect(stale).toContain("b.ts");
  });

  it("getMeta returns stored value", () => {
    store.setMeta("foo", "bar");
    expect(store.getMeta("foo")).toBe("bar");
  });

  it("getMeta returns undefined for missing key", () => {
    expect(store.getMeta("nonexistent")).toBeUndefined();
  });
});

describe("GraphStore write interface", () => {
  let db: DatabaseAdapter;
  let store: GraphStore;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    initSchema(db);
    store = new GraphStore(db);
  });

  it("upsertFiles inserts N rows on first call", () => {
    store.upsertFiles([makeFile("a.ts"), makeFile("b.ts"), makeFile("c.ts")]);
    const g = store.loadFileGraph();
    expect(g.nodes.size).toBe(3);
  });

  it("upsertFiles updates (not duplicates) on second call with same path", () => {
    store.upsertFiles([makeFile("a.ts", "hash1")]);
    store.upsertFiles([makeFile("a.ts", "hash2")]);
    const g = store.loadFileGraph();
    expect(g.nodes.size).toBe(1);
    expect(g.nodes.get("a.ts")?.hash).toBe("hash2");
  });

  it("upsertSymbols returns correct row IDs", () => {
    store.upsertFiles([makeFile("a.ts")]);
    const ids = store.upsertSymbols([
      { file_path: "a.ts", name: "foo", kind: "function", start_line: 1 },
      { file_path: "a.ts", name: "bar", kind: "function", start_line: 5 },
    ]);
    expect(ids.length).toBe(2);
    expect(ids[0]).toBeGreaterThan(0);
    expect(ids[1]).toBeGreaterThan(0);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it("deleteFile cascades to symbols", () => {
    store.upsertFiles([makeFile("a.ts")]);
    store.upsertSymbols([{ file_path: "a.ts", name: "foo", kind: "function", start_line: 1 }]);
    store.deleteFile("a.ts");
    const sg = store.loadSymbolGraph();
    expect(sg.symbols.size).toBe(0);
  });

  it("deleteFile cascades to file_edges (from_path)", () => {
    store.upsertFiles([makeFile("a.ts"), makeFile("b.ts")]);
    store.upsertFileEdges([{ from_path: "a.ts", to_path: "b.ts" }]);
    store.deleteFile("a.ts");
    const g = store.loadFileGraph();
    expect(g.forward.size).toBe(0);
  });

  it("deleteFile cascades to call_sites", () => {
    store.upsertFiles([makeFile("a.ts")]);
    store.upsertCallSites([{ caller_file: "a.ts", callee_name: "fn", line: 1 }]);
    store.deleteFile("a.ts");
    expect(store.loadAllCallSites().length).toBe(0);
  });

  it("transaction rolls back on error", () => {
    store.upsertFiles([makeFile("a.ts")]);
    try {
      store.transaction(() => {
        store.upsertFiles([makeFile("b.ts")]);
        throw new Error("intentional rollback");
      });
    } catch {
      // expected
    }
    const g = store.loadFileGraph();
    // b.ts should not be present (rolled back)
    expect(g.nodes.has("b.ts")).toBe(false);
  });
});

describe("GraphStore FTS5", () => {
  let db: DatabaseAdapter;
  let store: GraphStore;
  let ftsAvailable: boolean;

  beforeEach(async () => {
    db = await createDatabase(":memory:");
    initSchema(db);
    store = new GraphStore(db);
    // Check if FTS5 was created
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='fts_symbols'")
      .get<{ name: string }>();
    ftsAvailable = !!row;
  });

  it("FTS5 index is populated when symbol is inserted", () => {
    if (!ftsAvailable) return;
    store.upsertFiles([{ path: "src/auth/session.ts", hash: "abc", updated_at: NOW }]);
    store.upsertSymbols([
      {
        file_path: "src/auth/session.ts",
        name: "validateSession",
        kind: "function",
        start_line: 1,
        body_tokens: "validate session token user",
      },
    ]);
    const rows = db
      .prepare("SELECT rowid FROM fts_symbols WHERE fts_symbols MATCH 'validateSession'")
      .all<{ rowid: number }>();
    expect(rows.length).toBeGreaterThan(0);
  });

  it("FTS5 entries are removed when file is deleted", () => {
    if (!ftsAvailable) return;
    store.upsertFiles([{ path: "src/auth/session.ts", hash: "abc", updated_at: NOW }]);
    store.upsertSymbols([
      {
        file_path: "src/auth/session.ts",
        name: "validateSession",
        kind: "function",
        start_line: 1,
      },
    ]);
    store.deleteFile("src/auth/session.ts");
    const rows = db
      .prepare("SELECT rowid FROM fts_symbols WHERE fts_symbols MATCH 'validateSession'")
      .all<{ rowid: number }>();
    expect(rows.length).toBe(0);
  });
});
