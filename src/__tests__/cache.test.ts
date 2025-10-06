import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  computeFileHashes,
  loadCache,
  saveCache,
  buildGraphWithCache,
  type CacheData,
} from "../cache.js";

let tmpDir: string;

async function createTestFiles(dir: string, count: number): Promise<void> {
  // f0.ts is the foundation file
  await fs.writeFile(
    path.join(dir, "f0.ts"),
    "export const x = 1;\n",
  );
  // f1..f(count-1) each import from f0
  for (let i = 1; i < count; i++) {
    await fs.writeFile(
      path.join(dir, `f${i}.ts`),
      `import { x } from './f0';\nexport const y${i} = x;\n`,
    );
  }
}

describe("computeFileHashes", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-cache-"));
    await fs.writeFile(path.join(tmpDir, "a.ts"), "export const a = 1;");
    await fs.writeFile(path.join(tmpDir, "b.ts"), "export const b = 2;");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("is deterministic", async () => {
    const hashes1 = await computeFileHashes(tmpDir, "typescript");
    const hashes2 = await computeFileHashes(tmpDir, "typescript");
    expect(hashes1).toEqual(hashes2);
  });

  it("detects file content changes", async () => {
    const hashes1 = await computeFileHashes(tmpDir, "typescript");
    await fs.writeFile(path.join(tmpDir, "a.ts"), "export const a = 42;");
    const hashes2 = await computeFileHashes(tmpDir, "typescript");
    expect(hashes1.get("a.ts")).not.toEqual(hashes2.get("a.ts"));
    expect(hashes1.get("b.ts")).toEqual(hashes2.get("b.ts"));
  });

  it("only finds files matching language", async () => {
    const hashes = await computeFileHashes(tmpDir, "python");
    expect(hashes.size).toBe(0);
  });
});

describe("cache I/O", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-cache-"));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("returns null when no cache exists", async () => {
    expect(await loadCache(tmpDir)).toBeNull();
  });

  it("round-trips cache data", async () => {
    const data: CacheData = {
      version: 1,
      createdAt: "2025-01-01T00:00:00.000Z",
      language: "typescript",
      fileHashes: { "a.ts": "abc123" },
      edges: [
        {
          from: "a.ts",
          to: "b.ts",
          isExternal: false,
          specifier: "./b",
          importedNames: ["foo"],
        },
      ],
      barrelFiles: [],
    };
    await saveCache(tmpDir, data);
    const loaded = await loadCache(tmpDir);
    expect(loaded).toEqual(data);
  });

  it("returns null for version mismatch", async () => {
    const data: CacheData = {
      version: 999,
      createdAt: "2025-01-01T00:00:00.000Z",
      language: "typescript",
      fileHashes: {},
      edges: [],
      barrelFiles: [],
    };
    await saveCache(tmpDir, data);
    expect(await loadCache(tmpDir)).toBeNull();
  });
});

describe("buildGraphWithCache", () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-cache-"));
    await createTestFiles(tmpDir, 12);
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true });
  });

  it("does full rebuild when no cache exists", async () => {
    const messages: string[] = [];
    const graph = await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Full graph rebuild"))).toBe(true);

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges.length).toBe(11);

    // Cache should have been created
    expect(await loadCache(tmpDir)).not.toBeNull();
  });

  it("uses cache when no files changed", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    const messages: string[] = [];
    const graph = await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("No files changed"))).toBe(true);
    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges.length).toBe(11);
  });

  it("does incremental rebuild when <10% changed", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    // Modify 1 file out of 12 (8.3% < 10%)
    await fs.writeFile(
      path.join(tmpDir, "f1.ts"),
      `import { x } from './f0';\nexport const z = x + 1;\n`,
    );

    const messages: string[] = [];
    const graph = await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Incremental rebuild"))).toBe(true);
    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges.length).toBe(11);
  });

  it("does full rebuild when >10% changed", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    // Modify 3 files out of 12 (25% > 10%)
    for (let i = 1; i <= 3; i++) {
      await fs.writeFile(
        path.join(tmpDir, `f${i}.ts`),
        `import { x } from './f0';\nexport const z${i} = x;\n`,
      );
    }

    const messages: string[] = [];
    await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Full graph rebuild"))).toBe(true);
  });

  it("invalidates cache when language changes", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    const messages: string[] = [];
    await buildGraphWithCache(tmpDir, "python", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Full graph rebuild"))).toBe(true);
  });

  it("handles deleted files correctly", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    // Delete f11.ts (1/11 remaining = 9.1% < 10%)
    await fs.unlink(path.join(tmpDir, "f11.ts"));

    const messages: string[] = [];
    const graph = await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Incremental rebuild"))).toBe(true);

    // Deleted file's edges should be gone
    const f11Edges = graph.edges.filter(
      (e) => e.from === "f11.ts" || e.to === "f11.ts",
    );
    expect(f11Edges.length).toBe(0);

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges.length).toBe(10);
  });

  it("handles new files correctly", async () => {
    await buildGraphWithCache(tmpDir, "typescript");

    // Add 1 file (1/13 = 7.7% < 10%)
    await fs.writeFile(
      path.join(tmpDir, "f12.ts"),
      `import { x } from './f0';\nexport const w = x;\n`,
    );

    const messages: string[] = [];
    const graph = await buildGraphWithCache(tmpDir, "typescript", (msg) =>
      messages.push(msg),
    );

    expect(messages.some((m) => m.includes("Incremental rebuild"))).toBe(true);

    const f12Edges = graph.edges.filter(
      (e) => e.from === "f12.ts" && !e.isExternal,
    );
    expect(f12Edges.length).toBe(1);
    expect(f12Edges[0].to).toBe("f0.ts");

    const internalEdges = graph.edges.filter((e) => !e.isExternal);
    expect(internalEdges.length).toBe(12);
  });
});
