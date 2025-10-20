import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { runPrintMode } from "../print.js";
import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";

describe("runPrintMode", () => {
  let tmpDir: string;
  let stdoutChunks: string[];
  let originalWrite: typeof process.stdout.write;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-print-"));
    stdoutChunks = [];
    originalWrite = process.stdout.write;
    // Capture stdout
    process.stdout.write = ((chunk: string | Uint8Array) => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(async () => {
    process.stdout.write = originalWrite;
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("is a silent no-op when no .clarte.json exists", async () => {
    // Create a package.json so it passes project marker check
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project" }),
    );

    await runPrintMode(tmpDir);

    const output = stdoutChunks.join("");
    expect(output).toBe("");
  });

  it("produces output when .clarte.json exists", async () => {
    // Create package.json
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project", scripts: { test: "vitest" } }),
    );

    // Create .clarte.json
    await fs.writeFile(
      path.join(tmpDir, ".clarte.json"),
      JSON.stringify({
        _version: 1,
        ides: ["claude"],
        projectPurpose: "A test project for print mode",
        keyPatterns: "",
        gotchas: "",
        generateSnapshot: false,
        snapshotPaths: [],
        stackCorrections: "",
        generatePerPackage: false,
      }),
    );

    // Create a src directory with a file
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(
      path.join(tmpDir, "src", "index.ts"),
      'export function hello() { return "world"; }\n',
    );

    await runPrintMode(tmpDir, 3000, false);

    const output = stdoutChunks.join("");
    // Should contain tech stack section
    expect(output).toContain("## Tech Stack");
    // Should contain the project purpose
    expect(output).toContain("A test project for print mode");
  });

  it("produces output without ANSI escape codes", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project" }),
    );
    await fs.writeFile(
      path.join(tmpDir, ".clarte.json"),
      JSON.stringify({
        _version: 1,
        ides: ["claude"],
        projectPurpose: "Brief mode test",
        keyPatterns: "",
        gotchas: "",
        generateSnapshot: false,
        snapshotPaths: [],
        stackCorrections: "",
        generatePerPackage: false,
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "main.ts"), "export const x = 1;\n");

    await runPrintMode(tmpDir, 3000, false);

    const output = stdoutChunks.join("");
    // ANSI escape codes start with \x1b[
    expect(output).not.toMatch(/\x1b\[/);
  });

  it("respects custom budget", async () => {
    await fs.writeFile(
      path.join(tmpDir, "package.json"),
      JSON.stringify({ name: "test-project" }),
    );
    await fs.writeFile(
      path.join(tmpDir, ".clarte.json"),
      JSON.stringify({
        _version: 1,
        ides: ["claude"],
        projectPurpose: "Budget test project",
        keyPatterns: "",
        gotchas: "",
        generateSnapshot: false,
        snapshotPaths: [],
        stackCorrections: "",
        generatePerPackage: false,
      }),
    );
    await fs.mkdir(path.join(tmpDir, "src"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "src", "main.ts"), "export const x = 1;\n");

    // Run with very small budget
    await runPrintMode(tmpDir, 500, false);
    const smallOutput = stdoutChunks.join("");

    // Reset capture
    stdoutChunks = [];

    // Run with large budget
    await runPrintMode(tmpDir, 10000, false);
    const largeOutput = stdoutChunks.join("");

    // Small budget output should be <= large budget output
    expect(smallOutput.length).toBeLessThanOrEqual(largeOutput.length);
  });
});
