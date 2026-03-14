import { describe, it, expect, vi } from "vitest";

// Mock file system reads for computeFileComplexity
vi.mock("node:fs/promises", () => ({
  default: {
    readFile: vi.fn().mockResolvedValue("export function foo() { if (true) {} }"),
  },
}));

import { buildScopedRules, renderScopedRule, getGlobalDirectives } from "../templates/scoped-rules.js";
import { groupDirectivesByScope } from "../templates/directive-scope.js";
import { makeContextAnalysis, makeDetectedContext } from "./helpers/factories.js";

describe("buildScopedRules", () => {
  it("groups directives by directory correctly", async () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "src/core/a.ts",
          importedBy: 10,
          role: "Foundation",
          centrality: 0.8,
          authority: 0.8,
          hubScore: 0.2,
          imports: 2,
        },
        {
          path: "src/core/b.ts",
          importedBy: 8,
          role: "Utility",
          centrality: 0.6,
          authority: 0.6,
          hubScore: 0.3,
          imports: 3,
        },
        {
          path: "src/graph/c.ts",
          importedBy: 5,
          role: "Utility",
          centrality: 0.5,
          authority: 0.5,
          hubScore: 0.3,
          imports: 4,
        },
        {
          path: "src/graph/d.ts",
          importedBy: 3,
          role: "Leaf",
          centrality: 0.3,
          authority: 0.3,
          hubScore: 0.1,
          imports: 1,
        },
      ],
      gitActivity: {
        hotFiles: [
          { path: "src/core/a.ts", commits: 15, lastChanged: "1 day ago" },
          { path: "src/core/b.ts", commits: 12, lastChanged: "2 days ago" },
          { path: "src/graph/c.ts", commits: 11, lastChanged: "3 days ago" },
        ],
        changeCoupling: [],
        commitCounts: new Map(),
        lagCouplings: [],
      },
    });
    const ctx = makeDetectedContext();

    const rules = await buildScopedRules(analysis, ctx);
    // src/core has 3 directives (1 foundation guard + 2 churn), src/graph has only 1 churn (below threshold)
    expect(rules).toHaveLength(1);
    expect(rules[0].scope).toBe("src/core");
    expect(rules[0].filename).toBe("clarte-src-core.md");
    expect(rules[0].paths).toEqual(["src/core/**"]);
  });

  it("returns empty when no analysis directives", async () => {
    const analysis = makeContextAnalysis();
    const ctx = makeDetectedContext();
    const rules = await buildScopedRules(analysis, ctx);
    expect(rules).toEqual([]);
  });

  it("single-directive directories stay in main file", async () => {
    const analysis = makeContextAnalysis({
      hubFiles: [
        {
          path: "src/core/a.ts",
          importedBy: 10,
          role: "Foundation",
          centrality: 0.8,
          authority: 0.8,
          hubScore: 0.2,
          imports: 2,
        },
      ],
    });
    const ctx = makeDetectedContext();
    const rules = await buildScopedRules(analysis, ctx);
    // Only 1 directive for src/core, so no scoped file
    expect(rules.filter((r) => r.scope === "src/core")).toHaveLength(0);
  });
});

describe("renderScopedRule", () => {
  it("produces valid paths: frontmatter", () => {
    const rule = {
      filename: "clarte-src-core.md",
      scope: "src/core",
      paths: ["src/core/**"],
      body: "## Working Guidelines\n\n- When modifying `src/core/a.ts`, check dependents.",
    };
    const rendered = renderScopedRule(rule);
    expect(rendered).toMatch(/^---\n/);
    expect(rendered).toContain('paths: ["src/core/**"]');
    expect(rendered).toContain("---\n\n## Working Guidelines");
    expect(rendered).toContain("src/core/a.ts");
  });
});

describe("getGlobalDirectives", () => {
  it("excludes directives that moved to scoped files", () => {
    const directives = [
      "When modifying `src/core/a.ts`, check dependents.",
      "When modifying `src/core/b.ts`, check dependents.",
      "Layer violation: 3 imports flow upward.",
    ];

    const groups = groupDirectivesByScope(directives);
    const global = getGlobalDirectives(directives, groups);

    // src/core has 2 directives, so they should be excluded from global
    expect(global).toHaveLength(1);
    expect(global[0]).toContain("Layer violation");
  });

  it("keeps directives from under-threshold scopes", () => {
    const directives = ["When modifying `src/core/a.ts`, check dependents.", "Layer violation: 3 imports flow upward."];

    const groups = groupDirectivesByScope(directives);
    const global = getGlobalDirectives(directives, groups);

    // src/core has only 1 directive, so it stays in global
    expect(global).toHaveLength(2);
  });
});
