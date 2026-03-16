/**
 * clarte_impact MCP tool (RFC §4.3).
 *
 * "What breaks if I change this?" - downstream impact analysis.
 * Three categories:
 *   WILL BREAK   - direct non-type-only dependents
 *   LIKELY AFFECTED - 2-hop non-type-only dependents
 *   TEST         - test files covering the target + 1-hop dependents
 */

import type { DatabaseAdapter } from "../../storage/db-adapter.js";
import { isTestFile } from "../../core/utils.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface ImpactInput {
  file: string;
}

export interface ImpactOutput {
  file: string;
  will_break: string[];
  likely_affected: string[];
  test: string[];
  error?: string;
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface PathRow {
  from_path: string;
}

interface FileExistsRow {
  path: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Compute the downstream blast radius of modifying a file.
 *
 * - WILL BREAK: files that directly import the target with runtime (non-type-only) edges.
 * - LIKELY AFFECTED: 2-hop dependents (files importing files that import the target),
 *   excluding those already in WILL BREAK and the target itself.
 * - TEST: test files that cover the target or its direct dependents.
 */
export function executeImpact(db: DatabaseAdapter, input: ImpactInput): ImpactOutput {
  const { file } = input;

  // Check file exists in the graph
  const fileCheck = db.prepare("SELECT path FROM files WHERE path = ?");
  const fileRow = fileCheck.get<FileExistsRow>(file);
  if (!fileRow) {
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
  const willBreak = directRows.map((r) => r.from_path).filter((p) => p !== file);

  // 2. LIKELY AFFECTED: 2-hop non-type-only dependents (excluding WILL BREAK and self)
  const twoHopStmt = db.prepare(`
    SELECT DISTINCT fe2.from_path
    FROM file_edges fe1
    JOIN file_edges fe2 ON fe2.to_path = fe1.from_path
    WHERE fe1.to_path = ? AND fe1.is_type_only = 0 AND fe2.is_type_only = 0
      AND fe2.from_path != ?
  `);
  const twoHopRows = twoHopStmt.all<PathRow>(file, file);
  const willBreakSet = new Set(willBreak);
  const likelyAffected = twoHopRows.map((r) => r.from_path).filter((p) => !willBreakSet.has(p));

  // 3. TEST: test files that import the target or any of its direct dependents
  const searchPaths = [file, ...willBreak];
  const testFiles = new Set<string>();

  // Find test files among the direct importers of each path in searchPaths
  const importerStmt = db.prepare("SELECT from_path FROM file_edges WHERE to_path = ?");
  for (const targetPath of searchPaths) {
    const importers = importerStmt.all<PathRow>(targetPath);
    for (const r of importers) {
      if (isTestFile(r.from_path)) {
        testFiles.add(r.from_path);
      }
    }
  }

  // Also check if any file in WILL BREAK is itself a test file
  for (const p of willBreak) {
    if (isTestFile(p)) testFiles.add(p);
  }

  return {
    file,
    will_break: willBreak,
    likely_affected: likelyAffected,
    test: [...testFiles].sort(),
  };
}
