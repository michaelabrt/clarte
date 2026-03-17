/**
 * clarte_impact MCP tool (RFC §4.3).
 *
 * "What breaks if I change this?" - downstream impact analysis.
 * Three categories:
 *   WILL BREAK   - direct non-type-only dependents
 *   LIKELY AFFECTED - 2-hop non-type-only dependents
 *   TEST         - test files covering the target + 1-hop dependents
 *
 * [Neubig] Stability guard: max_results cap and summary mode prevent token overflow.
 * [Neubig & Reimers] Explainability: rationale field explains why each file is included.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter";
import { isTestFile } from "../../core/utils";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImpactInput {
  file: string;
  /** [Neubig] Cap per category to prevent token overflow (default: unlimited) */
  maxResults?: number;
  /** [Neubig] When true, returns file paths and counts only (default: false) */
  summary?: boolean;
}

interface ImpactEntry {
  file: string;
  rationale: string;
}

export interface ImpactOutput {
  file: string;
  will_break: ImpactEntry[];
  likely_affected: ImpactEntry[];
  test: ImpactEntry[];
  /** [Neubig] When max_results caps output, shows total count per category */
  truncated?: { will_break: number; likely_affected: number; test: number };
  error?: string;
}

/** [Neubig] Depth-limited summary: file paths + counts only, no rationale detail */
export interface ImpactSummaryOutput {
  file: string;
  will_break: { count: number; files: string[] };
  likely_affected: { count: number; files: string[] };
  test: { count: number; files: string[] };
  error?: string;
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface PathRow {
  from_path: string;
}

interface TwoHopRow {
  from_path: string;
  via: string;
}

interface FileExistsRow {
  path: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * [Neubig] Compute the downstream blast radius of modifying a file.
 * Supports max_results cap and summary mode to prevent context window overflow.
 * Every entry includes a rationale explaining why it was included.
 */
export function executeImpact(db: DatabaseAdapter, input: ImpactInput): ImpactOutput | ImpactSummaryOutput {
  const { file, maxResults, summary } = input;

  const fileCheck = db.prepare("SELECT path FROM files WHERE path = ?");
  const fileRow = fileCheck.get<FileExistsRow>(file);
  if (!fileRow) {
    if (summary) {
      return {
        file,
        will_break: { count: 0, files: [] },
        likely_affected: { count: 0, files: [] },
        test: { count: 0, files: [] },
        error: `File not found in graph: ${file}`,
      };
    }
    return {
      file,
      will_break: [],
      likely_affected: [],
      test: [],
      error: `File not found in graph: ${file}`,
    };
  }

  // 1. WILL BREAK: direct non-type-only dependents
  const directStmt = db.prepare(`
    SELECT from_path FROM file_edges
    WHERE to_path = ? AND is_type_only = 0
  `);
  const directRows = directStmt.all<PathRow>(file);
  const allWillBreak = directRows.map((r) => r.from_path).filter((p) => p !== file);

  // 2. LIKELY AFFECTED: 2-hop with intermediate file for rationale
  const twoHopStmt = db.prepare(`
    SELECT DISTINCT fe2.from_path, fe1.from_path as via
    FROM file_edges fe1
    JOIN file_edges fe2 ON fe2.to_path = fe1.from_path
    WHERE fe1.to_path = ? AND fe1.is_type_only = 0 AND fe2.is_type_only = 0
      AND fe2.from_path != ?
  `);
  const twoHopRows = twoHopStmt.all<TwoHopRow>(file, file);
  const willBreakSet = new Set(allWillBreak);
  const allLikelyAffected = twoHopRows.filter((r) => !willBreakSet.has(r.from_path));

  // 3. TEST: test files covering the target or direct dependents
  const searchPaths = [file, ...allWillBreak];
  const testMap = new Map<string, string>(); // testFile -> coveredFile
  const importerStmt = db.prepare("SELECT from_path FROM file_edges WHERE to_path = ?");
  for (const targetPath of searchPaths) {
    const importers = importerStmt.all<PathRow>(targetPath);
    for (const r of importers) {
      if (isTestFile(r.from_path) && !testMap.has(r.from_path)) {
        testMap.set(r.from_path, targetPath);
      }
    }
  }
  for (const p of allWillBreak) {
    if (isTestFile(p) && !testMap.has(p)) testMap.set(p, file);
  }

  // [Neubig] Summary mode: return counts and file paths only
  if (summary) {
    const cap = maxResults ?? Infinity;
    return {
      file,
      will_break: { count: allWillBreak.length, files: allWillBreak.slice(0, cap) },
      likely_affected: {
        count: allLikelyAffected.length,
        files: allLikelyAffected.slice(0, cap).map((r) => r.from_path),
      },
      test: { count: testMap.size, files: [...testMap.keys()].sort().slice(0, cap) },
    };
  }

  // [Neubig & Reimers] Build entries with rationale
  const willBreakEntries: ImpactEntry[] = allWillBreak.map((p) => ({
    file: p,
    rationale: `Direct runtime import of ${file}`,
  }));

  // Deduplicate 2-hop entries (same file can be reached via multiple intermediates)
  const seenAffected = new Set<string>();
  const likelyEntries: ImpactEntry[] = [];
  for (const row of allLikelyAffected) {
    if (seenAffected.has(row.from_path)) continue;
    seenAffected.add(row.from_path);
    likelyEntries.push({
      file: row.from_path,
      rationale: `2-hop dependent via ${row.via}`,
    });
  }

  const testEntries: ImpactEntry[] = [...testMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([testFile, covered]) => ({
      file: testFile,
      rationale: `Test file covering ${covered}`,
    }));

  // [Neubig] Apply max_results cap
  const cap = maxResults ?? Infinity;
  const truncated =
    cap < Infinity && (willBreakEntries.length > cap || likelyEntries.length > cap || testEntries.length > cap)
      ? {
          will_break: willBreakEntries.length,
          likely_affected: likelyEntries.length,
          test: testEntries.length,
        }
      : undefined;

  return {
    file,
    will_break: willBreakEntries.slice(0, cap),
    likely_affected: likelyEntries.slice(0, cap),
    test: testEntries.slice(0, cap),
    truncated,
  };
}
