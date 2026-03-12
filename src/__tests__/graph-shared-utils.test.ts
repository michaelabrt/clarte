import { describe, expect, it } from "vitest";
import { findSCCsFromAdj } from "../graph/scc.js";
import { routeBarrelImport } from "../graph/barrel-routing.js";
import type { ImportEdge } from "../types.js";
import type { BarrelExportMap } from "../graph/import-resolution.js";

// ---------------------------------------------------------------------------
// findSCCsFromAdj
// ---------------------------------------------------------------------------

describe("findSCCsFromAdj", () => {
  it("returns a singleton SCC for an isolated node", () => {
    const nodes = new Set(["a"]);
    const adj = new Map<string, string[]>();
    const sccs = findSCCsFromAdj(nodes, adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual(["a"]);
  });

  it("returns singletons for a DAG with no cycles", () => {
    const nodes = new Set(["a", "b", "c"]);
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    expect(sccs).toHaveLength(3);
    // Every SCC should be a singleton
    for (const scc of sccs) {
      expect(scc).toHaveLength(1);
    }
  });

  it("finds a simple 3-node cycle as a single SCC", () => {
    const nodes = new Set(["a", "b", "c"]);
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    const cyclic = sccs.filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("finds a 2-node mutual import cycle", () => {
    const nodes = new Set(["a", "b"]);
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    const cyclic = sccs.filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].sort()).toEqual(["a", "b"]);
  });

  it("returns a 1-node SCC for a self-loop", () => {
    const nodes = new Set(["a"]);
    const adj = new Map([["a", ["a"]]]);
    const sccs = findSCCsFromAdj(nodes, adj);
    expect(sccs).toHaveLength(1);
    expect(sccs[0]).toEqual(["a"]);
  });

  it("handles two independent cycles separately", () => {
    const nodes = new Set(["a", "b", "c", "d"]);
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["a"]],
      ["c", ["d"]],
      ["d", ["c"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    const cyclic = sccs.filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(2);
    const sorted = cyclic.map((s) => s.sort().join(",")).sort();
    expect(sorted).toEqual(["a,b", "c,d"]);
  });

  it("handles a graph where one node has no adjacency entry", () => {
    const nodes = new Set(["a", "b", "c"]);
    // "c" has no entry in adj (no outgoing edges)
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    expect(sccs).toHaveLength(3);
  });

  it("ignores edges pointing to nodes outside allNodes", () => {
    const nodes = new Set(["a", "b"]);
    // "c" is referenced in adj but not in allNodes
    const adj = new Map([
      ["a", ["b", "c"]],
      ["c", ["a"]], // would form a cycle if c were included
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    // a->b only; c is excluded so no cycle
    const cyclic = sccs.filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(0);
  });

  it("returns empty array for empty node set", () => {
    const sccs = findSCCsFromAdj(new Set<string>(), new Map());
    expect(sccs).toHaveLength(0);
  });

  it("accepts an array for allNodes (not just Set)", () => {
    const nodes = ["a", "b", "c"];
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    const cyclic = sccs.filter((s) => s.length > 1);
    expect(cyclic).toHaveLength(1);
    expect(cyclic[0].sort()).toEqual(["a", "b", "c"]);
  });

  it("total SCC node count equals allNodes size", () => {
    const nodes = new Set(["a", "b", "c", "d", "e"]);
    const adj = new Map([
      ["a", ["b"]],
      ["b", ["c"]],
      ["c", ["a"]], // cycle a-b-c
      ["d", ["e"]],
    ]);
    const sccs = findSCCsFromAdj(nodes, adj);
    const total = sccs.reduce((sum, s) => sum + s.length, 0);
    expect(total).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// routeBarrelImport
// ---------------------------------------------------------------------------

function baseEdge(
  overrides: Partial<ImportEdge> = {},
): Pick<ImportEdge, "from" | "to" | "specifier" | "importedNames" | "isTypeOnly" | "isDynamic"> {
  return {
    from: "src/consumer.ts",
    to: "src/index.ts",
    specifier: "./index",
    importedNames: ["foo", "bar"],
    isTypeOnly: false,
    isDynamic: false,
    ...overrides,
  };
}

function makeBarrelMap(
  named: Record<string, Record<string, string>> = {},
  stars: Record<string, Record<string, string[]>> = {},
): BarrelExportMap {
  const namedExports = new Map<string, Map<string, string>>();
  for (const [barrel, exports] of Object.entries(named)) {
    namedExports.set(barrel, new Map(Object.entries(exports)));
  }

  const starExports = new Map<string, Map<string, Set<string>>>();
  for (const [barrel, sources] of Object.entries(stars)) {
    const inner = new Map<string, Set<string>>();
    for (const [source, names] of Object.entries(sources)) {
      inner.set(source, new Set(names));
    }
    starExports.set(barrel, inner);
  }

  return { namedExports, starExports };
}

describe("routeBarrelImport", () => {
  it("returns empty array when target is not a barrel", () => {
    const barrelMap = makeBarrelMap();
    const result = routeBarrelImport(baseEdge(), barrelMap);
    expect(result).toHaveLength(0);
  });

  it("routes all names through named exports to their source files", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/foo.ts", bar: "src/bar.ts" },
    });
    const result = routeBarrelImport(baseEdge(), barrelMap);
    expect(result).toHaveLength(2);

    const fooEdge = result.find((e) => e.to === "src/foo.ts");
    expect(fooEdge).toBeDefined();
    expect(fooEdge?.importedNames).toEqual(["foo"]);
    expect(fooEdge?.isBarrelRouted).toBe(true);

    const barEdge = result.find((e) => e.to === "src/bar.ts");
    expect(barEdge?.importedNames).toEqual(["bar"]);
  });

  it("groups multiple names from the same source into one edge", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/utils.ts", bar: "src/utils.ts" },
    });
    const result = routeBarrelImport(baseEdge(), barrelMap);
    expect(result).toHaveLength(1);
    expect(result[0].importedNames.sort()).toEqual(["bar", "foo"]);
    expect(result[0].to).toBe("src/utils.ts");
  });

  it("routes unresolved names through star exports when they match", () => {
    const barrelMap = makeBarrelMap(
      { "src/index.ts": { foo: "src/foo.ts" } },
      { "src/index.ts": { "src/bar.ts": ["bar", "baz"] } },
    );
    const result = routeBarrelImport(baseEdge(), barrelMap);

    const starEdge = result.find((e) => e.to === "src/bar.ts");
    expect(starEdge).toBeDefined();
    expect(starEdge?.importedNames).toEqual(["bar"]);
    expect(starEdge?.isBarrelRouted).toBe(true);
  });

  it("routes unresolved names to star export source when exportedNames set is empty (wildcard)", () => {
    // Empty set means "re-exports everything" - all unresolved names match
    const barrelMap = makeBarrelMap({}, { "src/index.ts": { "src/all.ts": [] } });
    const result = routeBarrelImport(baseEdge(), barrelMap);
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("src/all.ts");
    expect(result[0].importedNames.sort()).toEqual(["bar", "foo"]);
  });

  it("preserves isTypeOnly flag on routed edges", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/foo.ts", bar: "src/bar.ts" },
    });
    const result = routeBarrelImport(baseEdge({ isTypeOnly: true }), barrelMap);
    for (const e of result) {
      expect(e.isTypeOnly).toBe(true);
    }
  });

  it("preserves isDynamic flag on routed edges", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/foo.ts" },
    });
    const result = routeBarrelImport(baseEdge({ importedNames: ["foo"], isDynamic: true }), barrelMap);
    expect(result[0].isDynamic).toBe(true);
  });

  it("keeps edge pointing to barrel itself for side-effect imports (no names)", () => {
    const barrelMap = makeBarrelMap({ "src/index.ts": { foo: "src/foo.ts" } });
    const result = routeBarrelImport(baseEdge({ importedNames: [] }), barrelMap);
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("src/index.ts");
    expect(result[0].importedNames).toHaveLength(0);
    expect(result[0].isBarrelRouted).toBeUndefined();
  });

  it("sets isExternal to false on all routed edges", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/foo.ts" },
    });
    const result = routeBarrelImport(baseEdge({ importedNames: ["foo"] }), barrelMap);
    for (const e of result) {
      expect(e.isExternal).toBe(false);
    }
  });

  it("drops names that are not in named or star exports", () => {
    const barrelMap = makeBarrelMap({
      "src/index.ts": { foo: "src/foo.ts" },
    });
    // "bar" is not in the barrel map
    const result = routeBarrelImport(baseEdge(), barrelMap);
    // Only foo resolves; bar is unresolved and no star exports exist
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("src/foo.ts");
  });

  it("handles a barrel with only star exports and no named exports", () => {
    const barrelMap = makeBarrelMap({}, { "src/index.ts": { "src/stuff.ts": ["foo", "bar"] } });
    const result = routeBarrelImport(baseEdge(), barrelMap);
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("src/stuff.ts");
    expect(result[0].importedNames.sort()).toEqual(["bar", "foo"]);
  });
});
