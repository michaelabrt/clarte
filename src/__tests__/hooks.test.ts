import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { installHooks, uninstallHooks, initPreCommitHook } from "../hooks.js";

let tmpDir: string;
let originalHome: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-hooks-"));
  originalHome = process.env.HOME;
  process.env.HOME = tmpDir;
});

afterEach(async () => {
  process.env.HOME = originalHome;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function settingsPath(): string {
  return path.join(tmpDir, ".claude", "settings.json");
}

async function readSettings(): Promise<Record<string, unknown>> {
  const content = await fs.readFile(settingsPath(), "utf-8");
  return JSON.parse(content);
}

async function writeSettings(obj: Record<string, unknown>): Promise<void> {
  const dir = path.join(tmpDir, ".claude");
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(settingsPath(), JSON.stringify(obj, null, 2), "utf-8");
}

describe("installHooks", () => {
  it("installs hooks into empty settings (creates file and directory)", async () => {
    await installHooks();
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, Array<{ type: string; command: string }>>;
    expect(hooks).toBeDefined();
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].command).toContain("clarte brief");
    expect(hooks.SessionStart[0].type).toBe("command");
    expect(hooks.PreCompact).toHaveLength(1);
    expect(hooks.PreCompact[0].command).toContain("clarte brief");
  });

  it("preserves existing hooks when installing", async () => {
    await writeSettings({
      hooks: {
        SessionStart: [
          { type: "command", command: "echo hello" },
        ],
        PreToolUse: [
          { type: "command", command: "lint" },
        ],
      },
    });

    await installHooks();
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, Array<{ type: string; command: string }>>;

    // Existing SessionStart hook preserved, clarte appended
    expect(hooks.SessionStart).toHaveLength(2);
    expect(hooks.SessionStart[0].command).toBe("echo hello");
    expect(hooks.SessionStart[1].command).toContain("clarte brief");

    // Existing PreToolUse hook untouched
    expect(hooks.PreToolUse).toHaveLength(1);
    expect(hooks.PreToolUse[0].command).toBe("lint");

    // PreCompact hook added
    expect(hooks.PreCompact).toHaveLength(1);
  });

  it("does not duplicate hooks on repeated install", async () => {
    await installHooks();
    await installHooks();
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, Array<{ type: string; command: string }>>;
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.PreCompact).toHaveLength(1);
  });

  it("preserves non-hook settings", async () => {
    await writeSettings({
      mcpServers: { myServer: {} },
      someFlag: true,
    });

    await installHooks();
    const settings = await readSettings();
    expect(settings.mcpServers).toEqual({ myServer: {} });
    expect(settings.someFlag).toBe(true);
  });
});

describe("uninstallHooks", () => {
  it("removes only clarte hooks, preserves others", async () => {
    await writeSettings({
      hooks: {
        SessionStart: [
          { type: "command", command: "echo hello" },
          { type: "command", command: "npx clarte brief" },
        ],
        PreCompact: [
          { type: "command", command: "npx clarte brief" },
        ],
      },
    });

    await uninstallHooks();
    const settings = await readSettings();
    const hooks = settings.hooks as Record<string, Array<{ type: string; command: string }>>;

    // Only the non-clarte hook remains
    expect(hooks.SessionStart).toHaveLength(1);
    expect(hooks.SessionStart[0].command).toBe("echo hello");

    // PreCompact had only clarte hooks, should be removed entirely
    expect(hooks.PreCompact).toBeUndefined();
  });

  it("handles missing settings file gracefully", async () => {
    // No settings file exists; should not throw
    await expect(uninstallHooks()).resolves.toBeUndefined();
  });

  it("handles missing hooks key gracefully", async () => {
    await writeSettings({ someKey: "value" });
    await expect(uninstallHooks()).resolves.toBeUndefined();
  });

  it("cleans up empty hooks object after removing all clarte hooks", async () => {
    await writeSettings({
      hooks: {
        SessionStart: [
          { type: "command", command: "npx clarte brief" },
        ],
      },
    });

    await uninstallHooks();
    const settings = await readSettings();

    // hooks key should be removed when empty
    expect(settings.hooks).toBeUndefined();
  });
});

describe("installHooks handles missing ~/.claude directory", () => {
  it("creates ~/.claude directory if it does not exist", async () => {
    // Ensure .claude does not exist
    const claudeDir = path.join(tmpDir, ".claude");
    try {
      await fs.rm(claudeDir, { recursive: true, force: true });
    } catch { /* ignore */ }

    await installHooks();

    // Verify directory and file were created
    const stat = await fs.stat(claudeDir);
    expect(stat.isDirectory()).toBe(true);
    const settings = await readSettings();
    expect(settings.hooks).toBeDefined();
  });
});

// ── initPreCommitHook ──────────────────────────────────────────────────

describe("initPreCommitHook", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("process.exit called");
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("exits with error when not a git repo", async () => {
    // tmpDir has no .git directory
    await expect(initPreCommitHook(tmpDir)).rejects.toThrow("process.exit called");
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Not a git repository"),
    );
  });

  it("prints Husky instructions when .husky/ exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".husky"), { recursive: true });

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Husky detected");
    expect(output).toContain("npx husky add");
    expect(output).toContain("npx clarte --check");
  });

  it("prints Lefthook instructions when lefthook.yml exists", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "lefthook.yml"), "pre-commit:\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Lefthook detected");
    expect(output).toContain("clarte-check");
    expect(output).toContain("npx clarte --check");
  });

  it("prints Lefthook instructions for .lefthook.yml variant", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".lefthook.yml"), "pre-commit:\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Lefthook detected");
  });

  it("creates pre-commit hook when no hook manager detected", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });

    await initPreCommitHook(tmpDir);

    const hookPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
    const content = await fs.readFile(hookPath, "utf-8");
    expect(content).toBe("#!/bin/sh\nnpx clarte --check\n");

    // Verify executable permission
    const stat = await fs.stat(hookPath);
    const execBit = stat.mode & 0o111;
    expect(execBit).toBeGreaterThan(0);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Installed pre-commit hook");
  });

  it("appends to existing pre-commit hook without duplicating", async () => {
    const hooksDir = path.join(tmpDir, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, "pre-commit"),
      "#!/bin/sh\nnpm run lint\n",
      "utf-8",
    );

    await initPreCommitHook(tmpDir);

    const content = await fs.readFile(
      path.join(hooksDir, "pre-commit"),
      "utf-8",
    );
    expect(content).toBe("#!/bin/sh\nnpm run lint\nnpx clarte --check\n");
  });

  it("does not duplicate when clarte already present in hook", async () => {
    const hooksDir = path.join(tmpDir, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(
      path.join(hooksDir, "pre-commit"),
      "#!/bin/sh\nnpx clarte --check\n",
      "utf-8",
    );

    await initPreCommitHook(tmpDir);

    const content = await fs.readFile(
      path.join(hooksDir, "pre-commit"),
      "utf-8",
    );
    // Content should be unchanged
    expect(content).toBe("#!/bin/sh\nnpx clarte --check\n");

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("already contains clarte");
  });

  it("prefers Husky over direct hook when both could apply", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".husky"), { recursive: true });

    await initPreCommitHook(tmpDir);

    // Should print Husky instructions, NOT write to .git/hooks
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Husky detected");

    // Verify no hook file was created
    try {
      await fs.access(path.join(tmpDir, ".git", "hooks", "pre-commit"));
      // If it exists, fail
      expect.fail("Should not have created .git/hooks/pre-commit when Husky is present");
    } catch {
      // Expected: file does not exist
    }
  });
});
