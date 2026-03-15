import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ClarteError } from "../core/errors.js";
import { makeDetectedContext } from "./helpers/mocks.js";

// Mock heavy dependencies
vi.mock("../cli/animations.js", () => ({
  startShimmer: () => ({
    message: vi.fn(),
    stop: vi.fn(),
  }),
}));

const mockDetectContext = vi.fn().mockResolvedValue(makeDetectedContext());

vi.mock("../core/detect/detect.js", () => ({
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
const mockMergeGraph = vi.fn();

vi.mock("../core/graph/build.js", () => ({
  buildImportGraph: (...args: unknown[]) => mockBuildImportGraph(...args),
  mergeGraph: (...args: unknown[]) => mockMergeGraph(...args),
}));

const mockGenerateSnapshot = vi.fn().mockResolvedValue({
  entries: [{ file: "src/types.ts", category: "type", signature: "interface Foo {}" }],
  markdown: "## Types\n\n```ts\ninterface Foo {}\n```",
  budgetExcluded: 0,
});

vi.mock("../core/snapshot/snapshot.js", () => ({
  generateSnapshot: (...args: unknown[]) => mockGenerateSnapshot(...args),
}));

const mockLoadConfig = vi.fn().mockResolvedValue(null);
const mockSaveConfig = vi.fn();
const mockConfigToAnswers = vi.fn().mockReturnValue({});
const mockComputeSnapshotHash = vi.fn().mockResolvedValue("abc123");

vi.mock("../core/config/config.js", () => ({
  loadConfig: (...args: unknown[]) => mockLoadConfig(...args),
  saveConfig: (...args: unknown[]) => mockSaveConfig(...args),
  configToAnswers: (...args: unknown[]) => mockConfigToAnswers(...args),
  computeSnapshotHash: (...args: unknown[]) => mockComputeSnapshotHash(...args),
}));

// Track clack log calls
const clackMock = vi.hoisted(() => ({
  logCalls: [] as Array<{ method: string; args: unknown[] }>,
}));
const exitSpy = vi.fn();

vi.mock("@clack/prompts", async () => {
  const { createClackMock } = await import("./helpers/mocks.js");
  const m = createClackMock({ captureLogs: true });
  clackMock.logCalls = m.logCalls;
  return m.mock;
});

vi.mock("../core/theme.js", async () => {
  const { THEME_MOCK } = await import("./helpers/mocks.js");
  return { theme: THEME_MOCK };
});

import { refreshSnapshot } from "../cli/refresh.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-refresh-"));
  clackMock.logCalls.length = 0;
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

  it("throws budget-trimmed error message", async () => {
    // File with "Sections omitted" and "code-snapshot" but no markers
    const content = ["# Project", "", "<!-- Sections omitted to fit token budget: code-snapshot. -->"].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await expect(refreshSnapshot(tmpDir)).rejects.toThrow(ClarteError);
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow("omitted");
  });

  it("throws when markers are missing and no budget omission text", async () => {
    const content = ["# Project", "", "Some content without markers"].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await expect(refreshSnapshot(tmpDir)).rejects.toThrow(ClarteError);
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow("No code snapshot markers found");
  });

  it("finds AGENTS.md when .claude/rules/clarte.md does not exist", async () => {
    const content = [
      "# Agents",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old agents snapshot",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.writeFile(path.join(tmpDir, "AGENTS.md"), content);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, "AGENTS.md"), "utf-8");
    expect(updated).toContain("interface Foo {}");
    expect(updated).not.toContain("Old agents snapshot");
  });

  it("handles empty snapshot (0 entries)", async () => {
    mockGenerateSnapshot.mockResolvedValueOnce({
      entries: [],
      markdown: "",
      budgetExcluded: 0,
    });

    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old snapshot",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, ".claude/rules/clarte.md"), "utf-8");
    // Empty markdown means no snapshot body between markers
    expect(updated).toContain("<!-- CODE SNAPSHOT");
    expect(updated).toContain("<!-- /CODE SNAPSHOT -->");
    expect(updated).not.toContain("Old snapshot");
    // Verify warn was called for empty snapshot
    const warnCalls = clackMock.logCalls.filter((c) => c.method === "warn");
    expect(warnCalls.length).toBeGreaterThan(0);
  });

  it("merges secondary language graphs", async () => {
    mockDetectContext.mockResolvedValueOnce(makeDetectedContext({ secondaryLanguages: ["python", "go"] }));

    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    // Primary + 2 secondary = 3 buildImportGraph calls
    expect(mockBuildImportGraph).toHaveBeenCalledTimes(3);
    // mergeGraph called once per secondary language
    expect(mockMergeGraph).toHaveBeenCalledTimes(2);
  });

  it("updates config hash when config exists", async () => {
    mockLoadConfig.mockResolvedValueOnce({
      ides: ["claude"],
      projectPurpose: "test",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: true,
      snapshotPaths: ["src/types"],
      stackCorrections: "",
      generatePerPackage: false,
      language: "typescript",
    });

    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    expect(mockSaveConfig).toHaveBeenCalledTimes(1);
    expect(mockComputeSnapshotHash).toHaveBeenCalledTimes(1);
    expect(mockConfigToAnswers).toHaveBeenCalledTimes(1);
  });

  it("does not save config when no config file exists", async () => {
    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    // loadConfig returns null by default, so saveConfig should not be called
    expect(mockSaveConfig).not.toHaveBeenCalled();
  });

  it("passes snapshotPaths from config to generateSnapshot", async () => {
    mockLoadConfig.mockResolvedValueOnce({
      ides: ["claude"],
      projectPurpose: "test",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: true,
      snapshotPaths: ["src/types", "src/models"],
      stackCorrections: "",
      generatePerPackage: false,
    });

    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    // generateSnapshot should receive the snapshotPaths from config
    expect(mockGenerateSnapshot).toHaveBeenCalledWith(
      expect.anything(),
      ["src/types", "src/models"],
      expect.anything(),
      undefined,
      expect.any(Function),
    );
  });

  it("preserves content before and after snapshot markers", async () => {
    const content = [
      "# Header",
      "",
      "Preamble text here.",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "stale data",
      "",
      "<!-- /CODE SNAPSHOT -->",
      "",
      "## Footer",
      "",
      "Important notes below.",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, ".claude/rules/clarte.md"), "utf-8");
    expect(updated).toContain("# Header");
    expect(updated).toContain("Preamble text here.");
    expect(updated).toContain("## Footer");
    expect(updated).toContain("Important notes below.");
    expect(updated).not.toContain("stale data");
  });

  it("handles only start marker present (missing end marker)", async () => {
    const content = [
      "# Project",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Dangling snapshot with no end marker",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".claude", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".claude/rules/clarte.md"), content);

    await expect(refreshSnapshot(tmpDir)).rejects.toThrow(ClarteError);
    await expect(refreshSnapshot(tmpDir)).rejects.toThrow("No code snapshot markers");
  });

  it("finds .cursor/rules/clarte.md as fallback context file", async () => {
    const content = [
      "# Cursor",
      "",
      "<!-- CODE SNAPSHOT (auto-generated) -->",
      "",
      "Old cursor snapshot",
      "",
      "<!-- /CODE SNAPSHOT -->",
    ].join("\n");

    await fs.mkdir(path.join(tmpDir, ".cursor", "rules"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".cursor/rules/clarte.md"), content);

    await refreshSnapshot(tmpDir);

    const updated = await fs.readFile(path.join(tmpDir, ".cursor/rules/clarte.md"), "utf-8");
    expect(updated).toContain("interface Foo {}");
    expect(updated).not.toContain("Old cursor snapshot");
  });
});
