import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────

vi.mock("../cli/animations.js", () => ({
  startShimmer: () => ({
    message: vi.fn(),
    stop: vi.fn(),
  }),
}));

const logCalls: Array<{ method: string; args: unknown[] }> = [];

vi.mock("@clack/prompts", () => ({
  log: {
    info: (...args: unknown[]) => logCalls.push({ method: "info", args }),
    step: (...args: unknown[]) => logCalls.push({ method: "step", args }),
    warn: (...args: unknown[]) => logCalls.push({ method: "warn", args }),
    error: (...args: unknown[]) => logCalls.push({ method: "error", args }),
    message: (...args: unknown[]) => logCalls.push({ method: "message", args }),
    success: (...args: unknown[]) => logCalls.push({ method: "success", args }),
  },
  note: vi.fn(),
  outro: vi.fn(),
}));

vi.mock("../theme.js", () => ({
  theme: {
    text: (s: string) => s,
    textBold: (s: string) => s,
    accent: (s: string) => s,
    muted: (s: string) => s,
    brand: (s: string) => s,
    warn: (s: string) => s,
    success: (s: string) => s,
    error: (s: string) => s,
    check: () => "✓",
    bold: (s: string) => s,
    soft: (s: string) => s,
  },
  unpatchPicocolors: vi.fn(),
}));

const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

const mockDetectContext = vi.fn().mockResolvedValue({
  rootDir: "/tmp/test",
  language: "typescript",
  hasTypeScript: true,
  packageManager: "npm",
  linter: "eslint",
  frameworks: [],
  directories: ["src"],
  dependencies: [],
  isGitRepo: true,
  totalSourceBytes: 10000,
  sourceFileCount: 50,
  monorepo: null,
});
const mockEnrichFrameworksWithUsage = vi.fn().mockReturnValue([]);

vi.mock("../detect/detect.js", () => ({
  detectContext: (...args: unknown[]) => mockDetectContext(...args),
  enrichFrameworksWithUsage: (...args: unknown[]) => mockEnrichFrameworksWithUsage(...args),
}));

const mockBuildGraphWithCache = vi.fn().mockResolvedValue({
  edges: [],
  inDegree: new Map(),
  directInDegree: new Map(),
  centrality: new Map(),
  externalImportCounts: new Map(),
  authority: new Map(),
  hubScores: new Map(),
});
const mockBuildImportGraph = vi.fn().mockResolvedValue({
  edges: [],
  inDegree: new Map(),
  centrality: new Map(),
  externalImportCounts: new Map(),
  authority: new Map(),
  hubScores: new Map(),
});
const mockMergeGraph = vi.fn();

vi.mock("../graph/cache.js", () => ({
  buildGraphWithCache: (...args: unknown[]) => mockBuildGraphWithCache(...args),
}));
vi.mock("../graph/build.js", () => ({
  buildImportGraph: (...args: unknown[]) => mockBuildImportGraph(...args),
  mergeGraph: (...args: unknown[]) => mockMergeGraph(...args),
}));

const mockGetHubFiles = vi.fn().mockReturnValue([]);
vi.mock("../graph/hub-files.js", () => ({
  getHubFiles: (...args: unknown[]) => mockGetHubFiles(...args),
}));

const mockFindCircularDeps = vi.fn().mockReturnValue([]);
vi.mock("../graph/cycles.js", () => ({
  findCircularDeps: (...args: unknown[]) => mockFindCircularDeps(...args),
}));

vi.mock("../graph/layers.js", () => ({
  detectArchitecturalLayers: vi.fn().mockReturnValue({ layers: [], layerEdges: [] }),
}));

vi.mock("../graph/instability.js", () => ({
  computeInstability: vi.fn().mockReturnValue([]),
}));

vi.mock("../graph/communities.js", () => ({
  detectCommunities: vi.fn().mockReturnValue([]),
}));

