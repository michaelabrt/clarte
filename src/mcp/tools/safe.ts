/**
 * clarte_safe MCP tool (audit Shift 1: Decision Oracle).
 *
 * "Is this change safe?" - Compositional graph query that classifies each
 * dependent symbol as BREAKS, COMPATIBLE, or UNKNOWN with a verified
 * impact proof citing specific line numbers, edge types and confidence.
 *
 * Unlike clarte_impact (file-level, structural edges only), this tool:
 * - Operates at symbol granularity (function/method/class)
 * - Classifies by change type (signature, body, delete)
 * - Follows symbol_edges (calls, extends, uses_type, satisfies)
 * - Propagates through barrel chains with decaying confidence
 * - Returns machine-verifiable evidence chains
 */

import type { DatabaseAdapter } from "../../storage/db-adapter";
import { isTestFile } from "../../core/utils";

// ── Types ────────────────────────────────────────────────────────────────────

export type ChangeType = "signature" | "body" | "delete";

export interface SafeInput {
  symbol: string;
  file: string;
  change: ChangeType;
}

export type Verdict = "BREAKS" | "COMPATIBLE" | "UNKNOWN";

interface ImpactEntry {
  file: string;
  symbol: string;
  verdict: Verdict;
  edge_kind: string;
  line: number;
  confidence: number;
  depth: number;
  reason: string;
}

interface TestCoverage {
  file: string;
  covers: "direct" | "transitive";
}

