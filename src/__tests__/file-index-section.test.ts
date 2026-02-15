import { describe, it, expect } from "vitest";
import type { ImportEdge, ImportGraph } from "../types.js";
import { renderFileIndexSection } from "../templates/sections/file-index.js";

// ── Helpers ──────────────────────────────────────────────────────────

function makeEdge(from: string, to: string, names: string[]): ImportEdge {
  return { from, to, isExternal: false, specifier: to, importedNames: names };
}

function makeGraph(edges: ImportEdge[], barrelFiles?: string[]): ImportGraph {
  return {
    edges,
    inDegree: new Map(),
    centrality: new Map(),
    externalImportCounts: new Map(),
    authority: new Map(),
    hubScores: new Map(),
    barrelFiles: barrelFiles ? new Set(barrelFiles) : undefined,
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("renderFileIndexSection", () => {
  it("returns null for empty graph", () => {
    const graph = makeGraph([]);
    expect(renderFileIndexSection(graph)).toBeNull();
  });

  it("returns null when all files are test files", () => {
    const graph = makeGraph([makeEdge("src/app.ts", "src/__tests__/helper.ts", ["helper"])]);
    expect(renderFileIndexSection(graph)).toBeNull();
  });

  it("returns null when all files are barrel files", () => {
    const graph = makeGraph([makeEdge("src/app.ts", "src/index.ts", ["foo"])], ["src/index.ts"]);
    expect(renderFileIndexSection(graph)).toBeNull();
  });

  it("renders a basic file index table", () => {
    const graph = makeGraph([
      makeEdge("src/app.ts", "src/utils.ts", ["slugify", "isTestFile"]),
      makeEdge("src/cli.ts", "src/utils.ts", ["estimateTokens"]),
    ]);
    const section = renderFileIndexSection(graph);
    expect(section).not.toBeNull();
    expect(section!.id).toBe("file-index");
    expect(section!.priority).toBe(2);
    expect(section!.content).toContain("## File Index");
    expect(section!.content).toContain("| File | Exports |");
    expect(section!.content).toContain("`src/utils.ts`");
  });

  it("sorts exports by frequency (most imported first)", () => {
    const graph = makeGraph([
      makeEdge("src/a.ts", "src/utils.ts", ["rare", "common"]),
      makeEdge("src/b.ts", "src/utils.ts", ["common"]),
      makeEdge("src/c.ts", "src/utils.ts", ["common"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    const line = section.content.split("\n").find((l) => l.includes("src/utils.ts"))!;
    const exportsCell = line.split("|")[2].trim();
    expect(exportsCell).toBe("common, rare");
  });

  it("truncates to 5 exports with ellipsis", () => {
    const names = ["a", "b", "c", "d", "e", "f", "g"];
    const graph = makeGraph([makeEdge("src/app.ts", "src/big.ts", names)]);
    const section = renderFileIndexSection(graph)!;
    const line = section.content.split("\n").find((l) => l.includes("src/big.ts"))!;
    expect(line).toContain("...");
    // Should show exactly 5 names before "..."
    const exportsCell = line.split("|")[2].trim();
    const nameCount = exportsCell.replace(", ...", "").split(", ").length;
    expect(nameCount).toBe(5);
  });

  it("does not add ellipsis for exactly 5 exports", () => {
    const names = ["a", "b", "c", "d", "e"];
    const graph = makeGraph([makeEdge("src/app.ts", "src/exact.ts", names)]);
    const section = renderFileIndexSection(graph)!;
    const line = section.content.split("\n").find((l) => l.includes("src/exact.ts"))!;
    expect(line).not.toContain("...");
  });

  it("filters out test files", () => {
    const graph = makeGraph([
      makeEdge("src/app.ts", "src/utils.ts", ["foo"]),
      makeEdge("src/app.ts", "src/utils.test.ts", ["mockFoo"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    expect(section.content).toContain("`src/utils.ts`");
    expect(section.content).not.toContain("utils.test.ts");
  });

  it("filters out barrel files", () => {
    const graph = makeGraph(
      [makeEdge("src/app.ts", "src/types/index.ts", ["Foo"]), makeEdge("src/app.ts", "src/types/graph.ts", ["Bar"])],
      ["src/types/index.ts"],
    );
    const section = renderFileIndexSection(graph)!;
    expect(section.content).not.toContain("src/types/index.ts");
    expect(section.content).toContain("`src/types/graph.ts`");
  });

  it("filters out fixture files", () => {
    const graph = makeGraph([
      makeEdge("src/app.ts", "src/utils.ts", ["foo"]),
      makeEdge("src/test.ts", "src/fixtures/data.ts", ["testData"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    expect(section.content).not.toContain("fixtures/data.ts");
  });

  it("skips external edges", () => {
    const graph = makeGraph([
      { from: "src/app.ts", to: "react", isExternal: true, specifier: "react", importedNames: ["useState"] },
      makeEdge("src/app.ts", "src/utils.ts", ["foo"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    expect(section.content).not.toContain("react");
    expect(section.content).toContain("`src/utils.ts`");
  });

  it("skips edges with no imported names", () => {
    const graph = makeGraph([
      makeEdge("src/app.ts", "src/side-effect.ts", []),
      makeEdge("src/app.ts", "src/utils.ts", ["foo"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    expect(section.content).not.toContain("side-effect.ts");
  });

  it("sorts files by path for scanability", () => {
    const graph = makeGraph([
      makeEdge("src/x.ts", "src/z.ts", ["z"]),
      makeEdge("src/x.ts", "src/a.ts", ["a"]),
      makeEdge("src/x.ts", "src/m.ts", ["m"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    const lines = section.content.split("\n").filter((l) => l.startsWith("| `"));
    expect(lines[0]).toContain("src/a.ts");
    expect(lines[1]).toContain("src/m.ts");
    expect(lines[2]).toContain("src/z.ts");
  });

  it("deduplicates names imported by multiple files", () => {
    const graph = makeGraph([
      makeEdge("src/a.ts", "src/utils.ts", ["foo", "bar"]),
      makeEdge("src/b.ts", "src/utils.ts", ["foo", "baz"]),
    ]);
    const section = renderFileIndexSection(graph)!;
    const line = section.content.split("\n").find((l) => l.includes("src/utils.ts"))!;
    const exportsCell = line.split("|")[2].trim();
    // "foo" should appear once, sorted first (frequency 2)
    const names = exportsCell.split(", ");
    expect(names[0]).toBe("foo");
    expect(names.filter((n) => n === "foo")).toHaveLength(1);
  });

  it("has valid token estimate", () => {
    const graph = makeGraph([makeEdge("src/a.ts", "src/b.ts", ["x"])]);
    const section = renderFileIndexSection(graph)!;
    expect(section.tokens).toBeGreaterThan(0);
  });
});
