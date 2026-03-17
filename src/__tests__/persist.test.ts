import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { makeImportGraph, makeContextAnalysis } from "./helpers/factories";
import { PERSISTED_GRAPH_VERSION } from "../core/types/persisted-graph";

vi.mock("../core/git/git.js", () => ({
  gitExecSafe: vi.fn().mockReturnValue("abc123def456"),
}));

// Import after mocks
const { persistGraph, loadPersistedGraph } = await import("../core/graph/persist.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-persist-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

// ── persistGraph ──────────────────────────────────────────────────────

describe("persistGraph", () => {
  it("persists data to SQLite without throwing", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const analysis = makeContextAnalysis();
    await expect(persistGraph(tmpDir, graph, analysis)).resolves.not.toThrow();
    // Verify graph.db was created
    const dbPath = path.join(tmpDir, ".clarte", "graph.db");
    expect(
      await fs
        .access(dbPath)
        .then(() => true)
        .catch(() => false),
    ).toBe(true);
  });

  it("persists correct file records", async () => {
    const graph = makeImportGraph([], ["src/a.ts", "src/b.ts"]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);

    const loaded = await loadPersistedGraph(tmpDir);
    expect(loaded).not.toBeNull();
    expect(loaded?.version).toBe(PERSISTED_GRAPH_VERSION);
    expect(loaded?.files["src/a.ts"]).toBeDefined();
    expect(loaded?.files["src/b.ts"]).toBeDefined();
  });

  it("excludes external edges", async () => {
    const graph = makeImportGraph([
      {
        from: "src/a.ts",
        to: "react",
        isExternal: true,
        specifier: "react",
        importedNames: ["useState"],
      },
      {
        from: "src/a.ts",
        to: "src/b.ts",
        isExternal: false,
        specifier: "./b.js",
        importedNames: [],
      },
    ]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);

    const loaded = await loadPersistedGraph(tmpDir);
    expect(loaded).not.toBeNull();
    const edgesTo = (loaded?.edges ?? []).map((e) => e.to);
    expect(edgesTo).not.toContain("react");
    expect(edgesTo).toContain("src/b.ts");
  });

  it("serializes change coupling", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const analysis = makeContextAnalysis({
      gitActivity: {
        commitCounts: new Map(),
        hotFiles: [],
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.9, coChangeCount: 10, support: 0.5 }],
        lagCouplings: [],
      },
    });
    await persistGraph(tmpDir, graph, analysis);

    const loaded = await loadPersistedGraph(tmpDir);
    expect(loaded?.changeCoupling).toHaveLength(1);
    expect(loaded?.changeCoupling[0].fileA).toBe("src/a.ts");
    expect(loaded?.changeCoupling[0].confidence).toBe(0.9);
  });

  it("handles null/missing optional fields without crashing", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const analysis = makeContextAnalysis({
      gitActivity: null,
      chokepoints: undefined,
      crossCuttingFiles: undefined,
      testMapping: undefined,
    });
    await expect(persistGraph(tmpDir, graph, analysis)).resolves.not.toThrow();
  });
});

// ── loadPersistedGraph ────────────────────────────────────────────────

describe("loadPersistedGraph", () => {
  it("returns null when no data exists", async () => {
    const result = await loadPersistedGraph(tmpDir);
    expect(result).toBeNull();
  });
});

// ── Round-trip ────────────────────────────────────────────────────────

describe("persistGraph + loadPersistedGraph round-trip", () => {
  it("round-trips a basic graph", async () => {
    const graph = makeImportGraph(
      [{ from: "src/a.ts", to: "src/b.ts", isExternal: false, specifier: "./b.js", importedNames: ["Foo"] }],
      ["src/a.ts", "src/b.ts"],
    );
    const analysis = makeContextAnalysis({
      communities: [{ id: 1, files: ["src/a.ts"], label: "core" }],
    });

    await persistGraph(tmpDir, graph, analysis);
    const loaded = await loadPersistedGraph(tmpDir);

    if (!loaded) throw new Error("expected loaded graph");
    expect(loaded.files["src/a.ts"]).toBeDefined();
    expect(loaded.files["src/b.ts"]).toBeDefined();
    expect(loaded.edges).toHaveLength(1);
    expect(loaded.edges[0].from).toBe("src/a.ts");
    expect(loaded.edges[0].to).toBe("src/b.ts");
    expect(loaded.edges[0].importedNames).toEqual(["Foo"]);
    expect(loaded.communities).toHaveLength(1);
    expect(loaded.communities[0].id).toBe(1);
  });

  it("headCommit is included when git returns a value", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);
    const loaded = await loadPersistedGraph(tmpDir);
    if (!loaded) throw new Error("expected loaded graph");
    expect(loaded.headCommit).toBe("abc123def456");
  });
});