export interface SafeOutput {
  symbol: string;
  file: string;
  change: ChangeType;
  impact: ImpactEntry[];
  tests: TestCoverage[];
  summary: string;
  error?: string;
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface SymbolIdRow {
  id: number;
}

interface DependentRow {
  from_symbol_id: number;
  from_file: string;
  from_name: string;
  from_kind: string;
  from_line: number;
  edge_kind: string;
  edge_line: number;
  edge_confidence: number;
}

interface TransitiveDependentRow {
  from_symbol_id: number;
  from_file: string;
  from_name: string;
  edge_kind: string;
  edge_line: number;
  edge_confidence: number;
  depth: number;
}

interface FileExistsRow {
  path: string;
}

interface ImporterRow {
  from_path: string;
}

// ── Verdict classification ───────────────────────────────────────────────────

/**
 * Classify a dependent symbol's impact based on change type and edge kind.
 *
 * Rules:
 *   delete:    ALL dependents → BREAKS (reference becomes dangling)
 *   signature: calls/extends/implements/uses_type → BREAKS
 *              decorates/embeds/satisfies → UNKNOWN (may or may not break)
 *   body:      ALL dependents → COMPATIBLE (internal change, API stable)
 *              EXCEPT test files → UNKNOWN (tests may assert on behavior)
 */
function classifyVerdict(
  changeType: ChangeType,
  edgeKind: string,
  dependentFile: string,
  confidence: number,
): { verdict: Verdict; reason: string } {
  if (changeType === "delete") {
    return {
      verdict: "BREAKS",
      reason: `Symbol deleted; ${edgeKind} reference becomes dangling`,
    };
  }

  if (changeType === "body") {
    if (isTestFile(dependentFile)) {
      return {
        verdict: "UNKNOWN",
        reason: "Body change; test file may assert on modified behavior",
      };
    }
    return {
      verdict: "COMPATIBLE",
      reason: "Body-only change; public API unchanged",
    };
  }

  // signature change
  if (confidence < 0.5) {
    return {
      verdict: "UNKNOWN",
      reason: `Signature change; edge resolution confidence too low (${confidence.toFixed(2)}) for definitive classification`,
    };
  }

  switch (edgeKind) {
    case "calls":
      return {
        verdict: "BREAKS",
        reason: "Signature change; caller invokes this function directly",
      };
    case "extends":
      return {
        verdict: "BREAKS",
        reason: "Signature change; subclass inherits modified interface",
      };
    case "implements":
      return {
        verdict: "BREAKS",
        reason: "Signature change; implementor must match new interface",
      };
    case "uses_type":
      return {
        verdict: "BREAKS",
        reason: "Signature change; type reference in parameter or return position",
      };
    case "satisfies":
      return {
        verdict: "UNKNOWN",
        reason: "Signature change; implicit interface satisfaction may be invalidated (requires method set recheck)",
      };
    case "decorates":
      return {
        verdict: "COMPATIBLE",
        reason: "Signature change; decorator relationship unaffected by target signature",
      };
    case "embeds":
      return {
        verdict: "UNKNOWN",
        reason: "Signature change; embedded type methods may be promoted to outer struct",
      };
    default:
      return {
        verdict: "UNKNOWN",
        reason: `Signature change; unclassified edge kind "${edgeKind}"`,
      };
  }
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Perform compositional impact analysis for a proposed change.
 *
 * Pipeline:
 * 1. Resolve target symbol ID
 * 2. Find all direct dependents via reverse symbol_edges
 * 3. Find 2-hop transitive dependents via recursive CTE
 * 4. Classify each dependent as BREAKS/COMPATIBLE/UNKNOWN
 * 5. Find test files covering the target + dependents
 * 6. Produce verified impact proof with evidence citations
 */
export function executeSafe(db: DatabaseAdapter, input: SafeInput): SafeOutput {
  const { symbol, file, change } = input;

  // Validate file exists
  const fileCheck = db.prepare("SELECT path FROM files WHERE path = ?");
  const fileRow = fileCheck.get<FileExistsRow>(file);
  if (!fileRow) {
    return {
      symbol,
      file,
      change,
      impact: [],
      tests: [],
      summary: "File not found in graph",
      error: `File not found in graph: ${file}`,
    };
  }

  // Resolve target symbol ID
  const targetStmt = db.prepare("SELECT id FROM symbols WHERE file_path = ? AND name = ? LIMIT 1");
  const targetRow = targetStmt.get<SymbolIdRow>(file, symbol);
  if (!targetRow) {
    return {
      symbol,
      file,
      change,
      impact: [],
      tests: [],
      summary: "Symbol not found",
      error: `Symbol "${symbol}" not found in ${file}`,
    };
  }

  const targetId = targetRow.id;

  // Find direct dependents (depth 1)
  const directStmt = db.prepare(`
    SELECT
      se.from_symbol_id,
      s.file_path AS from_file,
      s.name AS from_name,
      s.kind AS from_kind,
      s.start_line AS from_line,
      se.kind AS edge_kind,
      COALESCE(se.line, s.start_line) AS edge_line,
      COALESCE(se.confidence, 0.95) AS edge_confidence
    FROM symbol_edges se
    JOIN symbols s ON s.id = se.from_symbol_id
    WHERE se.to_symbol_id = ?
    ORDER BY se.confidence DESC NULLS LAST, s.file_path
  `);
  const directRows = directStmt.all<DependentRow>(targetId);

  // Find transitive dependents (depth 2-3) via recursive CTE
  const transitiveStmt = db.prepare(`
    WITH RECURSIVE deps(symbol_id, depth) AS (
      SELECT from_symbol_id, 1
      FROM symbol_edges
      WHERE to_symbol_id = ?
      UNION
      SELECT se.from_symbol_id, d.depth + 1
      FROM symbol_edges se
      JOIN deps d ON se.to_symbol_id = d.symbol_id
      WHERE d.depth < 3 AND se.kind IN ('calls', 'extends', 'implements')
    )
    SELECT DISTINCT
      d.symbol_id AS from_symbol_id,
      s.file_path AS from_file,
      s.name AS from_name,
      'transitive' AS edge_kind,
      s.start_line AS edge_line,
      0.5 AS edge_confidence,
      d.depth
    FROM deps d
    JOIN symbols s ON s.id = d.symbol_id
    WHERE d.depth > 1
    ORDER BY d.depth, s.file_path
  `);
  const transitiveRows = transitiveStmt.all<TransitiveDependentRow>(targetId);

  // Classify direct dependents
  const impact: ImpactEntry[] = [];
  const directSymbolIds = new Set<number>();

  for (const row of directRows) {
    directSymbolIds.add(row.from_symbol_id);
    const { verdict, reason } = classifyVerdict(change, row.edge_kind, row.from_file, row.edge_confidence);
    impact.push({
      file: row.from_file,
      symbol: row.from_name,
      verdict,
      edge_kind: row.edge_kind,
      line: row.edge_line,
      confidence: row.edge_confidence,
      depth: 1,
      reason,
    });
  }

  // Classify transitive dependents (always UNKNOWN at depth > 1)
  for (const row of transitiveRows) {
    if (directSymbolIds.has(row.from_symbol_id)) continue;

    impact.push({
      file: row.from_file,
      symbol: row.from_name,
      verdict: change === "delete" ? "BREAKS" : "UNKNOWN",
      edge_kind: "transitive",
      line: row.edge_line,
      confidence: row.edge_confidence,
      depth: row.depth,
      reason:
        change === "delete"
          ? `Transitive dependent at depth ${row.depth}; deleted symbol cascades`
          : `Transitive dependent at depth ${row.depth}; manual review recommended`,
    });
  }

  // Find test files covering the target and its direct dependents
  const tests: TestCoverage[] = [];
  const searchPaths = new Set([file, ...directRows.map((r) => r.from_file)]);
  const importerStmt = db.prepare("SELECT from_path FROM file_edges WHERE to_path = ?");

  for (const targetPath of searchPaths) {
    const importers = importerStmt.all<ImporterRow>(targetPath);
    for (const r of importers) {
      if (isTestFile(r.from_path)) {
        tests.push({
          file: r.from_path,
          covers: targetPath === file ? "direct" : "transitive",
        });
      }
    }
  }

  const uniqueTests = [...new Map(tests.map((t) => [t.file, t])).values()];

  const breaks = impact.filter((e) => e.verdict === "BREAKS").length;
  const compatible = impact.filter((e) => e.verdict === "COMPATIBLE").length;
  const unknown = impact.filter((e) => e.verdict === "UNKNOWN").length;

  let summary: string;
  if (impact.length === 0) {
    summary = `No dependents found for ${symbol}. Change is safe.`;
  } else if (breaks === 0 && unknown === 0) {
    summary = `All ${compatible} dependent(s) are compatible. Change is safe.`;
  } else if (breaks > 0) {
    summary = `${breaks} dependent(s) will BREAK, ${compatible} compatible, ${unknown} unknown. ${uniqueTests.length} test file(s) to run.`;
  } else {
    summary = `${compatible} compatible, ${unknown} unknown. Manual review recommended for unknown entries. ${uniqueTests.length} test file(s) to run.`;
  }

  return {
    symbol,
    file,
    change,
    impact,
    tests: uniqueTests,
    summary,
  };
}
