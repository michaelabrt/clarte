import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClarteError } from "../errors.js";

// Mock heavy dependencies
vi.mock("../cli/animations.js", () => ({
  startShimmer: () => ({
    message: vi.fn(),
    stop: vi.fn(),
  }),
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

vi.mock("../detect/detect.js", () => ({
  detectContext: (...args: unknown[]) => mockDetectContext(...args),
}));

const mockBuildImportGraph = vi.fn().mockResolvedValue({
  edges: [],
  inDegree: new Map(),
  centrality: new Map(),
  externalImportCounts: new Map(),
  authority: new Map(),
  hubScores: new Map(),
});

vi.mock("../graph.js", () => ({
  buildImportGraph: (...args: unknown[]) => mockBuildImportGraph(...args),
}));

const mockGenerateSnapshot = vi.fn().mockResolvedValue({
  entries: [{ file: "src/types.ts", category: "type", signature: "interface Foo {}" }],
  markdown: "## Types\n\n```ts\ninterface Foo {}\n```",
  budgetExcluded: 0,
});

vi.mock("../snapshot/snapshot.js", () => ({
  generateSnapshot: (...args: unknown[]) => mockGenerateSnapshot(...args),
}));

vi.mock("../config/config.js", () => ({
  loadConfig: vi.fn().mockResolvedValue(null),
  saveConfig: vi.fn(),
  configToAnswers: vi.fn().mockReturnValue({}),
  computeSnapshotHash: vi.fn().mockResolvedValue("abc123"),
}));

// Track clack log calls
const logCalls: Array<{ method: string; args: unknown[] }> = [];
const exitSpy = vi.fn();

vi.mock("@clack/prompts", () => ({
  log: {
    info: (...args: unknown[]) => logCalls.push({ method: "info", args }),
    message: (...args: unknown[]) => logCalls.push({ method: "message", args }),
    success: (...args: unknown[]) => logCalls.push({ method: "success", args }),
    warn: (...args: unknown[]) => logCalls.push({ method: "warn", args }),
    error: (...args: unknown[]) => logCalls.push({ method: "error", args }),
    step: (...args: unknown[]) => logCalls.push({ method: "step", args }),
  },
}));

vi.mock("../theme.js", () => ({
  theme: {
    text: (s: string) => s,
    accent: (s: string) => s,
    textBold: (s: string) => s,
    muted: (s: string) => s,
    brand: (s: string) => s,
  },
}));

import { refreshSnapshot } from "../modes/refresh.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-refresh-"));
  logCalls.length = 0;
  vi.clearAllMocks();
  exitSpy.mockReset();
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("refreshSnapshot", () => {
  it("throws ClarteError when no context file found", async () => {
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow(ClarteError);
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow("No context file found");
  });

  it("replaces markdown snapshot between markers", async () => {
    const original = [
      "# My Project",
      "",
      "## Code Snapshot",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old snapshot content here",
      "",
      "<!-- /CODE SNAPSHOT -->",
      "",
      "## Other Section",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), original);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, ".claude/rules/clarte.md"), "utf-8");

    // Should contain the new snapshot
    expect(updated).toContain("interface Foo {}");
    // Should preserve other sections
    expect(updated).toContain("# My Project");
    expect(updated).toContain("## Other Section");
    // Old content should be gone
    expect(updated).not.toContain("Old snapshot content here");
  });

  it("replaces aider YAML snapshot between markers", async () => {
    const original = [
      "read:",
      "  - README.md",
      "",
      "# --- Code Snapshot (for reference) ---",
      "# Old snapshot",
      "# --- /Code Snapshot ---",
      "",
      "extra-config: true",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, ".aider.conf.yml"), original);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, ".aider.conf.yml"), "utf-8");

    // Should contain new snapshot in YAML comment format
    expect(updated).toContain("# --- Code Snapshot");
    expect(updated).toContain("# --- /Code Snapshot ---");
    // Should preserve surrounding config
    expect(updated).toContain("read:");
    expect(updated).toContain("extra-config: true");
    // Old content should be gone
    expect(updated).not.toContain("# Old snapshot");
  });

  it("throws budget-trimmed error message", async () => {
    // File with "Sections omitted" and "code-snapshot" but no markers
    const content = ["# Project", "", "<!-- Sections omitted to fit token budget: code-snapshot. -->"].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await expect(refreshSnapshot(tmpDir)).rejects.toThrow(ClarteError);
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow("omitted");
  });
});
