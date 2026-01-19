import { describe, it, expect } from "vitest";
import { buildCursorRules, renderCursorRule } from "../templates/cursor-rules.js";
import type { DetectedContext, UserAnswers, ContextAnalysis } from "../types.js";

// ---------------------------------------------------------------------------
// Minimal fixture helpers (inline, not shared)
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: "/tmp/test-project",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "none",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
    ...overrides,
  };
}

function makeAnswers(overrides: Partial<UserAnswers> = {}): UserAnswers {
  return {
    ides: ["cursor"],
    projectPurpose: "test project",
    keyPatterns: "",
    gotchas: "",
    generateSnapshot: false,
    snapshotPaths: [],
    stackConfirmed: true,
    stackCorrections: "",
    generatePerPackage: false,
    ...overrides,
  };
}

function makeAnalysis(overrides: Partial<ContextAnalysis> = {}): ContextAnalysis {
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("buildCursorRules", () => {
  it("always includes a global rule", async () => {
    const rules = await buildCursorRules(makeCtx(), makeAnswers());
    expect(rules.length).toBeGreaterThanOrEqual(1);
    const global = rules.find((r) => r.filename === "global.md");
    expect(global).toBeDefined();
    expect(global!.description).toBe("Universal project rules");
  });

  it("global rule body contains header and update reminder", async () => {
    const rules = await buildCursorRules(makeCtx(), makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("# Global Rules");
    expect(global.body).toContain("update the relevant context files");
  });

  it("renders gotchas when provided", async () => {
    const answers = makeAnswers({ gotchas: "Never use eval. Always sanitize inputs" });
    const rules = await buildCursorRules(makeCtx(), answers);
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("## Gotchas");
    expect(global.body).toContain("Never use eval");
    expect(global.body).toContain("Always sanitize inputs");
  });

  it("omits gotchas section when empty", async () => {
    const rules = await buildCursorRules(makeCtx(), makeAnswers({ gotchas: "" }));
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).not.toContain("## Gotchas");
  });

  // --- Components rule ---

  it("adds components rule when components/ directory exists", async () => {
    const ctx = makeCtx({ directories: ["src/components"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const comp = rules.find((r) => r.filename === "ui-components.md");
    expect(comp).toBeDefined();
    expect(comp!.description).toBe("Component conventions and patterns");
  });

  it("omits components rule when no components directory", async () => {
    const ctx = makeCtx({ directories: ["src/lib", "src/utils"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    expect(rules.find((r) => r.filename === "ui-components.md")).toBeUndefined();
  });

  // --- Services rule ---

  it("adds services rule when services/ directory exists", async () => {
    const ctx = makeCtx({ directories: ["src/services"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const svc = rules.find((r) => r.filename === "services.md");
    expect(svc).toBeDefined();
    expect(svc!.description).toBe("Service and API layer patterns");
  });

  it("adds services rule when api/ directory exists", async () => {
    const ctx = makeCtx({ directories: ["src/api"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    expect(rules.find((r) => r.filename === "services.md")).toBeDefined();
  });

  it("omits services rule when neither services/ nor api/ exists", async () => {
    const ctx = makeCtx({ directories: ["src/lib"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    expect(rules.find((r) => r.filename === "services.md")).toBeUndefined();
  });

  // --- Stores rule ---

  it("adds stores rule when stores/ directory exists", async () => {
    const ctx = makeCtx({ directories: ["src/stores"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const store = rules.find((r) => r.filename === "stores.md");
    expect(store).toBeDefined();
    expect(store!.description).toBe("State management patterns");
  });

  it("adds stores rule when store/ directory exists", async () => {
    const ctx = makeCtx({ directories: ["src/store"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    expect(rules.find((r) => r.filename === "stores.md")).toBeDefined();
  });

  it("omits stores rule when no store directory", async () => {
    const ctx = makeCtx({ directories: ["src/data"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    expect(rules.find((r) => r.filename === "stores.md")).toBeUndefined();
  });

  // --- State management detection in stores rule ---

  it("stores rule mentions Zustand when detected", async () => {
    const ctx = makeCtx({
      directories: ["src/stores"],
      frameworks: [{ name: "Zustand", version: "4.0.0" }],
    });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const store = rules.find((r) => r.filename === "stores.md")!;
    expect(store.body).toContain("**Zustand**");
    expect(store.body).toContain("slice architecture");
  });

  it("stores rule mentions Redux when detected", async () => {
    const ctx = makeCtx({
      directories: ["src/stores"],
      frameworks: [{ name: "Redux Toolkit", version: "2.0.0" }],
    });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const store = rules.find((r) => r.filename === "stores.md")!;
    expect(store.body).toContain("**Redux Toolkit**");
  });

  it("stores rule mentions Pinia when detected", async () => {
    const ctx = makeCtx({
      directories: ["src/stores"],
      frameworks: [{ name: "Pinia", version: "2.0.0" }],
    });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const store = rules.find((r) => r.filename === "stores.md")!;
    expect(store.body).toContain("**Pinia**");
  });

  it("stores rule uses generic advice when no state library detected", async () => {
    const ctx = makeCtx({ directories: ["src/stores"] });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const store = rules.find((r) => r.filename === "stores.md")!;
    expect(store.body).toContain("Keep state updates immutable");
  });

  // --- Linter info ---

  it("renders linter info in global rule when linter detected", async () => {
    const ctx = makeCtx({ linter: "eslint" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("Linter: **eslint**");
  });

  it("omits linter info when linter is none", async () => {
    const ctx = makeCtx({ linter: "none" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).not.toContain("Linter:");
  });

  // --- getExtGlob via glob patterns ---

  it("uses {ts,tsx} glob for typescript projects", async () => {
    const ctx = makeCtx({ language: "typescript" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.globs).toContain("{ts,tsx}");
  });

  it("uses {js,jsx} glob for javascript projects", async () => {
    const ctx = makeCtx({ language: "javascript" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.globs).toContain("{js,jsx}");
  });

  it("uses py glob for python projects", async () => {
    const ctx = makeCtx({ language: "python" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.globs).toContain("py");
  });

  it("uses go glob for go projects", async () => {
    const ctx = makeCtx({ language: "go" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.globs).toContain("go");
  });

  it("uses rs glob for rust projects", async () => {
    const ctx = makeCtx({ language: "rust" });
    const rules = await buildCursorRules(ctx, makeAnswers());
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.globs).toContain("rs");
  });

  // --- Analysis-driven sections in global rule ---

  it("renders instability warnings when analysis has instabilities", async () => {
    const analysis = makeAnalysis({
      instabilities: [{ path: "src/index.ts", fanIn: 10, fanOut: 8, instability: 0.8 }],
    });
    const rules = await buildCursorRules(makeCtx(), makeAnswers(), analysis);
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("## High-Instability Files");
    expect(global.body).toContain("src/index.ts");
    expect(global.body).toContain("80% unstable");
  });

  it("renders change coupling when analysis has coupling data", async () => {
    const analysis = makeAnalysis({
      gitActivity: {
        changeCoupling: [{ fileA: "a.ts", fileB: "b.ts", coChangeCount: 5, support: 0.5, confidence: 0.8 }],
        churnFiles: [],
        recentlyActiveFiles: [],
        lagCoupling: [],
      },
    });
    const rules = await buildCursorRules(makeCtx(), makeAnswers(), analysis);
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("## Change Coupling");
    expect(global.body).toContain("a.ts");
    expect(global.body).toContain("b.ts");
  });

  it("renders circular dependency warnings when present", async () => {
    const analysis = makeAnalysis({
      circularDeps: [{ chain: ["a.ts", "b.ts", "a.ts"], severity: 1 }],
    });
    const rules = await buildCursorRules(makeCtx(), makeAnswers(), analysis);
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("## Circular Dependencies");
    expect(global.body).toContain("a.ts -> b.ts -> a.ts");
  });

  it("renders type-only suffix for severity 0 circular deps", async () => {
    const analysis = makeAnalysis({
      circularDeps: [{ chain: ["x.ts", "y.ts", "x.ts"], severity: 0 }],
    });
    const rules = await buildCursorRules(makeCtx(), makeAnswers(), analysis);
    const global = rules.find((r) => r.filename === "global.md")!;
    expect(global.body).toContain("(type-only)");
  });
});

describe("renderCursorRule", () => {
  it("produces valid frontmatter with description and globs", () => {
    const output = renderCursorRule({
      filename: "global.md",
      description: "Universal project rules",
      globs: "**/*.{ts,tsx}",
      body: "# Global Rules\n\nSome content.",
    });

    expect(output).toContain("---");
    expect(output).toContain("description: Universal project rules");
    expect(output).toContain(`globs: "**/*.{ts,tsx}"`);
    // Body appears after frontmatter
    expect(output).toContain("# Global Rules");
    expect(output).toContain("Some content.");
  });

  it("starts and ends with correct structure", () => {
    const output = renderCursorRule({
      filename: "test.md",
      description: "Test rule",
      globs: "**/*.ts",
      body: "Body text",
    });
    const lines = output.split("\n");
    expect(lines[0]).toBe("---");
    expect(lines[1]).toBe("description: Test rule");
    expect(lines[2]).toBe(`globs: "**/*.ts"`);
    expect(lines[3]).toBe("---");
    expect(lines[4]).toBe("");
    expect(lines[5]).toBe("Body text");
    // Trailing newline
    expect(output.endsWith("\n")).toBe(true);
  });
});
