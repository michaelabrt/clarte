import { describe, expect, it } from "vitest";
import { gitExec, gitExecSafe, GitError } from "../git/git.js";

describe("gitExec", () => {
  it("returns output from a valid git command", () => {
    const result = gitExec(["--version"], { cwd: process.cwd() });
    expect(result).toMatch(/^git version/);
  });

  it("throws GitError on invalid git command", () => {
    expect(() => gitExec(["not-a-real-command"], { cwd: process.cwd() })).toThrow(GitError);
  });

  it("includes command in GitError", () => {
    try {
      gitExec(["not-a-real-command"], { cwd: process.cwd() });
    } catch (err) {
      expect(err).toBeInstanceOf(GitError);
      expect((err as GitError).command).toContain("not-a-real-command");
    }
  });
});

describe("gitExecSafe", () => {
  it("returns output from a valid git command", () => {
    const result = gitExecSafe(["--version"], { cwd: process.cwd() });
    expect(result).toMatch(/^git version/);
  });

  it("returns null on failure", () => {
    const result = gitExecSafe(["not-a-real-command"], { cwd: process.cwd() });
    expect(result).toBeNull();
  });
});
