/**
 * Git blame parsing and symbol-level temporal mapping.
 *
 * Maps line-level blame timestamps to per-symbol "days since last modified"
 * using the most recent modification within each symbol's line range.
 * Used by Markov flow to apply blame-boundary temporal decay.
 */

import { exec } from "node:child_process";
import type { InMemorySymbolGraph } from "../../storage/types";
import { BLAME_BATCH_SIZE, BLAME_DEFAULT_DAYS } from "../config/phase7-constants";

// ── Porcelain parsing ────────────────────────────────────────────────────────

/**
 * Parse `git blame --porcelain` output into a line -> daysSinceModified map.
 *
 * @param output - raw porcelain output from git blame
 * @param referenceMs - reference timestamp in ms (defaults to Date.now())
 */
export function parseBlameOutput(output: string, referenceMs: number = Date.now()): Map<number, number> {
  const result = new Map<number, number>();
  const lines = output.split("\n");

  let currentLine = 0;
  let currentTimestamp = 0;

  for (const line of lines) {
    const headerMatch = line.match(/^[0-9a-f]{40} \d+ (\d+)/);
    if (headerMatch) {
      currentLine = parseInt(headerMatch[1], 10);
      continue;
    }

    const timeMatch = line.match(/^author-time (\d+)/);
    if (timeMatch) {
      currentTimestamp = parseInt(timeMatch[1], 10);
      continue;
    }

    // Content line (starts with tab): commit the line -> days mapping
    if (line.startsWith("\t") && currentLine > 0 && currentTimestamp > 0) {
      const daysAgo = Math.max(0, (referenceMs - currentTimestamp * 1000) / 86400_000);
      result.set(currentLine, daysAgo);
    }
  }

  return result;
}

// ── File-level blame ─────────────────────────────────────────────────────────

function execBlame(file: string, rootDir: string): Promise<string> {
  return new Promise((resolve) => {
    exec(
      `git blame --porcelain -- "${file}"`,
      { cwd: rootDir, encoding: "utf-8", timeout: 10_000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => resolve(error ? "" : stdout),
    );
  });
}

/**
 * Run git blame on multiple files in batches of BLAME_BATCH_SIZE.
 *
 * @returns filePath -> (lineNumber -> daysSinceModified)
 */
export async function blameFiles(files: string[], rootDir: string): Promise<Map<string, Map<number, number>>> {
  const result = new Map<string, Map<number, number>>();
  const referenceMs = Date.now();

  for (let i = 0; i < files.length; i += BLAME_BATCH_SIZE) {
    const batch = files.slice(i, i + BLAME_BATCH_SIZE);
    const settled = await Promise.all(
      batch.map(async (file) => {
        const output = await execBlame(file, rootDir);
        const blame = output ? parseBlameOutput(output, referenceMs) : new Map<number, number>();
        return { file, blame };
      }),
    );
    for (const { file, blame } of settled) {
      if (blame.size > 0) result.set(file, blame);
    }
  }

  return result;
}

// ── Symbol-level mapping ─────────────────────────────────────────────────────

/**
 * Map line-level blame to symbol-level daysSinceModified.
 *
 * For each symbol, takes the minimum (most recent) days-since-modified
 * over [startLine, endLine]. If endLine is undefined, uses startLine only.
 */
export function mapBlameToSymbols(
  lineBlame: Map<string, Map<number, number>>,
  symbolGraph: InMemorySymbolGraph,
): Map<number, number> {
  const result = new Map<number, number>();

  for (const [symbolId, sym] of symbolGraph.symbols) {
    const fileBlame = lineBlame.get(sym.filePath);
    if (!fileBlame) {
      result.set(symbolId, BLAME_DEFAULT_DAYS);
      continue;
    }

    const start = sym.startLine;
    const end = sym.endLine ?? sym.startLine;
    let minDays = BLAME_DEFAULT_DAYS;

    for (let line = start; line <= end; line++) {
      const days = fileBlame.get(line);
      if (days !== undefined && days < minDays) {
        minDays = days;
      }
    }

    result.set(symbolId, minDays);
  }

  return result;
}

// ── Full pipeline ────────────────────────────────────────────────────────────

/**
 * Compute per-symbol daysSinceModified by running git blame on all files
 * in the symbol graph and aggregating to symbol line ranges.
 */
export async function computeSymbolBlame(
  rootDir: string,
  symbolGraph: InMemorySymbolGraph,
): Promise<Map<number, number>> {
  const files = Array.from(symbolGraph.byFile.keys());
  const lineBlame = await blameFiles(files, rootDir);
  return mapBlameToSymbols(lineBlame, symbolGraph);
}
