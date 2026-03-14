import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { makeImportGraph, makeContextAnalysis, makeFileRecord } from "./helpers/factories.js";
import { PERSISTED_GRAPH_VERSION } from "../types/persisted-graph.js";

vi.mock("../git/git.js", () => ({
  gitExecSafe: vi.fn().mockReturnValue("abc123def456"),
}));

// Import after mocks
const { persistGraph, loadPersistedGraph } = await import("../graph/persist.js");

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-persist-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

// ── persistGraph ──────────────────────────────────────────────────────

describe("persistGraph", () => {
  it("writes JSON to <rootDir>/.clarte/graph.json", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);

    const filePath = path.join(tmpDir, ".clarte", "graph.json");
    const content = await fs.readFile(filePath, "utf-8");
    expect(() => JSON.parse(content)).not.toThrow();
  });

  it("writes correct version and files", async () => {
    const graph = makeImportGraph([], ["src/a.ts", "src/b.ts"]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);

    const filePath = path.join(tmpDir, ".clarte", "graph.json");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(parsed.version).toBe(PERSISTED_GRAPH_VERSION);
    expect(parsed.files["src/a.ts"]).toBeDefined();
    expect(parsed.files["src/b.ts"]).toBeDefined();
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

    const filePath = path.join(tmpDir, ".clarte", "graph.json");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    const edgesTo = parsed.edges.map((e: { to: string }) => e.to);
    expect(edgesTo).not.toContain("react");
    expect(edgesTo).toContain("src/b.ts");
  });

  it("only writes conditional edge props when truthy", async () => {
    const graph = makeImportGraph([
      {
        from: "src/a.ts",
        to: "src/b.ts",
        isExternal: false,
        specifier: "./b.js",
        importedNames: ["Foo"],
        isTypeOnly: true,
        isDynamic: false,
        isBarrelRouted: false,
      },
    ]);
    const analysis = makeContextAnalysis();
    await persistGraph(tmpDir, graph, analysis);

    const filePath = path.join(tmpDir, ".clarte", "graph.json");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    const edge = parsed.edges[0];
    expect(edge.isTypeOnly).toBe(true);
    expect(edge.isDynamic).toBeUndefined();
    expect(edge.isBarrelRouted).toBeUndefined();
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

    const filePath = path.join(tmpDir, ".clarte", "graph.json");
    const parsed = JSON.parse(await fs.readFile(filePath, "utf-8"));
    expect(parsed.changeCoupling).toHaveLength(1);
    expect(parsed.changeCoupling[0].fileA).toBe("src/a.ts");
    expect(parsed.changeCoupling[0].confidence).toBe(0.9);
  });

  it("handles null/missing optional fields without crashing", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    // analysis with no gitActivity, no chokepoints, no crossCuttingFiles, no testMapping
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
  it("returns null when file does not exist", async () => {
    const result = await loadPersistedGraph(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const claireDir = path.join(tmpDir, ".clarte");
    await fs.mkdir(claireDir, { recursive: true });
    await fs.writeFile(path.join(claireDir, "graph.json"), "not-json");
    const result = await loadPersistedGraph(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when version does not match", async () => {
    const claireDir = path.join(tmpDir, ".clarte");
    await fs.mkdir(claireDir, { recursive: true });
    await fs.writeFile(path.join(claireDir, "graph.json"), JSON.stringify({ version: 999, files: {}, edges: [] }));
    const result = await loadPersistedGraph(tmpDir);
    expect(result).toBeNull();
  });

  it("returns null when required fields are missing", async () => {
    const claireDir = path.join(tmpDir, ".clarte");
    await fs.mkdir(claireDir, { recursive: true });
    // Missing `edges`
    await fs.writeFile(
      path.join(claireDir, "graph.json"),
      JSON.stringify({ version: PERSISTED_GRAPH_VERSION, files: {} }),
    );
    const result = await loadPersistedGraph(tmpDir);
    expect(result).toBeNull();
  });

  it("returns parsed graph on valid input", async () => {
    const claireDir = path.join(tmpDir, ".clarte");
    await fs.mkdir(claireDir, { recursive: true });
    const data = {
      version: PERSISTED_GRAPH_VERSION,
      timestamp: new Date().toISOString(),
      files: { "src/a.ts": makeFileRecord() },
      edges: [],
      communities: [],
      changeCoupling: [],
      structuralMismatches: [],
      testMapping: {},
      lagCouplings: [],
    };
    await fs.writeFile(path.join(claireDir, "graph.json"), JSON.stringify(data));
    const result = await loadPersistedGraph(tmpDir);
    if (!result) throw new Error("expected parsed graph");
    expect(result.version).toBe(PERSISTED_GRAPH_VERSION);
    expect(result.files["src/a.ts"]).toBeDefined();
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
