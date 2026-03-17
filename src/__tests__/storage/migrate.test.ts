import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createDatabase } from "../../storage/db-adapter";
import { initSchema } from "../../storage/schema";
import { GraphStore } from "../../storage/graph-store";
import { migrateFromJson } from "../../storage/migrate";

const NOW = new Date().toISOString();

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-migrate-test-"));
  await fs.mkdir(path.join(tmpDir, ".clarte"), { recursive: true });
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function makeStore(): Promise<GraphStore> {
  const db = await createDatabase(":memory:");
  initSchema(db);
  return new GraphStore(db);
}

const CACHE_JSON = {
  version: 1,
  createdAt: NOW,
  language: "typescript",
  fileHashes: {
    "src/index.ts": "hash1",
    "src/utils.ts": "hash2",
  },
  edges: [
    {
      from: "src/index.ts",
      to: "src/utils.ts",
      isExternal: false,
      specifier: "./utils",
      importedNames: ["helper"],
    },
  ],
  barrelFiles: [],
  symbolNames: {},
};

const GRAPH_JSON = {
  version: 1,
  timestamp: NOW,
  headCommit: "abc123",
  files: {
    "src/index.ts": {
      role: "Orchestrator",
      authority: 0.9,
      hubScore: 0.5,
      betweenness: 0.1,
      instability: null,
      importedByCount: 0,
      isChokepoint: false,
      separatesComponents: 0,
      isCrossCutting: false,
      layerSpread: 0,
      layers: [],
      hasTests: false,
      testFiles: [],
      communityId: null,
    },
    "src/utils.ts": {
      role: "Utility",
      authority: 0.3,
      hubScore: 0.2,
      betweenness: 0.0,
      instability: null,
      importedByCount: 1,
      isChokepoint: false,
      separatesComponents: 0,
      isCrossCutting: false,
      layerSpread: 0,
      layers: [],
      hasTests: false,
      testFiles: [],
      communityId: null,
    },
  },
  edges: [
    {
      from: "src/index.ts",
      to: "src/utils.ts",
      importedNames: ["helper"],
    },
  ],
  communities: [],
  changeCoupling: [],
};

const CALL_GRAPH_JSON = {
  version: 1,
  timestamp: NOW,
  sites: [
    {
      caller: "src/index.ts",
      callerFn: "main",
      callee: "helper",
      calleeFile: "src/utils.ts",
      line: 5,
    },
  ],
  fileHashes: { "src/index.ts": "hash1" },
};

describe("migrateFromJson", () => {
  it("migrates fixture JSON files to correct SQLite row counts", async () => {
    await fs.writeFile(path.join(tmpDir, ".clarte/cache.json"), JSON.stringify(CACHE_JSON));
    await fs.writeFile(path.join(tmpDir, ".clarte/graph.json"), JSON.stringify(GRAPH_JSON));
    await fs.writeFile(path.join(tmpDir, ".clarte/call-graph.json"), JSON.stringify(CALL_GRAPH_JSON));

    const store = await makeStore();
    const migrated = await migrateFromJson(tmpDir, store);

    expect(migrated).toBe(true);
    const g = store.loadFileGraph();
    expect(g.nodes.size).toBe(2);
    expect(g.forward.get("src/index.ts")?.length).toBe(1);
    const callSites = store.loadAllCallSites();
    expect(callSites.length).toBe(1);
    expect(callSites[0].callee_name).toBe("helper");
  });

  it("deletes the three JSON files after migration", async () => {
    const cachePath = path.join(tmpDir, ".clarte/cache.json");
    const graphPath = path.join(tmpDir, ".clarte/graph.json");
    const callPath = path.join(tmpDir, ".clarte/call-graph.json");
    await fs.writeFile(cachePath, JSON.stringify(CACHE_JSON));
    await fs.writeFile(graphPath, JSON.stringify(GRAPH_JSON));
    await fs.writeFile(callPath, JSON.stringify(CALL_GRAPH_JSON));

    const store = await makeStore();
    await migrateFromJson(tmpDir, store);

    for (const p of [cachePath, graphPath, callPath]) {
      await expect(fs.access(p)).rejects.toThrow();
    }
  });

  it("produces same ImportGraph as original JSON data", async () => {
    await fs.writeFile(path.join(tmpDir, ".clarte/cache.json"), JSON.stringify(CACHE_JSON));
    await fs.writeFile(path.join(tmpDir, ".clarte/graph.json"), JSON.stringify(GRAPH_JSON));

    const store = await makeStore();
    await migrateFromJson(tmpDir, store);

    const g = store.loadFileGraph();
    expect(g.nodes.get("src/index.ts")?.role).toBe("Orchestrator");
    expect(g.nodes.get("src/utils.ts")?.role).toBe("Utility");
    const edge = g.forward.get("src/index.ts")?.[0];
    expect(edge?.importedNames).toEqual(["helper"]);
  });

  it("is a no-op when called a second time (files already deleted)", async () => {
    await fs.writeFile(path.join(tmpDir, ".clarte/cache.json"), JSON.stringify(CACHE_JSON));
    const store = await makeStore();
    const first = await migrateFromJson(tmpDir, store);
    const second = await migrateFromJson(tmpDir, store);

    expect(first).toBe(true);
    expect(second).toBe(false);
  });

  it("does not crash on corrupt JSON - logs warning and skips", async () => {
    await fs.writeFile(path.join(tmpDir, ".clarte/cache.json"), "{ broken json!!!");

    const store = await makeStore();
    await expect(migrateFromJson(tmpDir, store)).resolves.not.toThrow();
  });

  it("returns false when no JSON files exist", async () => {
    const store = await makeStore();
    const result = await migrateFromJson(tmpDir, store);
    expect(result).toBe(false);
  });
});
