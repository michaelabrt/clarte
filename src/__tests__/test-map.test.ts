import { describe, expect, it } from "vitest";
import { buildTestMapping, classifyTestType, renderTestMappingSection } from "../analysis/test-map.js";
import type { DetectedContext, TestMapping } from "../types.js";
import { makeImportGraph } from "./helpers/factories.js";

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

function makeGraph(files: string[], edges: Array<{ from: string; to: string }>) {
  return makeImportGraph(edges, files);
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
    const graph = makeGraph(["src/a.ts", "src/b.ts"], [{ from: "src/a.ts", to: "src/b.ts" }]);

    const result = buildTestMapping(graph, makeCtx());
    expect(result).toBeNull();
  });

  it("handles test files that import no source files", () => {
    const graph = makeGraph(["src/a.ts", "src/__tests__/standalone.test.ts"], []);

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

    const result = renderTestMappingSection(mapping, [{ path: "src/utils.ts" }, { path: "src/graph.ts" }]);

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
    const untestedFiles = Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`);
    const mapping: TestMapping = {
      sourceToTests: new Map(),
      untestedFiles,
    };

    const result = renderTestMappingSection(mapping);
    expect(result).toContain("5 more untested files");
  });
});

// ── Task 2a: Test type classification ─────────────────────────────────

describe("classifyTestType", () => {
  it("classifies e2e tests by path containing e2e/", () => {
    expect(classifyTestType("e2e/login.spec.ts", 1)).toBe("e2e");
    expect(classifyTestType("tests/e2e/checkout.spec.ts", 2)).toBe("e2e");
  });

  it("classifies e2e tests by path containing playwright/", () => {
    expect(classifyTestType("playwright/home.spec.ts", 0)).toBe("e2e");
  });

  it("classifies e2e tests by path containing cypress/", () => {
    expect(classifyTestType("cypress/integration/login.spec.ts", 1)).toBe("e2e");
  });

  it("classifies integration tests by path containing integration/", () => {
    expect(classifyTestType("tests/integration/auth.test.ts", 1)).toBe("integration");
    expect(classifyTestType("src/__tests__/integration/flow.test.ts", 2)).toBe("integration");
  });

  it("classifies integration tests by importing 3+ source modules", () => {
    expect(classifyTestType("src/__tests__/flow.test.ts", 3)).toBe("integration");
    expect(classifyTestType("src/__tests__/flow.test.ts", 5)).toBe("integration");
  });

  it("classifies unit tests for co-located tests with few imports", () => {
    expect(classifyTestType("src/__tests__/utils.test.ts", 1)).toBe("unit");
    expect(classifyTestType("src/utils.test.ts", 2)).toBe("unit");
  });

  it("classifies unit tests for __tests__/ directory", () => {
    expect(classifyTestType("src/__tests__/graph.test.ts", 1)).toBe("unit");
  });

  it("prioritizes e2e path over import count", () => {
    // Even if a file in e2e/ imports many modules, it should be classified as e2e
    expect(classifyTestType("e2e/full-flow.spec.ts", 10)).toBe("e2e");
  });
});

describe("buildTestMapping — test type classification", () => {
  it("populates testTypes map for all test files", () => {
    const graph = makeGraph(
      ["src/utils.ts", "src/graph.ts", "src/__tests__/utils.test.ts", "src/__tests__/graph.test.ts"],
      [
        { from: "src/__tests__/utils.test.ts", to: "src/utils.ts" },
        { from: "src/__tests__/graph.test.ts", to: "src/graph.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.testTypes).toBeDefined();
    expect(result!.testTypes!.get("src/__tests__/utils.test.ts")).toBe("unit");
    expect(result!.testTypes!.get("src/__tests__/graph.test.ts")).toBe("unit");
  });

  it("classifies e2e test files in the mapping", () => {
    const graph = makeGraph(["src/utils.ts", "e2e/flow.spec.ts"], [{ from: "e2e/flow.spec.ts", to: "src/utils.ts" }]);

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.testTypes!.get("e2e/flow.spec.ts")).toBe("e2e");
  });

  it("classifies integration test files by import count", () => {
    const graph = makeGraph(
      ["src/a.ts", "src/b.ts", "src/c.ts", "src/__tests__/cross.test.ts"],
      [
        { from: "src/__tests__/cross.test.ts", to: "src/a.ts" },
        { from: "src/__tests__/cross.test.ts", to: "src/b.ts" },
        { from: "src/__tests__/cross.test.ts", to: "src/c.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.testTypes!.get("src/__tests__/cross.test.ts")).toBe("integration");
  });
});

// ── Task 2b: Enriched rendering with test types ──────────────────────

describe("renderTestMappingSection — test type annotations", () => {
  it("includes test type in hub file directives when available", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map([["src/graph.ts", ["src/__tests__/graph.test.ts", "e2e/graph-flow.spec.ts"]]]),
      untestedFiles: [],
      testTypes: new Map([
        ["src/__tests__/graph.test.ts", "unit"],
        ["e2e/graph-flow.spec.ts", "e2e"],
      ]),
    };

    const result = renderTestMappingSection(mapping, [{ path: "src/graph.ts" }]);
    expect(result).toContain("`src/__tests__/graph.test.ts` (unit)");
    expect(result).toContain("`e2e/graph-flow.spec.ts` (e2e)");
  });

  it("omits test type when testTypes map is not present", () => {
    const mapping: TestMapping = {
      sourceToTests: new Map([["src/utils.ts", ["src/__tests__/utils.test.ts"]]]),
      untestedFiles: [],
    };

    const result = renderTestMappingSection(mapping, [{ path: "src/utils.ts" }]);
    expect(result).toContain("`src/__tests__/utils.test.ts`");
    expect(result).not.toContain("(unit)");
    expect(result).not.toContain("(e2e)");
  });
});

// ── Task 2c: Monorepo per-package test mapping ──────────────────────

describe("buildTestMapping — monorepo per-package", () => {
  it("only counts same-package tests as coverage", () => {
    const graph = makeGraph(
      [
        "packages/auth/src/login.ts",
        "packages/auth/src/__tests__/login.test.ts",
        "packages/core/src/utils.ts",
        "packages/core/src/__tests__/utils.test.ts",
        // Cross-package test import: core test imports auth source
        "packages/core/src/__tests__/integration.test.ts",
      ],
      [
        { from: "packages/auth/src/__tests__/login.test.ts", to: "packages/auth/src/login.ts" },
        { from: "packages/core/src/__tests__/utils.test.ts", to: "packages/core/src/utils.ts" },
        // This cross-package import should NOT count as coverage for auth/src/login.ts
        { from: "packages/core/src/__tests__/integration.test.ts", to: "packages/auth/src/login.ts" },
        { from: "packages/core/src/__tests__/integration.test.ts", to: "packages/core/src/utils.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();

    // auth/login.ts should only have its own package's test
    const authTests = result!.sourceToTests.get("packages/auth/src/login.ts");
    expect(authTests).toEqual(["packages/auth/src/__tests__/login.test.ts"]);
    // The cross-package test from core should NOT be listed
    expect(authTests).not.toContain("packages/core/src/__tests__/integration.test.ts");
  });

  it("handles non-monorepo graphs normally", () => {
    // Files without monorepo prefix patterns should work as before
    const graph = makeGraph(
      ["src/utils.ts", "src/__tests__/utils.test.ts"],
      [{ from: "src/__tests__/utils.test.ts", to: "src/utils.ts" }],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    expect(result!.sourceToTests.get("src/utils.ts")).toEqual(["src/__tests__/utils.test.ts"]);
  });

  it("allows same-package cross-directory test imports", () => {
    const graph = makeGraph(
      ["packages/auth/src/login.ts", "packages/auth/src/session.ts", "packages/auth/tests/login.test.ts"],
      [
        { from: "packages/auth/tests/login.test.ts", to: "packages/auth/src/login.ts" },
        { from: "packages/auth/tests/login.test.ts", to: "packages/auth/src/session.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();
    // Both source files within the same package should be covered
    expect(result!.sourceToTests.get("packages/auth/src/login.ts")).toEqual(["packages/auth/tests/login.test.ts"]);
    expect(result!.sourceToTests.get("packages/auth/src/session.ts")).toEqual(["packages/auth/tests/login.test.ts"]);
  });

  it("detects monorepo structure from apps/ prefix", () => {
    const graph = makeGraph(
      [
        "apps/web/src/app.ts",
        "apps/web/src/__tests__/app.test.ts",
        "apps/api/src/server.ts",
        "apps/api/src/__tests__/server.test.ts",
        // Cross-package test
        "apps/web/src/__tests__/cross.test.ts",
      ],
      [
        { from: "apps/web/src/__tests__/app.test.ts", to: "apps/web/src/app.ts" },
        { from: "apps/api/src/__tests__/server.test.ts", to: "apps/api/src/server.ts" },
        // Cross-package: web test imports api source
        { from: "apps/web/src/__tests__/cross.test.ts", to: "apps/api/src/server.ts" },
      ],
    );

    const result = buildTestMapping(graph, makeCtx());
    expect(result).not.toBeNull();

    // api/server.ts should only have its own package test
    const apiTests = result!.sourceToTests.get("apps/api/src/server.ts");
    expect(apiTests).toEqual(["apps/api/src/__tests__/server.test.ts"]);
    // The cross-package test from web should NOT be listed
    expect(apiTests).not.toContain("apps/web/src/__tests__/cross.test.ts");
  });
});
