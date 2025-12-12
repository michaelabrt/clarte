import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ContextAnalysis, GeneratedFile, CodeSnapshot } from "../types.js";

// Mock @clack/prompts to capture log calls
const logCalls: Array<{ method: string; args: unknown[] }> = [];
vi.mock("@clack/prompts", () => ({
  log: {
    info: (...args: unknown[]) => logCalls.push({ method: "info", args }),
    message: (...args: unknown[]) => logCalls.push({ method: "message", args }),
    success: (...args: unknown[]) => logCalls.push({ method: "success", args }),
    warn: (...args: unknown[]) => logCalls.push({ method: "warn", args }),
  },
}));

// Mock theme to strip ANSI -- return plain text
vi.mock("../theme.js", () => ({
  theme: {
    brandBold: (s: string) => s,
    textBold: (s: string) => s,
    text: (s: string) => s,
    muted: (s: string) => s,
    success: (s: string) => s,
    warn: (s: string) => s,
    brand: (s: string) => s,
    accent: (s: string) => s,
  },
}));

import { printSummary } from "../summary.js";

function allOutput(): string {
  return logCalls.map((c) => String(c.args[0])).join("\n");
}

function makeFile(filePath: string, content: string, existed = false): GeneratedFile {
  return { path: filePath, content, existed };
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

beforeEach(() => {
  logCalls.length = 0;
});

describe("printSummary", () => {
  it("returns early with no log calls for empty file list", () => {
    printSummary([]);
    expect(logCalls).toHaveLength(0);
  });

  it("renders a single main file with bytes and token estimate", () => {
    const content = "x".repeat(1000);
    printSummary([makeFile(".claude/rules/clarte.md", content)]);

    const output = allOutput();
    expect(output).toContain("clarte.md");
    expect(output).toContain("1000 B");
    expect(output).toContain("tokens");
    expect(output).toContain("(new)");
  });

  it("marks existing files as (updated)", () => {
    printSummary([makeFile(".claude/rules/clarte.md", "hello", true)]);
    const output = allOutput();
    expect(output).toContain("(updated)");
  });

  it("groups cursor rule files under .cursor/rules/ header", () => {
    printSummary([
      makeFile(".claude/rules/clarte.md", "main content"),
      makeFile(".cursor/rules/global.md", "global rule"),
      makeFile(".cursor/rules/testing.md", "test rule"),
    ]);

    const output = allOutput();
    expect(output).toContain(".cursor/rules/");
    expect(output).toContain("global.md");
    expect(output).toContain("testing.md");
  });

  it("shows budget exclusion warning when budgetExcluded > 0", () => {
    const snapshot: CodeSnapshot = {
      entries: [],
      markdown: "",
      budgetExcluded: 5,
    };
    printSummary([makeFile(".claude/rules/clarte.md", "content")], snapshot);

    const output = allOutput();
    expect(output).toContain("5 snapshot entries excluded by token budget");
  });

  it("does not show budget warning when budgetExcluded is 0", () => {
    const snapshot: CodeSnapshot = {
      entries: [],
      markdown: "",
      budgetExcluded: 0,
    };
    printSummary([makeFile(".claude/rules/clarte.md", "content")], snapshot);

    const output = allOutput();
    expect(output).not.toContain("snapshot entries excluded");
  });

  it("shows circular dependency findings", () => {
    const analysis = makeAnalysis({
      circularDeps: [{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"] }, { chain: ["src/c.ts", "src/d.ts", "src/c.ts"] }],
    });
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, analysis);

    const output = allOutput();
    expect(output).toContain("2");
    expect(output).toContain("circular dependency chain");
    expect(output).toContain("2 finding");
  });

  it("shows single circular dependency with file names", () => {
    const analysis = makeAnalysis({
      circularDeps: [{ chain: ["src/a.ts", "src/b.ts", "src/a.ts"] }],
    });
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, analysis);

    const output = allOutput();
    expect(output).toContain("1 circular dependency chain");
    // Should show the short file names
    expect(output).toContain("a");
    expect(output).toContain("b");
  });

  it("shows high instability files above INSTABILITY_THRESHOLD", () => {
    const analysis = makeAnalysis({
      instabilities: [
        { path: "src/solid.ts", fanIn: 10, fanOut: 1, instability: 0.1 },
        { path: "src/unstable.ts", fanIn: 1, fanOut: 10, instability: 0.91 },
        { path: "src/veryUnstable.ts", fanIn: 0, fanOut: 5, instability: 0.95 },
      ],
    });
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, analysis);

    const output = allOutput();
    expect(output).toContain("2");
    expect(output).toContain("high-instability file");
    expect(output).toContain("unstable.ts");
    expect(output).toContain("veryUnstable.ts");
    expect(output).not.toContain("solid.ts");
  });

  it("shows layer violation findings", () => {
    const analysis = makeAnalysis({
      layerConsistency: {
        consistency: 0.8,
        violations: [
          { from: "src/a.ts", to: "src/b.ts", fromLayer: "types", toLayer: "pages" },
          { from: "src/c.ts", to: "src/d.ts", fromLayer: "stores", toLayer: "components" },
        ],
      },
    });
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, analysis);

    const output = allOutput();
    expect(output).toContain("2");
    expect(output).toContain("layer dependency violation");
  });

  it("shows success message when no findings", () => {
    const analysis = makeAnalysis();
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, analysis);

    const output = allOutput();
    expect(output).toContain("No structural issues detected");
  });

  it("shows first-run benchmark footer", () => {
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, undefined, true);

    const output = allOutput();
    expect(output).toContain("reduced agent input tokens by 60%");
    expect(output).toContain("clarte-benchmark");
  });

  it("does not show benchmark footer when not first run", () => {
    printSummary([makeFile(".claude/rules/clarte.md", "content")], null, undefined, false);

    const output = allOutput();
    expect(output).not.toContain("reduced agent input tokens");
  });

  it("shows total bytes and tokens across all files", () => {
    printSummary([makeFile(".claude/rules/clarte.md", "x".repeat(500)), makeFile("AGENTS.md", "y".repeat(500))]);

    const output = allOutput();
    // Total should be ~1000 B
    expect(output).toContain("Total:");
    expect(output).toContain("1000 B");
  });
});
