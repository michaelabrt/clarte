import { describe, it, expect } from "vitest";
import { findDeadFiles } from "../core/graph/dead-files.js";
import { makeImportGraph } from "./helpers/factories.js";

function makeGraph(files: string[], edges: Array<{ from: string; to: string }> = []) {
  return makeImportGraph(edges, files);
}

describe("findDeadFiles — barrel file exclusion", () => {
  it("excludes barrel files with inDegree=0 from dead files", () => {
    const graph = makeGraph(["src/types.ts", "src/utils.ts"]);
    graph.barrelFiles = new Set(["src/types.ts"]);

    const result = findDeadFiles(graph);
    expect(result).not.toContain("src/types.ts");
  });

  it("still reports non-barrel files with inDegree=0", () => {
    const graph = makeGraph(["src/types.ts", "src/orphan.ts"]);
    graph.barrelFiles = new Set(["src/types.ts"]);

    const result = findDeadFiles(graph);
    expect(result).toContain("src/orphan.ts");
  });

  it("does not crash when barrelFiles is undefined", () => {
    const graph = makeGraph(["src/orphan.ts"]);
    // barrelFiles is not set by makeImportGraph — verify no error thrown
    expect(() => findDeadFiles(graph)).not.toThrow();
    expect(findDeadFiles(graph)).toContain("src/orphan.ts");
  });

  it("does not report barrel files even with no entry points provided", () => {
    const graph = makeGraph(["src/index.ts", "src/barrel.ts"]);
    graph.barrelFiles = new Set(["src/barrel.ts"]);

    const result = findDeadFiles(graph);
    // src/index.ts is excluded by basename convention
    // src/barrel.ts should be excluded because it is a barrel
    expect(result).not.toContain("src/barrel.ts");
  });

  it("reports barrel file if it has inDegree > 0 — barrel exclusion is inDegree=0 only", () => {
    // A barrel that IS imported by something has inDegree > 0 and would be skipped anyway
    const graph = makeGraph(["src/barrel.ts", "src/consumer.ts"], [{ from: "src/consumer.ts", to: "src/barrel.ts" }]);
    graph.barrelFiles = new Set(["src/barrel.ts"]);

    const result = findDeadFiles(graph);
    // It's not dead (inDegree=1) so should not appear regardless
    expect(result).not.toContain("src/barrel.ts");
  });
});
