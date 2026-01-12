import { describe, expect, it, beforeAll } from "vitest";
import { buildDirectives } from "../templates/directives.js";
import { parsePythonImports } from "../graph/import-resolution.js";
import { initTreeSitter } from "../parsers/init.js";
import type { ContextAnalysis, DetectedContext } from "../types.js";

beforeAll(async () => {
  await initTreeSitter();
});

function mockCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 10000,
    sourceFileCount: 20,
    monorepo: null,
    ...overrides,
  };
}

function emptyAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
  return {
    hubFiles: [],
    circularDeps: [],
    layers: [],
    layerEdges: [],
    gitActivity: null,
    instabilities: [],
    communities: [],
    ...overrides,
  };
}

describe("tech debt flags (§3.4)", () => {
  it("flags files with 2+ risk factors", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map([["src/graph.ts", 15]]),
        hotFiles: [{ path: "src/graph.ts", commits: 15, lastChanged: "2026-01-01" }],
        changeCoupling: [],
      },
      testMapping: {
        sourceToTests: new Map(),
        untestedFiles: ["src/graph.ts"],
      },
      circularDeps: [{ chain: ["src/graph.ts", "src/utils.ts", "src/graph.ts"] }],
    });

    const directives = buildDirectives(analysis, mockCtx());
    const debtDirectives = directives.filter((d) => d.includes("risk factors"));
    expect(debtDirectives).toHaveLength(1);
    expect(debtDirectives[0]).toContain("src/graph.ts");
    expect(debtDirectives[0]).toContain("high churn");
    expect(debtDirectives[0]).toContain("no tests");
    expect(debtDirectives[0]).toContain("circular dep");
    // Should include appropriate advice
    expect(debtDirectives[0]).toContain("Add tests");
    expect(debtDirectives[0]).toContain("Break the cycle");
  });

  it("does not flag files with only 1 risk factor", () => {
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map([["src/graph.ts", 15]]),
        hotFiles: [{ path: "src/graph.ts", commits: 15, lastChanged: "2026-01-01" }],
        changeCoupling: [],
      },
      // No other risk factors for src/graph.ts
      testMapping: {
        sourceToTests: new Map([["src/graph.ts", ["src/__tests__/graph.test.ts"]]]),
        untestedFiles: [],
      },
    });

    const directives = buildDirectives(analysis, mockCtx());
    const debtDirectives = directives.filter((d) => d.includes("risk factors"));
    expect(debtDirectives).toHaveLength(0);
  });

  it("limits tech debt flags to top 5 files", () => {
    const files = Array.from({ length: 8 }, (_, i) => `src/file${i}.ts`);
    const analysis = emptyAnalysis({
      gitActivity: {
        commitCounts: new Map(files.map((f, i) => [f, 20 - i])),
        hotFiles: files.map((f, i) => ({ path: f, commits: 20 - i, lastChanged: "2026-01-01" })),
        changeCoupling: [],
      },
      testMapping: {
        sourceToTests: new Map(),
        untestedFiles: files,
      },
    });

    const directives = buildDirectives(analysis, mockCtx());
    const debtDirectives = directives.filter((d) => d.includes("risk factors"));
    expect(debtDirectives).toHaveLength(5);
  });

  it("includes instability and tight coupling advice", () => {
    const analysis = emptyAnalysis({
      instabilities: [{ path: "src/api.ts", fanIn: 5, fanOut: 20, instability: 0.8 }],
      tightCouplings: [{ from: "src/api.ts", to: "src/db.ts", importedNames: 10, names: [] }],
    });

    const directives = buildDirectives(analysis, mockCtx());
    const debtDirectives = directives.filter((d) => d.includes("risk factors"));
    expect(debtDirectives).toHaveLength(1);
    expect(debtDirectives[0]).toContain("src/api.ts");
    expect(debtDirectives[0]).toContain("high instability");
    expect(debtDirectives[0]).toContain("tightly coupled");
    expect(debtDirectives[0]).toContain("Stabilize the API");
    expect(debtDirectives[0]).toContain("Consider extracting an interface");
  });
});

describe("Python TYPE_CHECKING detection (§3.24)", () => {
  it("marks imports inside TYPE_CHECKING block as type-only", () => {
    const source = `
from __future__ import annotations
from typing import TYPE_CHECKING

import os

if TYPE_CHECKING:
    from mypackage.models import User
    from mypackage.services import AuthService

from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    // os import: not type-only
    const osImport = imports.find((i) => i.specifier === "os");
    expect(osImport).toBeDefined();
    expect(osImport!.isTypeOnly).toBeUndefined();

    // User import: type-only (inside TYPE_CHECKING)
    const userImport = imports.find((i) => i.specifier === "mypackage.models");
    expect(userImport).toBeDefined();
    expect(userImport!.isTypeOnly).toBe(true);

    // AuthService import: type-only (inside TYPE_CHECKING)
    const authImport = imports.find((i) => i.specifier === "mypackage.services");
    expect(authImport).toBeDefined();
    expect(authImport!.isTypeOnly).toBe(true);

    // helper import: not type-only (after TYPE_CHECKING block)
    const helperImport = imports.find((i) => i.specifier === "mypackage.utils");
    expect(helperImport).toBeDefined();
    expect(helperImport!.isTypeOnly).toBeUndefined();
  });

  it("does NOT mark imports as type-only when no TYPE_CHECKING block exists", () => {
    const source = `
import os
from mypackage.models import User
from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    for (const imp of imports) {
      expect(imp.isTypeOnly).toBeUndefined();
    }
  });

  it("handles multiple imports inside TYPE_CHECKING block", () => {
    const source = `
if TYPE_CHECKING:
    from mypackage.models import User, Admin
    import mypackage.cache

from mypackage.utils import helper
`;

    const imports = parsePythonImports(source);

    const modelsImport = imports.find((i) => i.specifier === "mypackage.models");
    expect(modelsImport).toBeDefined();
    expect(modelsImport!.isTypeOnly).toBe(true);
    expect(modelsImport!.importedNames).toContain("User");
    expect(modelsImport!.importedNames).toContain("Admin");

    const cacheImport = imports.find((i) => i.specifier === "mypackage.cache");
    expect(cacheImport).toBeDefined();
    expect(cacheImport!.isTypeOnly).toBe(true);

    const helperImport = imports.find((i) => i.specifier === "mypackage.utils");
    expect(helperImport).toBeDefined();
    expect(helperImport!.isTypeOnly).toBeUndefined();
  });
});
