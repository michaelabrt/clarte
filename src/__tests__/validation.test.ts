import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { describe, expect, it, vi, afterEach } from "vitest";
import { validateContextFile, validateAndReport } from "../validation.js";
import type { ImportGraph } from "../types.js";

/** Create a temporary project directory with the given file tree. */
async function makeProject(
  files: Record<string, string>,
): Promise<string> {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-val-"));
  for (const [relPath, content] of Object.entries(files)) {
    const fullPath = path.join(tmpDir, relPath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
  return tmpDir;
}

async function cleanup(dir: string) {
  await fs.rm(dir, { recursive: true, force: true });
}

// ── Path verification ─────────────────────────────────────────────────────

describe("path verification", () => {
  let tmpDir: string;
  afterEach(async () => {
    if (tmpDir) await cleanup(tmpDir);
  });

  it("reports no warnings for existing paths", async () => {
    tmpDir = await makeProject({
      "src/index.ts": "export const x = 1;",
      "src/utils.ts": "export function f() {}",
    });

    const content = [
      "## Key Files",
      "",
      "| File | Role |",
      "|------|------|",
      "| `src/index.ts` | entry |",
      "| `src/utils.ts` | utility |",
    ].join("\n");

    const result = await validateContextFile(content, tmpDir);
    const pathWarnings = result.warnings.filter((w) => w.section === "paths");
    expect(pathWarnings).toHaveLength(0);
  });

  it("reports warning for missing paths", async () => {
    tmpDir = await makeProject({
      "src/index.ts": "export const x = 1;",
    });

    const content = [
      "## Key Files",
      "",
      "- `src/index.ts`: entry point",
      "- `src/missing-file.ts`: does not exist",
    ].join("\n");

    const result = await validateContextFile(content, tmpDir);
    const pathWarnings = result.warnings.filter((w) => w.section === "paths");
    expect(pathWarnings).toHaveLength(1);
    expect(pathWarnings[0].message).toContain("src/missing-file.ts");
    expect(pathWarnings[0].severity).toBe("warning");
  });

  it("skips URLs and glob patterns", async () => {
    tmpDir = await makeProject({});

    const content = [
      "Visit `https://example.com/docs/guide.html` for details.",
      "Pattern: `src/**/*.test.ts`",
    ].join("\n");

    const result = await validateContextFile(content, tmpDir);
    const pathWarnings = result.warnings.filter((w) => w.section === "paths");
    expect(pathWarnings).toHaveLength(0);
  });
});

// ── Import count consistency ──────────────────────────────────────────────

describe("import count consistency", () => {
  function makeGraph(inDegreeEntries: [string, number][]): ImportGraph {
    return {
      edges: [],
      inDegree: new Map(inDegreeEntries),
      centrality: new Map(),
      externalImportCounts: new Map(),
      authority: new Map(),
      hubScores: new Map(),
    };
  }

  it("reports no warning when counts match exactly", async () => {
    const content = "`src/types.ts` is imported by 10 files in the project.";
    const graph = makeGraph([["src/types.ts", 10]]);

    const result = await validateContextFile(content, "/tmp", graph);
    const countWarnings = result.warnings.filter((w) => w.section === "import-counts");
    expect(countWarnings).toHaveLength(0);
  });

  it("allows +/-1 tolerance", async () => {
    const content = "`src/types.ts` is imported by 10 files.";
    const graph = makeGraph([["src/types.ts", 11]]);

    const result = await validateContextFile(content, "/tmp", graph);
    const countWarnings = result.warnings.filter((w) => w.section === "import-counts");
    expect(countWarnings).toHaveLength(0);
  });

  it("reports mismatch beyond tolerance", async () => {
    const content = "`src/types.ts` is imported by 10 files.";
    const graph = makeGraph([["src/types.ts", 15]]);

    const result = await validateContextFile(content, "/tmp", graph);
    const countWarnings = result.warnings.filter((w) => w.section === "import-counts");
    expect(countWarnings).toHaveLength(1);
    expect(countWarnings[0].message).toContain("claimed 10");
    expect(countWarnings[0].message).toContain("actual 15");
  });

  it("skips paths not in graph", async () => {
    const content = "`src/unknown.ts` is imported by 5 files.";
    const graph = makeGraph([["src/types.ts", 10]]);

    const result = await validateContextFile(content, "/tmp", graph);
    const countWarnings = result.warnings.filter((w) => w.section === "import-counts");
    expect(countWarnings).toHaveLength(0);
  });
});

// ── Snapshot freshness ────────────────────────────────────────────────────

describe("snapshot freshness", () => {
  it("warns when snapshot is stale (>7 days old)", async () => {
    const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000; // 10 days ago
    const content = [
      "## Code Snapshot",
      "",
      "<!-- snapshotGeneratedAt: " + oldTimestamp + " -->",
      "",
      "```ts",
      "export function foo(): void",
      "```",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const freshWarnings = result.warnings.filter((w) => w.section === "snapshot-freshness");
    expect(freshWarnings).toHaveLength(1);
    expect(freshWarnings[0].message).toContain("10 days old");
  });

  it("does not warn for fresh snapshot", async () => {
    const recentTimestamp = Date.now() - 2 * 24 * 60 * 60 * 1000; // 2 days ago
    const content = [
      "## Code Snapshot",
      "",
      "<!-- snapshotGeneratedAt: " + recentTimestamp + " -->",
      "",
      "```ts",
      "export function foo(): void",
      "```",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const freshWarnings = result.warnings.filter((w) => w.section === "snapshot-freshness");
    expect(freshWarnings).toHaveLength(0);
  });

  it("does not warn when no snapshot section exists", async () => {
    const content = "## Key Files\n\nSome content here.\n";

    const result = await validateContextFile(content, "/tmp");
    const freshWarnings = result.warnings.filter((w) => w.section === "snapshot-freshness");
    expect(freshWarnings).toHaveLength(0);
  });

  it("does not warn when no timestamp is present", async () => {
    const content = [
      "## Code Snapshot",
      "",
      "```ts",
      "export function foo(): void",
      "```",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const freshWarnings = result.warnings.filter((w) => w.section === "snapshot-freshness");
    expect(freshWarnings).toHaveLength(0);
  });
});

// ── Dead reference detection ──────────────────────────────────────────────

describe("dead reference detection", () => {
  it("warns when framework in Tech Stack is not mentioned elsewhere", async () => {
    const content = [
      "## Tech Stack",
      "",
      "- **React** 18.2.0",
      "- **Tailwind CSS** 3.4.0",
      "",
      "## Key Patterns",
      "",
      "Uses React components with hooks pattern.",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const deadWarnings = result.warnings.filter((w) => w.section === "dead-references");
    // Tailwind CSS is in Tech Stack but not mentioned in Key Patterns
    expect(deadWarnings).toHaveLength(1);
    expect(deadWarnings[0].message).toContain("Tailwind CSS");
  });

  it("reports no warning when all frameworks are referenced", async () => {
    const content = [
      "## Tech Stack",
      "",
      "- **React** 18.2.0",
      "- **Express** 4.18.0",
      "",
      "## Key Patterns",
      "",
      "Uses React for the frontend and Express for the API server.",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const deadWarnings = result.warnings.filter((w) => w.section === "dead-references");
    expect(deadWarnings).toHaveLength(0);
  });

  it("reports no warnings when there is no Tech Stack section", async () => {
    const content = [
      "## Project Structure",
      "",
      "Standard layout with src/ directory.",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    const deadWarnings = result.warnings.filter((w) => w.section === "dead-references");
    expect(deadWarnings).toHaveLength(0);
  });
});

// ── Overall validation result ─────────────────────────────────────────────

describe("validation result", () => {
  it("returns valid: true when no errors exist", async () => {
    const content = "## Project\n\nSimple content.\n";
    const result = await validateContextFile(content, "/tmp");
    expect(result.valid).toBe(true);
  });

  it("returns valid: true even with warnings (only errors affect validity)", async () => {
    const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const content = [
      "## Code Snapshot",
      "",
      "<!-- snapshotGeneratedAt: " + oldTimestamp + " -->",
    ].join("\n");

    const result = await validateContextFile(content, "/tmp");
    // Warnings should not set valid to false
    expect(result.valid).toBe(true);
  });
});

// ── validateAndReport ─────────────────────────────────────────────────────

describe("validateAndReport", () => {
  it("prints warnings to stderr", async () => {
    const oldTimestamp = Date.now() - 10 * 24 * 60 * 60 * 1000;
    const content = [
      "## Code Snapshot",
      "",
      "<!-- snapshotGeneratedAt: " + oldTimestamp + " -->",
    ].join("\n");

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await validateAndReport(content, "/tmp");
    expect(warnSpy).toHaveBeenCalled();
    expect(warnSpy.mock.calls[0][0]).toContain("[WARN]");
    warnSpy.mockRestore();
  });

  it("prints nothing when no warnings", async () => {
    const content = "## Project\n\nSimple content.\n";

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    await validateAndReport(content, "/tmp");
    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
