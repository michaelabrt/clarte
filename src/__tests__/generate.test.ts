import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import type { DetectedContext, UserAnswers } from "../types.js";

// Mock template builders
vi.mock("../templates/main-context.js", () => ({
  buildMainContext: vi.fn().mockResolvedValue("# Main Context\n\nGenerated content here."),
  getMainContextFilename: vi.fn((ide: string) => {
    switch (ide) {
      case "claude":
        return ".claude/rules/clarte.md";
      case "cursor":
        return ".cursor/rules/clarte.md";
      case "opencode":
        return "AGENTS.md";
      case "copilot":
        return ".github/copilot-instructions.md";
      case "windsurf":
        return ".windsurfrules";
      case "cline":
        return ".clinerules";
      case "continue":
        return ".continuerules";
      case "generic":
        return "CONTEXT.md";
      default:
        return ".claude/rules/clarte.md";
    }
  }),
}));

vi.mock("../templates/claude-skills.js", () => ({
  buildClaudeSkills: vi.fn().mockResolvedValue([]),
  renderClaudeSkill: vi.fn(() => ""),
}));

vi.mock("../detect/detect.js", () => ({
  detectContext: vi.fn().mockResolvedValue({
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [],
    directories: [],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 0,
    sourceFileCount: 0,
    monorepo: null,
  }),
}));

vi.mock("../snapshot/snapshot.js", () => ({
  generateSnapshot: vi.fn().mockResolvedValue({
    entries: [],
    markdown: "",
    budgetExcluded: 0,
  }),
}));

// Mock @clack/prompts
vi.mock("@clack/prompts", async () => {
  const { createClackMock } = await import("./helpers/mocks.js");
  return createClackMock().mock;
});

vi.mock("../theme.js", async () => {
  const { THEME_MOCK } = await import("./helpers/mocks.js");
  return { theme: THEME_MOCK };
});

import { generateFiles, extractUserSections, mergeUserSections } from "../core/generate.js";

let tmpDir: string;

function makeCtx(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: tmpDir,
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [],
    directories: ["src"],
    dependencies: [],
    isGitRepo: true,
    totalSourceBytes: 50000,
    sourceFileCount: 100,
    monorepo: null,
    ...overrides,
  };
}

