import { describe, it, expect } from "vitest";
import { findTightCouplings } from "../core/graph/tight-coupling";
import type { ImportEdge } from "../core/types";
import { makeImportGraph } from "./helpers/factories";

function makeEdge(from: string, to: string, names: string[], opts: Partial<ImportEdge> = {}): ImportEdge {
  return {
    from,
    to,
    isExternal: false,
    specifier: `./${to}`,
    importedNames: names,
    ...opts,
  };
}

const MANY_NAMES = ["a", "b", "c", "d", "e", "f"];

describe("findTightCouplings — barrel-routed edge filtering", () => {
  it("does not create a tight coupling entry for barrel-routed edges", () => {
    const edge = makeEdge("src/types/internal.ts", "src/types/analysis.ts", MANY_NAMES, {
      isBarrelRouted: true,
    });
    const graph = makeImportGraph([edge]);
    const result = findTightCouplings(graph, 5);
    expect(result).toHaveLength(0);
  });

  it("still reports non-barrel-routed edges with many names", () => {
    const edge = makeEdge("src/consumer.ts", "src/types/analysis.ts", MANY_NAMES);
    const graph = makeImportGraph([edge]);
    const result = findTightCouplings(graph, 5);
    expect(result).toHaveLength(1);
    expect(result[0].from).toBe("src/consumer.ts");
    expect(result[0].to).toBe("src/types/analysis.ts");
    expect(result[0].importedNames).toBe(6);
  });

  it("counts only the direct edge when both barrel-routed and direct edges exist from same file", () => {
    const directEdge = makeEdge("src/consumer.ts", "src/types/analysis.ts", MANY_NAMES);
    const barrelRoutedEdge = makeEdge("src/consumer.ts", "src/types/other.ts", MANY_NAMES, {
      isBarrelRouted: true,
    });
    const graph = makeImportGraph([directEdge, barrelRoutedEdge]);
    const result = findTightCouplings(graph, 5);
    // Only the direct edge should produce a result
    expect(result).toHaveLength(1);
    expect(result[0].to).toBe("src/types/analysis.ts");
  });

  it("skips barrel files' own re-export edges (from barrel)", () => {
    const edge = makeEdge("src/types/index.ts", "src/types/analysis.ts", MANY_NAMES);
    const graph = makeImportGraph([edge]);
    graph.barrelFiles = new Set(["src/types/index.ts"]);
    const result = findTightCouplings(graph, 5);
    expect(result).toHaveLength(0);
  });
});
