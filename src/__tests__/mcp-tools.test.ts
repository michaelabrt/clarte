import { describe, it, expect } from "vitest";
import { handleScope, handleFunction, handleImpact } from "../mcp/tools.js";
import { buildCallerIndex, buildFileCallIndex } from "../graph/build-call-graph.js";
import { makePersistedGraph, makeFileRecord } from "./helpers/factories.js";
import type { ServerState } from "../mcp/server.js";
import type { CallSite } from "../types/call-graph.js";

function makeEdgesByFile(edges: Array<{ from: string; to: string; importedNames?: string[] }>) {
  const edgesByTarget = new Map<string, { from: string; to: string; importedNames: string[] }[]>();
  for (const edge of edges) {
    const e = { from: edge.from, to: edge.to, importedNames: edge.importedNames ?? [] };
    if (!edgesByTarget.has(edge.to)) edgesByTarget.set(edge.to, []);
    edgesByTarget.get(edge.to)!.push(e);
  }
  return { edgesByTarget };
}

function makeState(overrides: Partial<ServerState> = {}): ServerState {
  return {
    graph: makePersistedGraph(),
    callGraph: null,
    callerIndex: new Map(),
    fileCallIndex: new Map(),
    edgesByTarget: new Map(),
    graphMtime: 0,
    callGraphMtime: 0,
    ...overrides,
  };
}

// ── handleScope ───────────────────────────────────────────────────────────────

describe("handleScope", () => {
  it("returns file metadata for a known file", () => {
    const graph = makePersistedGraph({
      files: {
        "src/utils.ts": makeFileRecord({
          role: "Foundation",
          betweenness: 0.8,
          instability: 0.2,
          testFiles: ["src/__tests__/utils.test.ts"],
        }),
      },
      changeCoupling: [
        { fileA: "src/utils.ts", fileB: "src/index.ts", confidence: 0.9, coChangeCount: 15 },
      ],
    });
    const { edgesByTarget } = makeEdgesByFile([
      { from: "src/index.ts", to: "src/utils.ts", importedNames: ["foo"] },
    ]);
    const state = makeState({ graph, edgesByTarget });

    const result = handleScope({ path: "src/utils.ts" }, state);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("FILE: src/utils.ts");
    expect(text).toContain("Foundation");
    expect(text).toContain("IMPORTERS");
    expect(text).toContain("TEST:");
    expect(text).toContain("CO-CHANGES");
  });

  it("returns not-in-graph message for unknown file", () => {
    const state = makeState();
    const result = handleScope({ path: "src/unknown.ts" }, state);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("not in graph");
  });

  it("returns error when graph is not loaded", () => {
    const state = makeState({ graph: null });
    const result = handleScope({ path: "src/any.ts" }, state);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("graph not loaded");
  });

  it("returns error when path param is missing", () => {
    const state = makeState();
    const result = handleScope({}, state);
    expect(result.isError).toBe(true);
  });
});

// ── handleFunction ────────────────────────────────────────────────────────────

describe("handleFunction", () => {
  const sites: CallSite[] = [
    {
      caller: "src/modes/generate.ts",
      callerFn: "runGenerateMode",
      callee: "buildImportGraph",
      calleeFile: "src/graph/build.ts",
      line: 89,
    },
    {
      caller: "src/modes/watch.ts",
      callerFn: "runWatchMode",
      callee: "buildImportGraph",
      calleeFile: "src/graph/build.ts",
      line: 45,
    },
    {
      caller: "src/graph/build.ts",
      callerFn: "buildImportGraph",
      callee: "parseImports",
      calleeFile: "src/parsers/parse-imports.ts",
      line: 120,
    },
  ];

  it("returns callers and callees for a known function", () => {
    const callGraph = { version: 1 as const, timestamp: "", sites, fileHashes: {} };
    const callerIndex = buildCallerIndex(sites);
    const fileCallIndex = buildFileCallIndex(sites);
    const state = makeState({ callGraph, callerIndex, fileCallIndex });

    const result = handleFunction({ name: "buildImportGraph" }, state);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("FUNCTION: buildImportGraph");
    expect(text).toContain("CALLED BY (2)");
    expect(text).toContain("src/modes/generate.ts:89");
    expect(text).toContain("CALLS");
    expect(text).toContain("parseImports");
  });

  it("returns CALLED BY: none for unknown function", () => {
    const callGraph = { version: 1 as const, timestamp: "", sites, fileHashes: {} };
    const callerIndex = buildCallerIndex(sites);
    const fileCallIndex = buildFileCallIndex(sites);
    const state = makeState({ callGraph, callerIndex, fileCallIndex });

    const result = handleFunction({ name: "nonExistentFn" }, state);
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text).toContain("CALLED BY: none");
  });

  it("returns unavailable message when call graph is null", () => {
    const state = makeState({ callGraph: null });
    const result = handleFunction({ name: "foo" }, state);
    expect(result.isError).toBeFalsy();
    expect(result.content[0].text).toContain("call graph not available");
  });

  it("returns error when name param is missing", () => {
    const state = makeState();
    const result = handleFunction({}, state);
    expect(result.isError).toBe(true);
  });
});

// ── handleImpact ──────────────────────────────────────────────────────────────

describe("handleImpact", () => {
  it("returns RISK: LOW for a leaf file with no dependents", () => {
    const graph = makePersistedGraph({
      files: { "src/leaf.ts": makeFileRecord({ importedByCount: 0 }) },
    });
    const { edgesByTarget } = makeEdgesByFile([]);
    const state = makeState({ graph, edgesByTarget });

    const result = handleImpact({ path: "src/leaf.ts" }, state);
    const text = result.content[0].text;
    expect(text).toContain("RISK: LOW");
    expect(text).toContain("0 transitive dependents");
  });

  it("returns RISK: MEDIUM for a file with several dependents", () => {
    const files = Object.fromEntries(
      ["src/utils.ts", ...Array.from({ length: 10 }, (_, i) => `src/consumer${i}.ts`)].map((f) => [
        f,
        makeFileRecord({}),
      ]),
    );
    const graph = makePersistedGraph({ files });
    const edges = Array.from({ length: 10 }, (_, i) => ({
      from: `src/consumer${i}.ts`,
      to: "src/utils.ts",
    }));
    const { edgesByTarget } = makeEdgesByFile(edges);
    const state = makeState({ graph, edgesByTarget });

    const result = handleImpact({ path: "src/utils.ts" }, state);
    const text = result.content[0].text;
    expect(text).toContain("RISK: MEDIUM");
  });

  it("returns not-in-graph for unknown file", () => {
    const state = makeState();
    const result = handleImpact({ path: "src/unknown.ts" }, state);
    expect(result.content[0].text).toContain("not in graph");
  });

  it("returns error when path param is missing", () => {
    const state = makeState();
    const result = handleImpact({}, state);
    expect(result.isError).toBe(true);
  });
});
