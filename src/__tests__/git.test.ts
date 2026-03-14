import { describe, expect, it } from "vitest";
import { gitExec, gitExecSafe, GitError } from "../git/git.js";

const cwd = process.cwd();

describe("gitExec", () => {
  it("returns trimmed output from a valid git command", () => {
    const result = gitExec(["--version"], { cwd });
    expect(result).toSatisfy((s: string) => s.startsWith("git version"));
    // Output should be trimmed (no trailing newline)
    expect(result).toBe(result.trim());
  });

  it("returns the current branch or HEAD ref", () => {
    const result = gitExec(["rev-parse", "--abbrev-ref", "HEAD"], { cwd });
    expect(result.length).toBeGreaterThan(0);
    // Branch names don't contain newlines
    expect(result).not.toContain("\n");
  });

  it("throws GitError on invalid git subcommand", () => {
    expect(() => gitExec(["not-a-real-command"], { cwd })).toThrow(GitError);
  });

  it("GitError has name set to 'GitError'", () => {
    try {
      gitExec(["not-a-real-command"], { cwd });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).name).toBe("GitError");
    }
  });

  it("includes the full git command string in GitError.command", () => {
    try {
      gitExec(["status", "--bad-flag-xyz"], { cwd });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      const ge = err as GitError;
      expect(ge.command).toBe("git status --bad-flag-xyz");
    }
  });

  it("error message contains stderr content from git", () => {
    try {
      gitExec(["not-a-real-command"], { cwd });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      const ge = err as GitError;
      // git stderr includes "git: 'not-a-real-command' is not a git command"
      expect(ge.message).toContain("not-a-real-command");
    }
  });

  it("preserves the original error as cause", () => {
    try {
      gitExec(["not-a-real-command"], { cwd });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).cause).toBeDefined();
    }
  });

  it("throws GitError when cwd does not exist", () => {
    expect(() => gitExec(["status"], { cwd: "/nonexistent-dir-12345" })).toThrow(GitError);
  });

  it("inherits from ClarteError -> Error", () => {
    try {
      gitExec(["not-a-real-command"], { cwd });
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toBeTruthy();
    }
  });

  it("handles multi-arg commands correctly", () => {
    const result = gitExec(["log", "--oneline", "-1"], { cwd });
    // Should return at least a short hash
    expect(result.length).toBeGreaterThanOrEqual(7);
  });
});

describe("gitExecSafe", () => {
  it("returns output from a valid git command", () => {
    const result = gitExecSafe(["--version"], { cwd });
    expect(result).toSatisfy((s: string | null) => typeof s === "string" && s.startsWith("git version"));
  });

  it("returns null on invalid subcommand instead of throwing", () => {
    const result = gitExecSafe(["not-a-real-command"], { cwd });
    expect(result).toBeNull();
  });

  it("returns null when cwd does not exist", () => {
    const result = gitExecSafe(["status"], { cwd: "/nonexistent-dir-12345" });
    expect(result).toBeNull();
  });

  it("returns null on bad flags without throwing", () => {
    const result = gitExecSafe(["status", "--bad-flag-xyz"], { cwd });
    expect(result).toBeNull();
  });

  it("returns the same output as gitExec for valid commands", () => {
    const direct = gitExec(["rev-parse", "HEAD"], { cwd });
    const safe = gitExecSafe(["rev-parse", "HEAD"], { cwd });
    expect(safe).toBe(direct);
  });
});
