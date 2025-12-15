import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DetectedContext, ProjectConfig } from "../types.js";

// Track prompt calls for verification
const promptCalls: Array<{ type: string; args: unknown }> = [];
let cancelNext = false;
let mockResponses: Record<string, unknown> = {};

vi.mock("@clack/prompts", () => ({
  multiselect: async (opts: unknown) => {
    promptCalls.push({ type: "multiselect", args: opts });
    if (cancelNext) return Symbol.for("cancel");
    return mockResponses["multiselect"] ?? ["claude"];
  },
  confirm: async (opts: unknown) => {
    promptCalls.push({ type: "confirm", args: opts });
    if (cancelNext) return Symbol.for("cancel");
    return mockResponses["confirm"] ?? true;
  },
  text: async (opts: unknown) => {
    promptCalls.push({ type: "text", args: opts });
    if (cancelNext) return Symbol.for("cancel");
    // Return different values based on the prompt sequence
    const textCalls = promptCalls.filter((c) => c.type === "text");
    const index = textCalls.length - 1;
    const textResponses = (mockResponses["text"] as string[] | undefined) ?? ["CLI tool", "angular commit style"];
    return textResponses[index] ?? "";
  },
  select: async (opts: unknown) => {
    promptCalls.push({ type: "select", args: opts });
    if (cancelNext) return Symbol.for("cancel");
    return mockResponses["select"] ?? "auto";
  },
  isCancel: (value: unknown) => typeof value === "symbol",
  cancel: vi.fn(),
}));

vi.mock("../theme.js", () => ({
  theme: {
    text: (s: string) => s,
    soft: (s: string) => s,
    muted: (s: string) => s,
    accent: (s: string) => s,
    brand: (s: string) => s,
  },
}));

vi.mock("../detect/detect.js", () => ({
  summarizeDetection: () => "TypeScript + React + Vitest",
}));

import { runPrompts } from "../cli/prompts.js";

function makeDetected(overrides: Partial<DetectedContext> = {}): DetectedContext {
  return {
    rootDir: "/tmp/test",
    language: "typescript",
    hasTypeScript: true,
    packageManager: "npm",
    linter: "eslint",
    frameworks: [{ name: "React" }],
    directories: ["src"],
    dependencies: ["react", "vitest"],
    isGitRepo: true,
    totalSourceBytes: 50000,
    sourceFileCount: 100,
    monorepo: null,
    ...overrides,
  };
}

beforeEach(() => {
  promptCalls.length = 0;
  cancelNext = false;
  mockResponses = {};
  vi.clearAllMocks();
});

describe("runPrompts", () => {
  it("returns correct UserAnswers shape from basic flow", async () => {
    mockResponses = {
      multiselect: ["claude", "cursor"],
      text: ["A CLI tool for testing", "use vitest"],
    };

    const result = await runPrompts(makeDetected());

    expect(result.ides).toEqual(["claude", "cursor"]);
    expect(result.projectPurpose).toBe("A CLI tool for testing");
    expect(result.keyPatterns).toBe("use vitest");
    expect(result.generateSnapshot).toBe(true); // auto-enabled for TS
    expect(result.generatePerPackage).toBe(false);
    expect(result.stackConfirmed).toBe(true);
    expect(result.stackCorrections).toBe("");
  });

  it("shows stack corrections prompt on reconfigure", async () => {
    mockResponses = {
      multiselect: ["claude"],
      confirm: false,
      text: ["It's actually Next.js", "My tool", "patterns"],
    };

    const result = await runPrompts(makeDetected(), null, true);

    // Should have prompted for stack confirmation
    const confirmCall = promptCalls.find((c) => c.type === "confirm");
    expect(confirmCall).toBeDefined();

    // When user says "No" to stack confirmation, should ask for corrections
    expect(result.stackConfirmed).toBe(false);
    expect(result.stackCorrections).toBeTruthy();
  });

  it("exits on cancel during IDE selection", async () => {
    cancelNext = true;
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit");
    }) as never);

    await expect(runPrompts(makeDetected())).rejects.toThrow("process.exit");
    expect(exitSpy).toHaveBeenCalledWith(0);

    exitSpy.mockRestore();
  });

  it("disables snapshot for unsupported languages", async () => {
    mockResponses = {
      multiselect: ["claude"],
      text: ["A Ruby app", ""],
    };

    const result = await runPrompts(makeDetected({ language: "ruby" }));

    expect(result.generateSnapshot).toBe(false);
  });

  it("enables snapshot auto for supported languages (python)", async () => {
    mockResponses = {
      multiselect: ["claude"],
      text: ["A Python app", ""],
    };

    const result = await runPrompts(makeDetected({ language: "python" }));

    expect(result.generateSnapshot).toBe(true);
    expect(result.snapshotPaths).toEqual([]);
  });

  it("shows monorepo per-package prompt when packages detected", async () => {
    mockResponses = {
      multiselect: ["claude"],
      confirm: true,
      text: ["A monorepo", ""],
    };

    const detected = makeDetected({
      monorepo: {
        type: "pnpm-workspaces",
        packages: [
          { name: "core", path: "packages/core", dependencies: [], frameworks: [] },
          { name: "web", path: "packages/web", dependencies: [], frameworks: [] },
        ],
      },
    });

    const result = await runPrompts(detected);

    // Should have asked about per-package generation
    const confirmCalls = promptCalls.filter((c) => c.type === "confirm");
    expect(confirmCalls.length).toBeGreaterThanOrEqual(1);
    expect(result.generatePerPackage).toBe(true);
  });

  it("does not show monorepo prompt when no monorepo detected", async () => {
    mockResponses = {
      multiselect: ["claude"],
      text: ["A simple app", ""],
    };

    const result = await runPrompts(makeDetected({ monorepo: null }));

    expect(result.generatePerPackage).toBe(false);
    // No confirm call for monorepo
    const confirmCalls = promptCalls.filter((c) => c.type === "confirm");
    expect(confirmCalls).toHaveLength(0);
  });

  it("uses defaults from existing config", async () => {
    const defaults: ProjectConfig = {
      ides: ["cursor"],
      projectPurpose: "My existing project",
      keyPatterns: "use pnpm",
      gotchas: "watch out for X",
      generateSnapshot: true,
      snapshotPaths: ["src/types"],
      stackCorrections: "",
      generatePerPackage: false,
    };

    mockResponses = {
      multiselect: ["cursor"],
      text: ["My existing project", "use pnpm\nGotchas: watch out for X"],
    };

    const result = await runPrompts(makeDetected(), defaults);

    expect(result.ides).toEqual(["cursor"]);
    expect(result.generateSnapshot).toBe(true);
  });
});
