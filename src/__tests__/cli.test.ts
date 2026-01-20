/**
 * CLI smoke tests: verify basic command-line behavior.
 */

import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";

const BIN = path.resolve("dist/index.js");
const isBuild = existsSync(BIN);

function run(...args: string[]): { stdout: string; exitCode: number } {
  try {
    const stdout = execFileSync("node", [BIN, ...args], {
      encoding: "utf-8",
      timeout: 10_000,
      env: { ...process.env, NO_COLOR: "1" },
    });
    return { stdout, exitCode: 0 };
  } catch (err: unknown) {
    const e = err as { stdout?: string; status?: number };
    return { stdout: e.stdout ?? "", exitCode: e.status ?? 1 };
  }
}

describe.skipIf(!isBuild)("CLI smoke tests", () => {
  it("--help exits 0 and shows usage", () => {
    const { stdout, exitCode } = run("--help");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
    expect(stdout).toContain("Options");
  });

  it("--version exits 0 and shows a version string", () => {
    const { stdout, exitCode } = run("--version");
    expect(exitCode).toBe(0);
    // Version should match semver-like pattern
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });

  it("-h is an alias for --help", () => {
    const { stdout, exitCode } = run("-h");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("Usage");
  });

  it("-V is an alias for --version", () => {
    const { stdout, exitCode } = run("-V");
    expect(exitCode).toBe(0);
    expect(stdout.trim()).toMatch(/\d+\.\d+\.\d+/);
  });
});
