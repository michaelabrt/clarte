import { describe, expect, it } from "vitest";
import {
  findSCCs,
  findCircularDeps,
  getHubFiles,
} from "../graph.js";
import type { ImportEdge, ImportGraph } from "../types.js";

function makeGraph(files: string[], edges: ImportEdge[]): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  for (const f of files) {
    inDegree.set(f, 0);
    centrality.set(f, 1 / files.length);
  }
  for (const e of edges) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }
  return { edges, inDegree, centrality, externalImportCounts: new Map() };
}

function edge(from: string, to: string): ImportEdge {
  return { from, to, isExternal: false, specifier: `./${to}`, importedNames: [] };
}

describe("findSCCs", () => {
  it("finds a simple cycle", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
    ]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(1);
    expect(sccs[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("returns empty for a chain with no cycles", () => {
    const graph = makeGraph(["a", "b", "c"], [
      edge("a", "b"),
      edge("b", "c"),
    ]);
    const sccs = findSCCs(graph);
    expect(sccs).toHaveLength(0);
  });

});

describe("findCircularDeps", () => {
  it("reports cycles as circular deps", () => {
    const graph = makeGraph(["a", "b"], [
      edge("a", "b"),
      edge("b", "a"),
    ]);
    const deps = findCircularDeps(graph);
    expect(deps).toHaveLength(1);
    // Chain should close the loop
    expect(deps[0].chain[0]).toBe(deps[0].chain[deps[0].chain.length - 1]);
  });

  it("respects maxCycles limit", () => {
    // Create 3 separate cycles
    const graph = makeGraph(
      ["a", "b", "c", "d", "e", "f"],
      [
        edge("a", "b"),
        edge("b", "a"),
        edge("c", "d"),
        edge("d", "c"),
        edge("e", "f"),
        edge("f", "e"),
      ],
    );
    const deps = findCircularDeps(graph, 2);
    expect(deps.length).toBeLessThanOrEqual(2);
  });
});

describe("getHubFiles", () => {
  it("returns hub files sorted by centrality", () => {
    // Star graph: center is the hub
    const graph = makeGraph(["center", "a", "b", "c"], [
      edge("a", "center"),
      edge("b", "center"),
      edge("c", "center"),
    ]);
    // Manually set high centrality for center
    graph.centrality.set("center", 1.0);
    graph.centrality.set("a", 0.1);
    graph.centrality.set("b", 0.1);
    graph.centrality.set("c", 0.1);
    graph.inDegree.set("center", 3);

    const hubs = getHubFiles(graph);
    expect(hubs[0].path).toBe("center");
    expect(hubs[0].importedBy).toBe(3);
  });

  it("respects limit parameter", () => {
    const graph = makeGraph(["a", "b", "c", "d"], [
      edge("a", "b"),
      edge("a", "c"),
      edge("a", "d"),
      edge("b", "c"),
      edge("b", "d"),
      edge("c", "d"),
    ]);
    graph.centrality.set("d", 1.0);
    graph.centrality.set("c", 0.8);
    graph.centrality.set("b", 0.5);
    graph.centrality.set("a", 0.2);

    const hubs = getHubFiles(graph, 2);
    expect(hubs).toHaveLength(2);
  });
});
