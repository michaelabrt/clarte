import { describe, expect, it } from "vitest";
import { buildTestMapping, renderTestMappingSection } from "../test-map.js";
import type { DetectedContext, ImportGraph, TestMapping } from "../types.js";

function makeCtx(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: "/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: false,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
    ...overrides,
  };
}

function makeGraph(
  files: string[],
  edges: Array<{ from: string; to: string }>,
): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  for (const file of files) {
    inDegree.set(file, 0);
    centrality.set(file, 0.5);
    authority.set(file, 0.5);
    hubScores.set(file, 0.5);
  }

  const importEdges = edges.map((e) => ({
    from: e.from,
    to: e.to,
    isExternal: false,
    specifier: `./${e.to}`,
    importedNames: [],
  }));

  for (const edge of importEdges) {
    inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
  }

  return {
    edges: importEdges,
    inDegree,
    centrality,
    externalImportCounts: new Map(),
    authority,
    hubScores,
  };
}

describe("buildTestMapping — basic mapping", () => {
  it("maps test files to their imported source files", () => {
    const graph = makeGraph(
      ["src/utils.ts", "src/graph.ts", "src/__tests__/utils.test.ts", "src/__tests__/graph.test.ts"],
      [
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
        { from: "src/__tests__/graph.test.ts", to: "src/graph.ts" },
        { from: "src/graph.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.sourceToTests.get("src/utils.ts")).toEqual(["src/__tests__/utils.test.ts"]);
    expect(result!.sourceToTests.get("src/graph.ts")).toEqual(["src/__tests__/graph.test.ts"]);
  });

  it("handles multiple tests for one source file", () => {
    const graph = makeGraph(
      ["src/utils.ts", "src/__tests__/utils.test.ts", "src/__tests__/utils.integration.test.ts"],
      [
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
        { from: "src/__tests__/utils.integration.test.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    const tests = result!.sourceToTests.get("src/utils.ts");
    expect(tests).toHaveLength(2);
    expect(tests).toContain("src/__tests__/utils.test.ts");
    expect(tests).toContain("src/__tests__/utils.integration.test.ts");
  });

  it("handles .spec.ts files", () => {
    const graph = makeGraph(
      ["src/service.ts", "src/service.spec.ts"],
      [{ from: "src/service.spec.ts", to: "src/service.ts" }],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.sourceToTests.get("src/service.ts")).toEqual(["src/service.spec.ts"]);
  });
});

describe("buildTestMapping — untested files", () => {
  it("identifies untested source files", () => {
    const graph = makeGraph(
      ["src/utils.ts", "src/graph.ts", "src/orphan.ts", "src/__tests__/utils.test.ts"],
      [
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
        { from: "src/graph.ts", to: "src/utils.ts" },
        { from: "src/graph.ts", to: "src/orphan.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    // graph.ts and orphan.ts are not imported by any test
    // graph.ts is imported by non-test files: no (it's the importer, not the imported)
    // orphan.ts is imported by graph.ts (non-test) -> untested
    expect(result!.untestedFiles).toContain("src/orphan.ts");
  });

  it("excludes types files from untested", () => {
    const graph = makeGraph(
      ["src/types.ts", "src/utils.ts", "src/__tests__/utils.test.ts"],
      [
        { from: "src/utils.ts", to: "src/types.ts" },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.untestedFiles).not.toContain("src/types.ts");
  });

  it("excludes index/barrel files from untested", () => {
    const graph = makeGraph(
      ["src/index.ts", "src/utils.ts", "src/__tests__/utils.test.ts"],
      [
        { from: "src/utils.ts", to: "src/index.ts" },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.untestedFiles).not.toContain("src/index.ts");
  });

  it("excludes config files from untested", () => {
    const graph = makeGraph(
      ["src/vitest.config.ts", "src/utils.ts", "src/__tests__/utils.test.ts"],
      [
        { from: "src/utils.ts", to: "src/vitest.config.ts" },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.untestedFiles).not.toContain("src/vitest.config.ts");
  });

  it("excludes files in types/ directory from untested", () => {
    const graph = makeGraph(
      ["src/types/user.ts", "src/utils.ts", "src/__tests__/utils.test.ts"],
      [
        { from: "src/utils.ts", to: "src/types/user.ts" },
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.untestedFiles).not.toContain("src/types/user.ts");
  });
});

describe("buildTestMapping — test pattern detection", () => {
  it("detects .test convention with Vitest", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/a.test.ts", "src/b.ts", "src/b.test.ts"],
      [
        { from: "src/a.test.ts", to: "src/a.ts" },
        { from: "src/b.test.ts", to: "src/b.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx({ testFramework: "Vitest" }));
    expect(result).not.toBeNull();
    expect(result!.testPattern).toEqual({
      framework: "Vitest",
      convention: "co-located .test files",
      filePattern: "*.test.{ts,tsx,js,jsx}",
    });
  });

  it("detects .spec convention with Jest", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/a.spec.ts", "src/b.ts", "src/b.spec.ts"],
      [
        { from: "src/a.spec.ts", to: "src/a.ts" },
        { from: "src/b.spec.ts", to: "src/b.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx({ testFramework: "Jest" }));
    expect(result).not.toBeNull();
    expect(result!.testPattern).toEqual({
      framework: "Jest",
      convention: "co-located .spec files",
      filePattern: "*.spec.{ts,tsx,js,jsx}",
    });
  });
});

describe("buildTestMapping — edge cases", () => {
  it("returns null when no test files exist", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/b.ts"],
      [{ from: "src/a.ts", to: "src/b.ts" }],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).toBeNull();
  });

  it("handles test files that import no source files", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/__tests__/standalone.test.ts"],
      [],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.sourceToTests.size).toBe(0);
  });

  it("does not treat test-to-test imports as coverage", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/__tests__/a.test.ts", "src/__tests__/helpers.test.ts"],
      [
        { from: "src/__tests__/a.test.ts", to: "src/a.ts" },
        // A test importing another test file
        { from: "src/__tests__/helpers.test.ts", to: "src/__tests__/a.test.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    // Test files should not appear as covered source files
    expect(result!.sourceToTests.has("src/__tests__/a.test.ts")).toBe(false);
  });
});

describe("renderTestMappingSection", () => {
  it("renders hub file test directives", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map([
        ["src/utils.ts", ["src/__tests__/utils.test.ts"]],
        ["src/graph.ts", ["src/__tests__/graph.test.ts"]],
      ]),
      untestedFiles: [],
    };

    const result = renderTestMappingSection(mapping, [
      { path: "src/utils.ts" },
      { path: "src/graph.ts" },
    ]);

    expect(result).toContain("## Test Coverage Map");
    expect(result).toContain("When modifying `src/utils.ts`");
    expect(result).toContain("`src/__tests__/utils.test.ts`");
  });

  it("renders untested file warnings", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map(),
      untestedFiles: ["src/orphan.ts", "src/forgotten.ts"],
    };

    const result = renderTestMappingSection(mapping);
    expect(result).toContain("Add tests for uncovered files");
    expect(result).toContain("`src/orphan.ts`");
    expect(result).toContain("`src/forgotten.ts`");
  });

  it("renders test pattern info", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map([["src/a.ts", ["src/a.test.ts"]]]),
      untestedFiles: [],
      testPattern: {
        framework: "Vitest",
        convention: "co-located .test files",
        filePattern: "*.test.{ts,tsx,js,jsx}",
      },
    };

    const result = renderTestMappingSection(mapping, [{ path: "src/a.ts" }]);
    expect(result).toContain("co-located .test files");
    expect(result).toContain("*.test.{ts,tsx,js,jsx}");
  });

  it("returns null when no useful data", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map(),
      untestedFiles: [],
    };

    const result = renderTestMappingSection(mapping);
    expect(result).toBeNull();
  });

  it("truncates long untested file lists", () => {
    const untestedFiles = Array.from({ length: 15 }, (_, i) => `src/file${i}.ts`);
    const mapping: TestMapping = {
      sourceToTests: new Map(),
      untestedFiles,
    };

    const result = renderTestMappingSection(mapping);
    expect(result).toContain("5 more untested files");
  });
});
