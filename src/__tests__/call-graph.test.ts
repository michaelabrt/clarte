import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "node:fs/promises";
import {
  buildCallGraph,
  persistCallGraph,
  loadCallGraph,
  buildCallerIndex,
  buildFileCallIndex,
} from "../core/graph/build-call-graph";
import { makeImportGraph } from "./helpers/factories";

const FIXTURE_DIR = path.join(path.dirname(new URL(import.meta.url).pathname), "fixtures/call-graph");

// Build a minimal ImportGraph for the call-graph fixture files
function makeCallGraphImportGraph() {
  return makeImportGraph(
    [
      {
        from: "src/__tests__/fixtures/call-graph/simple.ts",
        to: "src/__tests__/fixtures/call-graph/helper.ts",
        isExternal: false,
        specifier: "./helper.js",
        importedNames: ["doThing"],
      },
      {
        from: "src/__tests__/fixtures/call-graph/simple.ts",
        to: "src/__tests__/fixtures/call-graph/service.ts",
        isExternal: false,
        specifier: "./service.js",
        importedNames: ["Service"],
      },
    ],
    [
      "src/__tests__/fixtures/call-graph/simple.ts",
      "src/__tests__/fixtures/call-graph/helper.ts",
      "src/__tests__/fixtures/call-graph/service.ts",
    ],
  );
}

describe("buildCallerIndex", () => {
  it("builds index keyed by calleeFile::callee", () => {
    const sites = [
      {
        caller: "src/a.ts",
        callerFn: "foo",
        callee: "doThing",
        calleeFile: "src/helper.ts",
        line: 5,
      },
      {
        caller: "src/b.ts",
        callerFn: "bar",
        callee: "doThing",
        calleeFile: "src/helper.ts",
        line: 10,
      },
    ];
    const index = buildCallerIndex(sites);
    const key = "src/helper.ts::doThing";
    expect(index.has(key)).toBe(true);
    expect(index.get(key)).toHaveLength(2);
  });

  it("skips sites with null calleeFile", () => {
    const sites = [{ caller: "src/a.ts", callerFn: "foo", callee: "external", calleeFile: null, line: 1 }];
    const index = buildCallerIndex(sites);
    expect(index.size).toBe(0);
  });
});

describe("buildFileCallIndex", () => {
  it("groups sites by caller file", () => {
    const sites = [
      { caller: "src/a.ts", callerFn: "foo", callee: "x", calleeFile: "src/b.ts", line: 1 },
      { caller: "src/a.ts", callerFn: "bar", callee: "y", calleeFile: "src/c.ts", line: 2 },
      { caller: "src/b.ts", callerFn: "baz", callee: "z", calleeFile: "src/c.ts", line: 3 },
    ];
    const index = buildFileCallIndex(sites);
    expect(index.get("src/a.ts")).toHaveLength(2);
    expect(index.get("src/b.ts")).toHaveLength(1);
  });
});

