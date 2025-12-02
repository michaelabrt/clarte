import fs from "node:fs/promises";
import path from "node:path";

// ── Test file detection ────────────────────────────────────────────────

const TEST_FILE_PATTERNS = [
  /\.(test|spec)\.[jt]sx?$/,
  /\.(test|spec)\.(ts|js)$/,
  /__tests__\//,
  /_test\.go$/,
  /_test\.py$/,
  /test_[^/]+\.py$/,
  /tests\/[^/]+\.py$/,
];

export function isTestFile(filePath: string): boolean {
  return TEST_FILE_PATTERNS.some((p) => p.test(filePath));
}

/**
 * Get a value from a Map, or set it using the factory if missing.
 */
export function getOrSet<K, V>(map: Map<K, V>, key: K, factory: () => V): V {
  let val = map.get(key);
  if (val === undefined) {
    val = factory();
    map.set(key, val);
  }
  return val;
}

/**
 * Check if a file exists.
 */
export async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read a file's contents, returning null if it doesn't exist.
 */
export async function readFileOr(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch {
    return null;
  }
}

/**
 * Read and parse a JSON file, returning null on failure.
 */
export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  const content = await readFileOr(filePath);
  if (!content) return null;
  try {
    return JSON.parse(content);
  } catch {
    return null;
  }
}

/**
 * Estimate tokens from a string using a code-density-aware heuristic.
 * Code averages ~3.2-3.5 chars/token (more symbols than prose).
 * If the symbol ratio exceeds 8%, we assume code-heavy text.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  const symbolCount = text.replace(/[\w\s]/g, "").length;
  const symbolRatio = symbolCount / text.length;
  const charsPerToken = symbolRatio > 0.08 ? 3.2 : 3.5;
  return Math.ceil(text.length / charsPerToken);
}

/**
 * Format bytes as human-readable (e.g. "4.2 KB").
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

/**
 * Ensure a directory exists, creating it recursively if needed.
 */
export async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

/**
 * Write a file, creating parent directories if needed.
 */
export async function writeFileSafe(filePath: string, content: string): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await fs.writeFile(filePath, content, "utf-8");
}

/**
 * Get all entries of a directory (names only), returning empty array if dir doesn't exist.
 */
export async function readDirSafe(dirPath: string): Promise<string[]> {
  try {
    return await fs.readdir(dirPath);
  } catch {
    return [];
  }
}
