import { describe, it, expect, vi } from "vitest";
import type { ContextAnalysis, CodeSnapshot, DetectedContext } from "../types.js";

// Mock delegated dependencies so we test only the structure logic
vi.mock("../templates/framework-hints.js", () => ({
  getFrameworkHintsSection: vi.fn().mockReturnValue(""),
}));

vi.mock("../conventions/conventions.js", () => ({
  renderConventionsSection: vi.fn().mockReturnValue(null),
}));

vi.mock("../analysis/test-map.js", () => ({
  renderTestMappingSection: vi.fn().mockReturnValue(null),
}));

import { renderStructureSections } from "../templates/sections/structure.js";
import { getFrameworkHintsSection } from "../templates/framework-hints.js";
import { renderConventionsSection } from "../conventions/conventions.js";
import { renderTestMappingSection } from "../analysis/test-map.js";

// ── Fixtures ──────────────────────────────────────────────────────────

function makeCtx(overrides?: Partial<DetectedContext>): DetectedContext {
  return {
    rootDir: "/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "biome",
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

function makeAnalysis(overrides?: Partial<ContextAnalysis>): ContextAnalysis {
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

function makeSnapshot(markdown: string): CodeSnapshot {
  return { entries: [], markdown };
}

// ── Framework hints delegation ────────────────────────────────────────

describe("renderStructureSections: framework-hints", () => {
  it("includes framework-hints section when delegate returns content", () => {
    vi.mocked(getFrameworkHintsSection).mockReturnValueOnce("## Framework Conventions\n\n- hint");
    const sections = renderStructureSections(makeCtx(), null);
    const fw = sections.find((s) => s.id === "framework-hints");
    if (!fw) throw new Error("expected framework-hints section");
    expect(fw.content).toContain("Framework Conventions");
    expect(fw.priority).toBe(5);
    expect(fw.tokens).toBeGreaterThan(0);
  });

  it("omits framework-hints section when delegate returns empty string", () => {
    vi.mocked(getFrameworkHintsSection).mockReturnValueOnce("");
    const sections = renderStructureSections(makeCtx(), null);
    expect(sections.find((s) => s.id === "framework-hints")).toBeUndefined();
  });
});

// ── Conventions delegation ────────────────────────────────────────────

describe("renderStructureSections: conventions", () => {
  it("includes conventions section when delegate returns content", () => {
    vi.mocked(renderConventionsSection).mockReturnValueOnce("## Conventions\n\ncamelCase");
    const analysis = makeAnalysis({ conventions: {} as ContextAnalysis["conventions"] });
    const sections = renderStructureSections(makeCtx(), null, analysis);
    const conv = sections.find((s) => s.id === "conventions");
    if (!conv) throw new Error("expected conventions section");
    expect(conv.content).toContain("Conventions");
    expect(conv.priority).toBe(5);
  });

  it("omits conventions section when analysis.conventions is absent", () => {
    const sections = renderStructureSections(makeCtx(), null, makeAnalysis());
    expect(sections.find((s) => s.id === "conventions")).toBeUndefined();
  });

  it("omits conventions section when delegate returns null", () => {
    vi.mocked(renderConventionsSection).mockReturnValueOnce(null);
    const analysis = makeAnalysis({ conventions: {} as ContextAnalysis["conventions"] });
    const sections = renderStructureSections(makeCtx(), null, analysis);
    expect(sections.find((s) => s.id === "conventions")).toBeUndefined();
  });
});

// ── Code snapshot ─────────────────────────────────────────────────────

describe("renderStructureSections: code-snapshot", () => {
  it("renders snapshot with header and comment markers", () => {
    const sections = renderStructureSections(makeCtx(), makeSnapshot("export type Foo = string;"));
    const snap = sections.find((s) => s.id === "code-snapshot");
    if (!snap) throw new Error("expected code-snapshot section");
    expect(snap.content).toContain("## Code Snapshot");
    expect(snap.content).toContain("<!-- CODE SNAPSHOT (auto-generated");
    expect(snap.content).toContain("export type Foo = string;");
    expect(snap.content).toContain("<!-- /CODE SNAPSHOT -->");
    expect(snap.priority).toBe(6);
    expect(snap.tokens).toBeGreaterThan(0);
  });

  it("omits snapshot section when snapshot is null", () => {
    const sections = renderStructureSections(makeCtx(), null);
    expect(sections.find((s) => s.id === "code-snapshot")).toBeUndefined();
  });

  it("omits snapshot section when snapshot.markdown is empty", () => {
    const sections = renderStructureSections(makeCtx(), makeSnapshot(""));
    expect(sections.find((s) => s.id === "code-snapshot")).toBeUndefined();
  });
});

// ── Test mapping delegation ───────────────────────────────────────────

describe("renderStructureSections: test-mapping", () => {
  it("includes test-mapping section when delegate returns content", () => {
    vi.mocked(renderTestMappingSection).mockReturnValueOnce("## Test Mapping\n\ntest info");
    const analysis = makeAnalysis({ testMapping: {} as ContextAnalysis["testMapping"] });
    const sections = renderStructureSections(makeCtx(), null, analysis);
    const tm = sections.find((s) => s.id === "test-mapping");
    if (!tm) throw new Error("expected test-mapping section");
    expect(tm.priority).toBe(8);
  });

  it("omits test-mapping section when analysis.testMapping is absent", () => {
    const sections = renderStructureSections(makeCtx(), null, makeAnalysis());
    expect(sections.find((s) => s.id === "test-mapping")).toBeUndefined();
  });

  it("omits test-mapping section when delegate returns null", () => {
    vi.mocked(renderTestMappingSection).mockReturnValueOnce(null);
    const analysis = makeAnalysis({ testMapping: {} as ContextAnalysis["testMapping"] });
    const sections = renderStructureSections(makeCtx(), null, analysis);
    expect(sections.find((s) => s.id === "test-mapping")).toBeUndefined();
  });
});

// ── Project structure tree ────────────────────────────────────────────

describe("renderStructureSections: structure", () => {
  it("renders structure section with fenced code block", () => {
    const ctx = makeCtx({ directories: ["src", "docs"] });
    const sections = renderStructureSections(ctx, null);
    const struct = sections.find((s) => s.id === "structure");
    if (!struct) throw new Error("expected structure section");
    expect(struct.content).toContain("## Project Structure");
    expect(struct.content).toContain("```");
    expect(struct.content).toContain("src/");
    expect(struct.content).toContain("docs/");
    expect(struct.priority).toBe(8);
  });

  it("omits structure section when directories is empty", () => {
    const sections = renderStructureSections(makeCtx({ directories: [] }), null);
    expect(sections.find((s) => s.id === "structure")).toBeUndefined();
  });

  it("groups children under parent directories", () => {
    const ctx = makeCtx({ directories: ["src", "src/utils", "src/types", "docs"] });
    const sections = renderStructureSections(ctx, null);
    const struct = sections.find((s) => s.id === "structure");
    if (!struct) throw new Error("expected structure section");
    expect(struct.content).toContain("src/");
    expect(struct.content).toContain("  utils/");
    expect(struct.content).toContain("  types/");
    expect(struct.content).toContain("docs/");
  });

  it("sorts top-level directories alphabetically", () => {
    const ctx = makeCtx({ directories: ["src", "docs", "api"] });
    const sections = renderStructureSections(ctx, null);
    const struct = sections.find((s) => s.id === "structure");
    const content = struct?.content ?? "";
    const apiIdx = content.indexOf("api/");
    const docsIdx = content.indexOf("docs/");
    const srcIdx = content.indexOf("src/");
    expect(apiIdx).toBeLessThan(docsIdx);
    expect(docsIdx).toBeLessThan(srcIdx);
  });

  it("sorts child directories alphabetically", () => {
    const ctx = makeCtx({ directories: ["src/services", "src/config", "src/types"] });
    const sections = renderStructureSections(ctx, null);
    const struct = sections.find((s) => s.id === "structure");
    const content = struct?.content ?? "";
    const configIdx = content.indexOf("  config/");
    const servicesIdx = content.indexOf("  services/");
    const typesIdx = content.indexOf("  types/");
    expect(configIdx).toBeLessThan(servicesIdx);
    expect(servicesIdx).toBeLessThan(typesIdx);
  });

  it("handles deeply nested paths (3+ levels) by grouping under first segment", () => {
    const ctx = makeCtx({ directories: ["src/core/analysis"] });
    const sections = renderStructureSections(ctx, null);
    const struct = sections.find((s) => s.id === "structure");
    expect(struct?.content).toContain("src/");
    expect(struct?.content).toContain("  core/analysis/");
  });
});

// ── Monorepo structure ────────────────────────────────────────────────

describe("renderStructureSections: monorepo-structure", () => {
  it("renders monorepo section with package list", () => {
    const ctx = makeCtx({
      monorepo: {
        type: "pnpm-workspaces",
        packages: [
          { name: "@app/web", path: "packages/web", dependencies: [], frameworks: [] },
          { name: "@app/api", path: "packages/api", dependencies: [], frameworks: [] },
        ],
      },
    });
    const sections = renderStructureSections(ctx, null);
    const mono = sections.find((s) => s.id === "monorepo-structure");
    if (!mono) throw new Error("expected monorepo-structure section");
    expect(mono.content).toContain("## Monorepo Structure");
    expect(mono.content).toContain("pnpm-workspaces workspace with 2 packages:");
    expect(mono.content).toContain("**@app/web**");
    expect(mono.content).toContain("`packages/web`");
    expect(mono.content).toContain("**@app/api**");
    expect(mono.content).toContain("`packages/api`");
    expect(mono.priority).toBe(8);
  });

  it("shows framework names in parentheses when present", () => {
    const ctx = makeCtx({
      monorepo: {
        type: "npm-workspaces",
        packages: [
          {
            name: "@app/web",
            path: "packages/web",
            dependencies: [],
            frameworks: [{ name: "Next.js" }, { name: "React" }],
          },
        ],
      },
    });
    const sections = renderStructureSections(ctx, null);
    const mono = sections.find((s) => s.id === "monorepo-structure");
    if (!mono) throw new Error("expected monorepo-structure section");
    expect(mono.content).toContain("(Next.js, React)");
  });

  it("omits framework parentheses when frameworks array is empty", () => {
    const ctx = makeCtx({
      monorepo: {
        type: "turborepo",
        packages: [{ name: "@app/lib", path: "packages/lib", dependencies: [], frameworks: [] }],
      },
    });
    const sections = renderStructureSections(ctx, null);
    const mono = sections.find((s) => s.id === "monorepo-structure");
    if (!mono) throw new Error("expected monorepo-structure section");
    // Should have the package name but no trailing parentheses
    expect(mono.content).toContain("**@app/lib** (`packages/lib`)");
    expect(mono.content).not.toMatch(/\(`packages\/lib`\)\s*\(/);
  });

  it("omits monorepo section when monorepo is null", () => {
    const sections = renderStructureSections(makeCtx({ monorepo: null }), null);
    expect(sections.find((s) => s.id === "monorepo-structure")).toBeUndefined();
  });

  it("omits monorepo section when packages array is empty", () => {
    const ctx = makeCtx({
      monorepo: { type: "nx", packages: [] },
    });
    const sections = renderStructureSections(ctx, null);
    expect(sections.find((s) => s.id === "monorepo-structure")).toBeUndefined();
  });
});

// ── Combined output ───────────────────────────────────────────────────

describe("renderStructureSections: combined", () => {
  it("returns empty array when no conditions are met", () => {
    const sections = renderStructureSections(makeCtx(), null);
    expect(sections).toEqual([]);
  });

  it("returns multiple sections when several conditions are met", () => {
    vi.mocked(getFrameworkHintsSection).mockReturnValueOnce("## Framework Conventions\n\nhint");
    const ctx = makeCtx({ directories: ["src"] });
    const sections = renderStructureSections(ctx, makeSnapshot("snapshot content"));
    const ids = sections.map((s) => s.id);
    expect(ids).toContain("framework-hints");
    expect(ids).toContain("code-snapshot");
    expect(ids).toContain("structure");
  });

  it("all sections have positive token counts", () => {
    vi.mocked(getFrameworkHintsSection).mockReturnValueOnce("## Framework Conventions\n\nhint");
    const ctx = makeCtx({ directories: ["src"] });
    const sections = renderStructureSections(ctx, makeSnapshot("content"));
    for (const s of sections) {
      expect(s.tokens).toBeGreaterThan(0);
    }
  });
});
