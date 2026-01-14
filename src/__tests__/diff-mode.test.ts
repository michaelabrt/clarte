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

const mockGitExec = vi.fn();
const mockGitExecSafe = vi.fn();
vi.mock("../git/git.js", () => ({
  gitExec: (...args: unknown[]) => mockGitExec(...args),
  gitExecSafe: (...args: unknown[]) => mockGitExecSafe(...args),
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

function setupGitMocks(nameOnlyOutput: string, numstatOutput: string | null = "") {
  mockGitExec.mockImplementation((args: string[]) => {
    if (args.includes("--name-only")) return nameOnlyOutput;
    return "";
  });
  mockGitExecSafe.mockImplementation((args: string[]) => {
    if (args.includes("--numstat")) return numstatOutput;
    return null;
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
    setupGitMocks("src/foo.ts\nsrc/bar.ts", "10\t2\tsrc/foo.ts\n5\t1\tsrc/bar.ts");

    await runDiffMode("/tmp/test");

    expect(mockDetectContext).toHaveBeenCalled();
    expect(mockBuildGraphWithCache).toHaveBeenCalled();
  });

  it("parses numstat without double-counting", async () => {
    setupGitMocks("src/foo.ts", "10\t2\tsrc/foo.ts");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    // Verify gitExec called with --name-only and gitExecSafe with --numstat
    expect(mockGitExec).toHaveBeenCalledWith(
      expect.arrayContaining(["diff", "--name-only", "HEAD"]),
      expect.any(Object),
    );
    expect(mockGitExecSafe).toHaveBeenCalledWith(
      expect.arrayContaining(["diff", "--numstat", "HEAD"]),
      expect.any(Object),
    );

    // Verify the output includes the stat (not doubled)
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("+10 / -2");
    expect(output).not.toContain("+20");

    stdoutWrite.mockRestore();
  });

  it("handles empty diff gracefully", async () => {
    setupGitMocks("");

    await runDiffMode("/tmp/test");

    const infoLogs = logCalls.filter((c) => c.method === "info");
    expect(infoLogs.some((c) => String(c.args[0]).includes("No changed files"))).toBe(true);
    expect(mockBuildGraphWithCache).not.toHaveBeenCalled();
  });

  it("uses ref parameter for three-dot diff", async () => {
    setupGitMocks("src/foo.ts", "5\t1\tsrc/foo.ts");

    await runDiffMode("/tmp/test", "main");

    expect(mockGitExec).toHaveBeenCalledWith(
      ["diff", "--name-only", "main...HEAD"],
      expect.any(Object),
    );
    expect(mockGitExecSafe).toHaveBeenCalledWith(
      ["diff", "--numstat", "main...HEAD"],
      expect.any(Object),
    );
  });

  it("throws ClarteError for bad ref", async () => {
    mockGitExec.mockImplementation(() => {
      throw new Error("unknown revision 'nope'");
    });

    await expect(runDiffMode("/tmp/test", "nope")).rejects.toThrow(ClarteError);
  });

  it("throws ClarteError for non-git repo", async () => {
    mockGitExec.mockImplementation(() => {
      throw new Error("not a git repository");
    });

    await expect(runDiffMode("/tmp/test")).rejects.toThrow(ClarteError);
  });

  it("rejects invalid ref characters (shell injection prevention)", async () => {
    setupGitMocks("");

    await runDiffMode("/tmp/test", "$(whoami)");

    const errorLogs = logCalls.filter((c) => c.method === "error");
    expect(errorLogs.length).toBeGreaterThan(0);
    expect(mockGitExec).not.toHaveBeenCalled();
  });

  it("writes to output file when specified", async () => {
    setupGitMocks("src/foo.ts", "3\t1\tsrc/foo.ts");
    const { writeFileSafe } = await import("../utils.js");

    await runDiffMode("/tmp/test", undefined, false, "diff-context.md");

    expect(writeFileSafe).toHaveBeenCalled();
  });

  it("deduplicates changed files from git output", async () => {
    setupGitMocks("src/foo.ts\nsrc/foo.ts\nsrc/bar.ts");
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    const stepLogs = logCalls.filter((c) => c.method === "step");
    expect(stepLogs.some((c) => String(c.args[0]).includes("2 changed file"))).toBe(true);

    stdoutWrite.mockRestore();
  });

  it("handles numstat failure gracefully (optional line counts)", async () => {
    setupGitMocks("src/foo.ts", null);
    const stdoutWrite = vi.spyOn(process.stdout, "write").mockReturnValue(true);

    await runDiffMode("/tmp/test");

    // Should still succeed, just without line counts
    expect(mockBuildGraphWithCache).toHaveBeenCalled();

    stdoutWrite.mockRestore();
  });
});
