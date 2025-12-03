import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { initPreCommitHook } from "../hooks.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-hooks-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
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
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Not a git repository"));
  });

  it("prints Husky instructions with auto-refresh command", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.mkdir(path.join(tmpDir, ".husky"), { recursive: true });

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Husky detected");
    expect(output).toContain("--refresh-snapshot");
    expect(output).toContain("git add");
  });

  it("prints Lefthook instructions with auto-refresh command", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "lefthook.yml"), "pre-commit:\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Lefthook detected");
    expect(output).toContain("clarte-refresh");
    expect(output).toContain("--refresh-snapshot");
  });

  it("prints Lefthook instructions for .lefthook.yml variant", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, ".lefthook.yml"), "pre-commit:\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Lefthook detected");
  });

  it("creates auto-refresh pre-commit hook", async () => {
    await fs.mkdir(path.join(tmpDir, ".git", "hooks"), { recursive: true });

    await initPreCommitHook(tmpDir);

    const hookPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
    const content = await fs.readFile(hookPath, "utf-8");
    expect(content).toContain("npx clarte --check");
    expect(content).toContain("npx clarte --refresh-snapshot");
    expect(content).toContain("git add CLAUDE.md");

    // Verify executable permission
    const stat = await fs.stat(hookPath);
    const execBit = stat.mode & 0o111;
    expect(execBit).toBeGreaterThan(0);

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Installed pre-commit hook");
  });

  it("appends auto-refresh snippet to existing pre-commit hook", async () => {
    const hooksDir = path.join(tmpDir, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nnpm run lint\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const content = await fs.readFile(path.join(hooksDir, "pre-commit"), "utf-8");
    expect(content).toContain("npm run lint");
    expect(content).toContain("--refresh-snapshot");
    expect(content).toContain("git add");
  });

  it("does not duplicate when clarte already present in hook", async () => {
    const hooksDir = path.join(tmpDir, ".git", "hooks");
    await fs.mkdir(hooksDir, { recursive: true });
    await fs.writeFile(path.join(hooksDir, "pre-commit"), "#!/bin/sh\nnpx clarte --check\n", "utf-8");

    await initPreCommitHook(tmpDir);

    const content = await fs.readFile(path.join(hooksDir, "pre-commit"), "utf-8");
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