function makeAnswers(overrides: Partial<UserAnswers> = {}): UserAnswers {
  return {
    ides: ["claude"],
    projectPurpose: "A test project",
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

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-gen-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("generateFiles", () => {
  it("produces .claude/rules/clarte.md for claude target", async () => {
    const files = await generateFiles(
      makeCtx(),
      makeAnswers({ ides: ["claude"] }),
      null,
      true, // yes
      true, // dryRun
    );

    expect(files.length).toBeGreaterThanOrEqual(1);
    const claudeFile = files.find((f) => f.path === ".claude/rules/clarte.md");
    expect(claudeFile).toBeDefined();
    expect(claudeFile?.content).toContain("Main Context");
  });

  it("produces MCP config and pre-flight agent for cursor target", async () => {
    const files = await generateFiles(makeCtx(), makeAnswers({ ides: ["cursor"] }), null, true, true);

    const mainFile = files.find((f) => f.path === ".cursor/rules/clarte.md");
    expect(mainFile).toBeDefined();
    expect(mainFile?.content).not.toContain("alwaysApply: true");

    const mcpFile = files.find((f) => f.path === ".cursor/mcp.json");
    expect(mcpFile).toBeDefined();
    const mcpConfig = JSON.parse(mcpFile?.content);
    expect(mcpConfig.mcpServers.clarte.command).toBe("npx");
    expect(mcpConfig.mcpServers.clarte.args).toContain("--mcp");

    const agentFile = files.find((f) => f.path === ".cursor/agents/clarte-pre-flight.md");
    expect(agentFile).toBeDefined();
    expect(agentFile?.content).toContain("name: clarte-pre-flight");
  });

  it("dry run returns files without writing to disk", async () => {
    const files = await generateFiles(
      makeCtx(),
      makeAnswers(),
      null,
      true,
      true, // dryRun
    );

    expect(files.length).toBeGreaterThan(0);

    // Verify nothing was written
    const claudePath = path.join(tmpDir, ".claude/rules/clarte.md");
    await expect(fs.access(claudePath)).rejects.toThrow();
  });

  it("writes files to disk when not dry run", async () => {
    const files = await generateFiles(
      makeCtx(),
      makeAnswers(),
      null,
      true, // yes
      false, // not dryRun
    );

    expect(files.length).toBeGreaterThan(0);

    // Verify file was written
    const claudePath = path.join(tmpDir, ".claude/rules/clarte.md");
    const content = await fs.readFile(claudePath, "utf-8");
    expect(content).toContain("Main Context");
  });

  it("produces separate files for claude and cursor targets", async () => {
    const files = await generateFiles(makeCtx(), makeAnswers({ ides: ["claude", "cursor"] }), null, true, true);

    const claudeFile = files.find((f) => f.path === ".claude/rules/clarte.md");
    const cursorFile = files.find((f) => f.path === ".cursor/rules/clarte.md");
    expect(claudeFile).toBeDefined();
    expect(cursorFile).toBeDefined();
    expect(claudeFile?.path).not.toBe(cursorFile?.path);
  });
});

describe("extractUserSections", () => {
  it("extracts user section with markers", () => {
    const content = [
      "## Key Patterns",
      "",
      "<!-- clarte:user-start -->",
      "## My Custom Section",
      "Some custom content",
      "<!-- clarte:user-end -->",
      "",
      "## Other",
    ].join("\n");

    const sections = extractUserSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].content).toContain("My Custom Section");
    expect(sections[0].anchor).toBe("## Key Patterns");
  });

  it("returns empty array when no user sections", () => {
    const content = "# Project\n\nJust regular content.";
    expect(extractUserSections(content)).toHaveLength(0);
  });

  it("extracts multiple user sections", () => {
    const content = [
      "## Section A",
      "<!-- clarte:user-start -->",
      "Custom A",
      "<!-- clarte:user-end -->",
      "## Section B",
      "<!-- clarte:user-start -->",
      "Custom B",
      "<!-- clarte:user-end -->",
    ].join("\n");

    const sections = extractUserSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].content).toContain("Custom A");
    expect(sections[1].content).toContain("Custom B");
  });
});

describe("mergeUserSections", () => {
  it("inserts section after its anchor header", () => {
    const newContent = "## Key Patterns\n\nNew patterns\n\n## Other\n\nOther stuff";
    const sections = [
      {
        content: "<!-- clarte:user-start -->\nMy custom stuff\n<!-- clarte:user-end -->",
        anchor: "## Key Patterns",
      },
    ];

    const result = mergeUserSections(newContent, sections);
    expect(result).toContain("My custom stuff");
    // Custom section should appear before ## Other
    const customIdx = result.indexOf("My custom stuff");
    const otherIdx = result.indexOf("## Other");
    expect(customIdx).toBeLessThan(otherIdx);
  });

  it("appends at end when anchor not found", () => {
    const newContent = "## Different Header\n\nContent";
    const sections = [
      {
        content: "<!-- clarte:user-start -->\nOrphaned\n<!-- clarte:user-end -->",
        anchor: "## Missing Header",
      },
    ];

    const result = mergeUserSections(newContent, sections);
    expect(result).toContain("Orphaned");
    // Should be at the end
    expect(result.indexOf("Orphaned")).toBeGreaterThan(result.indexOf("Content"));
  });

  it("skips sections already present in new content", () => {
    const section = "<!-- clarte:user-start -->\nAlready here\n<!-- clarte:user-end -->";
    const newContent = `## Header\n\n${section}\n\n## Other`;
    const sections = [{ content: section, anchor: "## Header" }];

    const result = mergeUserSections(newContent, sections);
    // Should not be duplicated
    const count = (result.match(/Already here/g) ?? []).length;
    expect(count).toBe(1);
  });

  it("returns unchanged content for empty sections array", () => {
    const content = "# Hello\n\nWorld";
    expect(mergeUserSections(content, [])).toBe(content);
  });
});