const mockAnalyzeGitActivity = vi.fn().mockReturnValue(null);
vi.mock("../git/analysis.js", () => ({
  analyzeGitActivity: (...args: unknown[]) => mockAnalyzeGitActivity(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue(null),
}));

vi.mock("../analysis/test-map.js", () => ({
  buildTestMapping: vi.fn().mockReturnValue(null),
}));

const mockGenerateSnapshot = vi.fn().mockResolvedValue({
  entries: [],
  markdown: "",
  budgetExcluded: 0,
});
vi.mock("../snapshot/snapshot.js", () => ({
  generateSnapshot: (...args: unknown[]) => mockGenerateSnapshot(...args),
}));

vi.mock("../templates/directives.js", () => ({
  buildDirectives: vi.fn().mockReturnValue([]),
}));

vi.mock("../utils.js", () => ({
  writeFileSafe: vi.fn().mockResolvedValue(undefined),
}));

// ── Import under test (after mocks) ────────────────────────────────

import { runDiffMode } from "../modes/diff.js";
import { ClarteError } from "../errors.js";

// ── Helpers ─────────────────────────────────────────────────────────

function setupExecSync(nameOnlyOutput: string, numstatOutput = "") {
  mockExecSync.mockImplementation((cmd: string) => {
    if (typeof cmd === "string" && cmd.includes("--name-only")) return nameOnlyOutput;
    if (typeof cmd === "string" && cmd.includes("--numstat")) return numstatOutput;
    return "";
  });
}

// ── Tests ───────────────────────────────────────────────────────────

beforeEach(() => {
  logCalls.length = 0;
  vi.clearAllMocks();
  mockDetectContext.mockResolvedValue({
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 10000,
    sourceFileCount: 50,
    monorepo: null,
  });
});

describe("runDiffMode", () => {
  it("detects changed files from git output", async () => {
    setupExecSync("src/foo.ts\nsrc/bar.ts", "10\t2\tsrc/foo.ts\n5\t1\tsrc/bar.ts");

    await runDiffMode("/tmp/test");

    expect(mockDetectContext).toHaveBeenCalled();
    expect(mockBuildGraphWithCache).toHaveBeenCalled();
  });

  it("parses numstat without double-counting", async () => {
    // The fix: only one --numstat call, no accumulation from --cached/bare
    setupExecSync("src/foo.ts", "10\t2\tsrc/foo.ts");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    // Verify exactly two execSync calls: --name-only HEAD and --numstat HEAD
    const execCalls = mockExecSync.mock.calls.map((c) => c[0]);
    expect(execCalls).toHaveLength(2);
    expect(execCalls[0]).toBe("git diff --name-only HEAD");
    expect(execCalls[1]).toBe("git diff --numstat HEAD");

    // Verify the output includes the stat (not doubled)
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("+10 / -2");
    // Should NOT contain doubled values like +20 / -4
    expect(output).not.toContain("+20");

    stdoutWrite.mockRestore();
  });

  it("handles empty diff gracefully", async () => {
    setupExecSync("");

    await runDiffMode("/tmp/test");

    const infoLogs = logCalls.filter((c) => c.method === "info");
    expect(infoLogs.some((c) => String(c.args[0]).includes("No changed files"))).toBe(true);
    // Should not proceed to graph building
    expect(mockBuildGraphWithCache).not.toHaveBeenCalled();
  });

  it("uses ref parameter for three-dot diff", async () => {
    setupExecSync("src/foo.ts", "5\t1\tsrc/foo.ts");

    await runDiffMode("/tmp/test", "main");

    const execCalls = mockExecSync.mock.calls.map((c) => c[0]);
    expect(execCalls[0]).toBe("git diff --name-only main...HEAD");
    expect(execCalls[1]).toBe("git diff --numstat main...HEAD");
  });

  it("throws ClarteError for bad ref", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("unknown revision 'nope'");
    });

    await expect(runDiffMode("/tmp/test", "nope")).rejects.toThrow(ClarteError);
  });

  it("throws ClarteError for non-git repo", async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    await expect(runDiffMode("/tmp/test")).rejects.toThrow(ClarteError);
  });

  it("rejects invalid ref characters (shell injection prevention)", async () => {
    setupExecSync("");

    await runDiffMode("/tmp/test", "$(whoami)");

    // Should log an error and return early
    const errorLogs = logCalls.filter((c) => c.method === "error");
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("writes to output file when specified", async () => {
    setupExecSync("src/foo.ts", "3\t1\tsrc/foo.ts");
    const { writeFileSafe } = await import("../utils.js");

    await runDiffMode("/tmp/test", undefined, false, "diff-context.md");

    expect(writeFileSafe).toHaveBeenCalled();
  });

  it("deduplicates changed files from git output", async () => {
    setupExecSync("src/foo.ts\nsrc/foo.ts\nsrc/bar.ts");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    // The step log should say 2 files, not 3
    const stepLogs = logCalls.filter((c) => c.method === "step");
    expect(stepLogs.some((c) => String(c.args[0]).includes("2 changed file"))).toBe(true);

    stdoutWrite.mockRestore();
  });

  it("handles numstat failure gracefully (optional line counts)", async () => {
    mockExecSync.mockImplementation((cmd: string) => {
      if (typeof cmd === "string" && cmd.includes("--name-only")) return "src/foo.ts";
      if (typeof cmd === "string" && cmd.includes("--numstat")) throw new Error("numstat failed");
      return "";
    });
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    // Should still succeed, just without line counts
    expect(mockBuildGraphWithCache).toHaveBeenCalled();

    stdoutWrite.mockRestore();
  });
});
