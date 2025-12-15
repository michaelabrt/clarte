import { describe, expect, it } from "vitest";
import { computeNeighborhood, scopeHubFiles, scopeCircularDeps } from "../modes/diff.js";

// ── computeNeighborhood: 2-hop expansion ──────────────────────────────

describe("computeNeighborhood", () => {
  function edge(from: string, to: string, isExternal = false) {
    return { from, to, isExternal };
  }

  it("computes hop1 as direct neighbors of changed files", () => {
    // a -> b -> c -> d
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1].sort()).toEqual(["b"]);
    expect([...hop2].sort()).toEqual(["c"]);
  });

  it("computes hop2 as neighbors of neighbors", () => {
    //   a -> b -> c -> d -> e
    const edges = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1]).toEqual(["b"]);
    expect([...hop2]).toEqual(["c"]);
    // d and e are 3+ hops away, not included
  });

  it("excludes changed files from hop1 and hop2", () => {
    const edges = [edge("a", "b"), edge("b", "c")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a", "c"]), edges);
    // b is hop1 neighbor of both a and c
    expect([...hop1]).toEqual(["b"]);
    // No hop2 since c is already in changed set
    expect(hop2.size).toBe(0);
  });

  it("excludes hop1 files from hop2", () => {
    // a -> b -> c, a -> c (c is both hop1 and hop2, should only be hop1)
    const edges = [edge("a", "b"), edge("b", "c"), edge("a", "c")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1].sort()).toEqual(["b", "c"]);
    expect(hop2.size).toBe(0);
  });

  it("handles bidirectional edges", () => {
    // a -> b, c -> a (both b and c are hop1 of a)
    const edges = [edge("a", "b"), edge("c", "a")];

    const { hop1 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1].sort()).toEqual(["b", "c"]);
  });

  it("ignores external edges", () => {
    const edges = [
      edge("a", "b"),
      edge("a", "react", true), // external
      edge("b", "lodash", true), // external
    ];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1]).toEqual(["b"]);
    expect(hop2.size).toBe(0);
  });

  it("returns empty sets when no edges connect to changed files", () => {
    const edges = [edge("x", "y"), edge("y", "z")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect(hop1.size).toBe(0);
    expect(hop2.size).toBe(0);
  });

  it("handles multiple changed files expanding to shared neighbors", () => {
    // a -> c, b -> c, c -> d
    const edges = [edge("a", "c"), edge("b", "c"), edge("c", "d")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a", "b"]), edges);
    expect([...hop1]).toEqual(["c"]);
    expect([...hop2]).toEqual(["d"]);
  });

  it("handles diamond graph correctly", () => {
    //     a
    //    / \
    //   b   c
    //    \ /
    //     d
    //     |
    //     e
    const edges = [edge("a", "b"), edge("a", "c"), edge("b", "d"), edge("c", "d"), edge("d", "e")];

    const { hop1, hop2 } = computeNeighborhood(new Set(["a"]), edges);
    expect([...hop1].sort()).toEqual(["b", "c"]);
    expect([...hop2].sort()).toEqual(["d"]);
    // e is 3 hops away, excluded
  });
});

// ── scopeHubFiles: filter to neighborhood ─────────────────────────────

describe("scopeHubFiles", () => {
  const hubs = [
    { path: "src/types.ts", role: "Foundation" },
    { path: "src/utils.ts", role: "Utility" },
    { path: "src/index.ts", role: "Orchestrator" },
    { path: "src/remote.ts", role: "Leaf" },
  ];

  it("includes hub files in changed set", () => {
    const result = scopeHubFiles(hubs, new Set(["src/types.ts"]), new Set(), new Set());
    expect(result.map((h) => h.path)).toEqual(["src/types.ts"]);
  });

  it("includes hub files in hop1 set", () => {
    const result = scopeHubFiles(hubs, new Set(), new Set(["src/utils.ts"]), new Set());
    expect(result.map((h) => h.path)).toEqual(["src/utils.ts"]);
  });

  it("includes hub files in hop2 set", () => {
    const result = scopeHubFiles(hubs, new Set(), new Set(), new Set(["src/index.ts"]));
    expect(result.map((h) => h.path)).toEqual(["src/index.ts"]);
  });

  it("excludes hub files outside the neighborhood", () => {
    const result = scopeHubFiles(hubs, new Set(["src/types.ts"]), new Set(["src/utils.ts"]), new Set());
    expect(result.map((h) => h.path).sort()).toEqual(["src/types.ts", "src/utils.ts"]);
    expect(result.map((h) => h.path)).not.toContain("src/remote.ts");
  });

  it("returns empty array when no hub files are in neighborhood", () => {
    const result = scopeHubFiles(hubs, new Set(["other.ts"]), new Set(), new Set());
    expect(result).toEqual([]);
  });
});

// ── scopeCircularDeps: filter to neighborhood ─────────────────────────

describe("scopeCircularDeps", () => {
  const cycles = [
    { chain: ["a.ts", "b.ts", "a.ts"] },
    { chain: ["c.ts", "d.ts", "c.ts"] },
    { chain: ["e.ts", "f.ts", "g.ts", "e.ts"] },
  ];

  it("includes cycles with changed files", () => {
    const result = scopeCircularDeps(cycles, new Set(["a.ts"]), new Set());
    expect(result).toHaveLength(1);
    expect(result[0].chain).toContain("a.ts");
  });

  it("includes cycles with hop1 files", () => {
    const result = scopeCircularDeps(cycles, new Set(), new Set(["d.ts"]));
    expect(result).toHaveLength(1);
    expect(result[0].chain).toContain("d.ts");
  });

  it("excludes cycles with only hop2 files", () => {
    // hop2 files should NOT cause a cycle to be included
    const result = scopeCircularDeps(cycles, new Set(["a.ts"]), new Set(["b.ts"]));
    // Only the first cycle matches (a.ts is changed, b.ts is hop1)
    expect(result).toHaveLength(1);
    expect(result[0].chain[0]).toBe("a.ts");
  });

  it("excludes all cycles when no overlap", () => {
    const result = scopeCircularDeps(cycles, new Set(["x.ts"]), new Set(["y.ts"]));
    expect(result).toHaveLength(0);
  });

  it("includes multiple matching cycles", () => {
    const result = scopeCircularDeps(cycles, new Set(["a.ts", "e.ts"]), new Set());
    expect(result).toHaveLength(2);
  });
});
