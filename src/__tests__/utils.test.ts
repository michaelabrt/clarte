import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ensureDir,
  estimateTokens,
  fileExists,
  formatBytes,
  readDirSafe,
  readFileOr,
  readJsonFile,
  writeFileSafe,
} from "../utils.js";

const TMP = path.join(import.meta.dirname, ".tmp-utils-test");

afterEach(async () => {
  await fs.rm(TMP, { recursive: true, force: true });
});

describe("estimateTokens", () => {
  it("returns 0 for empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("estimates reasonable token count for prose text", () => {
    const prose = "This is a simple sentence with mostly words and spaces in it.";
    const tokens = estimateTokens(prose);
    // ~61 chars of prose should produce roughly 15-25 tokens (1-1.5 tokens per word)
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(tokens).toBeLessThanOrEqual(25);
  });

  it("estimates higher token density for code-heavy text", () => {
    const code = `const foo = (a: number, b: string) => { return a + b.length; };`;
    const tokens = estimateTokens(code);
    // Code with many symbols should produce more tokens per character than prose
    expect(tokens).toBeGreaterThanOrEqual(15);
    expect(tokens).toBeLessThanOrEqual(30);

    // Code should have a higher token-per-char ratio than equivalently-sized prose
    const proseOfSameLength = "a".repeat(code.length);
    const proseTokens = estimateTokens(proseOfSameLength);
    expect(tokens).toBeGreaterThanOrEqual(proseTokens);
  });
});

describe("fileExists", () => {
  it("returns true for a file that exists", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const fp = path.join(TMP, "exists.txt");
    await fs.writeFile(fp, "hello");
    expect(await fileExists(fp)).toBe(true);
  });

  it("returns false for a file that does not exist", async () => {
    expect(await fileExists(path.join(TMP, "nope.txt"))).toBe(false);
  });
});

describe("readFileOr", () => {
  it("reads file contents when file exists", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const fp = path.join(TMP, "read.txt");
    await fs.writeFile(fp, "content");
    expect(await readFileOr(fp)).toBe("content");
  });

  it("returns null when file does not exist", async () => {
    expect(await readFileOr(path.join(TMP, "missing.txt"))).toBeNull();
  });
});

describe("readJsonFile", () => {
  it("reads and parses valid JSON", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const fp = path.join(TMP, "data.json");
    await fs.writeFile(fp, JSON.stringify({ key: "value" }));
    expect(await readJsonFile(fp)).toEqual({ key: "value" });
  });

  it("returns null for invalid JSON", async () => {
    await fs.mkdir(TMP, { recursive: true });
    const fp = path.join(TMP, "bad.json");
    await fs.writeFile(fp, "not json");
    expect(await readJsonFile(fp)).toBeNull();
  });

  it("returns null for missing file", async () => {
    expect(await readJsonFile(path.join(TMP, "missing.json"))).toBeNull();
  });
});

describe("formatBytes", () => {
  it("formats bytes under 1 KB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(0)).toBe("0 B");
  });

  it("formats bytes in KB range", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(4300)).toBe("4.2 KB");
  });
});

describe("ensureDir", () => {
  it("creates nested directories", async () => {
    const nested = path.join(TMP, "a", "b", "c");
    await ensureDir(nested);
    const stat = await fs.stat(nested);
    expect(stat.isDirectory()).toBe(true);
  });

  it("is idempotent on existing directory", async () => {
    await fs.mkdir(TMP, { recursive: true });
    await ensureDir(TMP); // should not throw
  });
});

describe("writeFileSafe", () => {
  it("creates parent directories and writes file", async () => {
    const fp = path.join(TMP, "deep", "dir", "file.txt");
    await writeFileSafe(fp, "hello");
    const content = await fs.readFile(fp, "utf-8");
    expect(content).toBe("hello");
  });
});

describe("readDirSafe", () => {
  it("returns entries for existing directory", async () => {
    await fs.mkdir(TMP, { recursive: true });
    await fs.writeFile(path.join(TMP, "a.txt"), "");
    await fs.writeFile(path.join(TMP, "b.txt"), "");
    const entries = await readDirSafe(TMP);
    expect(entries.sort()).toEqual(["a.txt", "b.txt"]);
  });

  it("returns empty array for non-existent directory", async () => {
    expect(await readDirSafe(path.join(TMP, "nope"))).toEqual([]);
  });
});