describe("buildCallGraph - extraction", () => {
  const projectRoot = path.join(FIXTURE_DIR, "..", "..", "..", "..");

  beforeEach(async () => {
    // Clean up the SQLite DB before each test to ensure fresh state
    const dbPath = path.join(projectRoot, ".clarte/graph.db");
    await fs.rm(dbPath, { force: true });
    await fs.rm(dbPath + "-wal", { force: true });
    await fs.rm(dbPath + "-shm", { force: true });
  });

  beforeAll(async () => {
    // Verify fixture file exists
    await fs.access(path.join(FIXTURE_DIR, "simple.ts"));
  });

  it("extracts direct function calls resolved to project-internal files", async () => {
    const graph = makeCallGraphImportGraph();
    const files = ["src/__tests__/fixtures/call-graph/simple.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    // Should find calls to doThing (imported from helper)
    const doThingCalls = callGraph.sites.filter((s) => s.callee === "doThing");
    expect(doThingCalls.length).toBeGreaterThan(0);
    expect(doThingCalls[0].calleeFile).toBe("src/__tests__/fixtures/call-graph/helper.ts");
    expect(doThingCalls[0].caller).toBe("src/__tests__/fixtures/call-graph/simple.ts");
  });

  it("excludes calls to built-in globals", async () => {
    const graph = makeImportGraph([], ["src/__tests__/fixtures/call-graph/simple.ts"]);
    const files = ["src/__tests__/fixtures/call-graph/simple.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    // No calls to console, Object, Array, etc.
    const builtinCalls = callGraph.sites.filter((s) => ["console", "Object", "Array", "Math"].includes(s.callee));
    expect(builtinCalls).toHaveLength(0);
  });

  it("excludes unresolved calls (not in import graph)", async () => {
    // Use a graph with no edges - no calls should resolve
    const graph = makeImportGraph([], ["src/__tests__/fixtures/call-graph/simple.ts"]);
    const files = ["src/__tests__/fixtures/call-graph/simple.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    // All sites should be empty since no imports to resolve against
    expect(callGraph.sites).toHaveLength(0);
  });

  it("assigns correct enclosing function name", async () => {
    const graph = makeCallGraphImportGraph();
    const files = ["src/__tests__/fixtures/call-graph/simple.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const fooCall = callGraph.sites.find((s) => s.callerFn === "foo" && s.callee === "doThing");
    expect(fooCall).toBeDefined();

    const bazCall = callGraph.sites.find((s) => s.callerFn === "baz");
    expect(bazCall).toBeDefined();
  });
});

describe("persistCallGraph / loadCallGraph - round-trip", () => {
  it("persists and reloads the call graph intact", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-cg-"));
    try {
      // Need a file record before inserting call sites (FK constraint)
      const { openGraphStore } = await import("../storage/loader.js");
      const store = await openGraphStore(tmpDir);
      store.upsertFiles([
        { path: "src/a.ts", hash: "abc123", updated_at: new Date().toISOString() },
        { path: "src/b.ts", hash: "def456", updated_at: new Date().toISOString() },
      ]);
      store.close();

      const original = {
        version: 1 as const,
        timestamp: new Date().toISOString(),
        sites: [
          {
            caller: "src/a.ts",
            callerFn: "foo",
            callee: "bar",
            calleeFile: "src/b.ts",
            line: 5,
          },
        ],
        fileHashes: { "src/a.ts": "abc123" },
      };
      await persistCallGraph(tmpDir, original);
      const loaded = await loadCallGraph(tmpDir);
      expect(loaded).not.toBeNull();
      expect(loaded?.sites).toHaveLength(1);
      expect(loaded?.sites[0].callee).toBe("bar");
      // fileHashes comes from the files table
      expect(loaded?.fileHashes["src/a.ts"]).toBe("abc123");
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("returns null for missing database", async () => {
    const loaded = await loadCallGraph("/nonexistent/dir");
    expect(loaded).toBeNull();
  });
});

describe("buildCallGraph - extraction (new fixtures)", () => {
  const projectRoot = path.join(FIXTURE_DIR, "..", "..", "..", "..");

  beforeEach(async () => {
    const dbPath = path.join(projectRoot, ".clarte/graph.db");
    await fs.rm(dbPath, { force: true });
    await fs.rm(dbPath + "-wal", { force: true });
    await fs.rm(dbPath + "-shm", { force: true });
  });

  it("arrow.ts: arrowFn calling doThing resolves to helper.ts", async () => {
    const graph = makeImportGraph(
      [
        {
          from: "src/__tests__/fixtures/call-graph/arrow.ts",
          to: "src/__tests__/fixtures/call-graph/helper.ts",
          isExternal: false,
          specifier: "./helper.js",
          importedNames: ["doThing"],
        },
      ],
      ["src/__tests__/fixtures/call-graph/arrow.ts", "src/__tests__/fixtures/call-graph/helper.ts"],
    );
    const files = ["src/__tests__/fixtures/call-graph/arrow.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const arrowFnSite = callGraph.sites.find((s) => s.callerFn === "arrowFn" && s.callee === "doThing");
    expect(arrowFnSite).toBeDefined();
    expect(arrowFnSite?.calleeFile).toBe("src/__tests__/fixtures/call-graph/helper.ts");
    expect(arrowFnSite?.caller).toBe("src/__tests__/fixtures/call-graph/arrow.ts");
  });

  it("method.ts: new Service() in constructor resolves calleeFile to service.ts", async () => {
    const graph = makeImportGraph(
      [
        {
          from: "src/__tests__/fixtures/call-graph/method.ts",
          to: "src/__tests__/fixtures/call-graph/service.ts",
          isExternal: false,
          specifier: "./service.js",
          importedNames: ["Service"],
        },
      ],
      ["src/__tests__/fixtures/call-graph/method.ts", "src/__tests__/fixtures/call-graph/service.ts"],
    );
    const files = ["src/__tests__/fixtures/call-graph/method.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const constructorSite = callGraph.sites.find((s) => s.callee === "Service");
    expect(constructorSite).toBeDefined();
    expect(constructorSite?.calleeFile).toBe("src/__tests__/fixtures/call-graph/service.ts");
    // Enclosing function for a new_expression in a class constructor method_definition
    expect(constructorSite?.callerFn === "constructor" || constructorSite?.callerFn === "").toBe(true);
  });

  it("chained.ts: doThing() resolves but chained obj.b().c() produces no site for callee 'c'", async () => {
    const graph = makeImportGraph(
      [
        {
          from: "src/__tests__/fixtures/call-graph/chained.ts",
          to: "src/__tests__/fixtures/call-graph/helper.ts",
          isExternal: false,
          specifier: "./helper.js",
          importedNames: ["doThing"],
        },
      ],
      ["src/__tests__/fixtures/call-graph/chained.ts", "src/__tests__/fixtures/call-graph/helper.ts"],
    );
    const files = ["src/__tests__/fixtures/call-graph/chained.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const doThingSite = callGraph.sites.find((s) => s.callee === "doThing");
    expect(doThingSite).toBeDefined();
    expect(doThingSite?.calleeFile).toBe("src/__tests__/fixtures/call-graph/helper.ts");

    const chainedCSite = callGraph.sites.find((s) => s.callee === "c");
    expect(chainedCSite).toBeUndefined();
  });

  it("namespace.ts: namespace import (import * as ns) resolves callee to target file", async () => {
    const graph = makeImportGraph(
      [
        {
          from: "src/__tests__/fixtures/call-graph/namespace.ts",
          to: "src/__tests__/fixtures/call-graph/helper.ts",
          isExternal: false,
          specifier: "./helper.js",
          importedNames: ["*"],
        },
      ],
      ["src/__tests__/fixtures/call-graph/namespace.ts", "src/__tests__/fixtures/call-graph/helper.ts"],
    );
    const files = ["src/__tests__/fixtures/call-graph/namespace.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const site = callGraph.sites.find((s) => s.callee === "doThing" && s.callerFn === "useNamespace");
    expect(site).toBeDefined();
    expect(site?.calleeFile).toBe("src/__tests__/fixtures/call-graph/helper.ts");
  });

  it("barrel-calls.ts: callThroughBarrel resolves calleeFile to barrel.ts (not helper.ts)", async () => {
    const graph = makeImportGraph(
      [
        {
          from: "src/__tests__/fixtures/call-graph/barrel-calls.ts",
          to: "src/__tests__/fixtures/call-graph/barrel.ts",
          isExternal: false,
          specifier: "./barrel.js",
          importedNames: ["doThing"],
        },
      ],
      ["src/__tests__/fixtures/call-graph/barrel-calls.ts", "src/__tests__/fixtures/call-graph/barrel.ts"],
    );
    const files = ["src/__tests__/fixtures/call-graph/barrel-calls.ts"];

    const callGraph = await buildCallGraph(projectRoot, graph, files, "typescript");

    const site = callGraph.sites.find((s) => s.callee === "doThing" && s.callerFn === "callThroughBarrel");
    expect(site).toBeDefined();
    expect(site?.calleeFile).toBe("src/__tests__/fixtures/call-graph/barrel.ts");
    expect(site?.calleeFile).not.toBe("src/__tests__/fixtures/call-graph/helper.ts");
  });
});

describe("buildCallGraph - incremental invalidation", () => {
  const projectRoot = path.join(FIXTURE_DIR, "..", "..", "..", "..");

  beforeEach(async () => {
    const dbPath = path.join(projectRoot, ".clarte/graph.db");
    await fs.rm(dbPath, { force: true });
    await fs.rm(dbPath + "-wal", { force: true });
    await fs.rm(dbPath + "-shm", { force: true });
  });

  it("reuses previous results for unchanged files", async () => {
    const graph = makeCallGraphImportGraph();
    const files = ["src/__tests__/fixtures/call-graph/simple.ts"];

    const first = await buildCallGraph(projectRoot, graph, files, "typescript");
    expect(first.sites.length).toBeGreaterThan(0);

    // Run again with same content - should reuse via hash
    const second = await buildCallGraph(projectRoot, graph, files, "typescript");
    expect(second.sites).toEqual(first.sites);
  });
});
