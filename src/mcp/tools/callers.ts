/**
 * clarte_callers MCP tool.
 *
 * "Who calls this function?" - BFS caller chain via recursive CTE on symbol_edges.
 * Max depth 5, branching factor 4 (highest authority per level).
 * Tags: DIRECT (depth 1), TRANSITIVE (2-3), DISTANT (4-5).
 * Uses UNION (not UNION ALL) to prevent exponential expansion on cyclic graphs.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter";

// ── Types ────────────────────────────────────────────────────────────────────

export interface CallersInput {
  symbol: string;
  file: string;
}

interface CallerEntry {
  file: string;
  symbol: string;
  kind: string;
  line: number;
  depth: number;
  tag: "DIRECT" | "TRANSITIVE" | "DISTANT";
  /** Graph-derived explanation for why this caller was included */
  rationale: string;
}

export interface CallersOutput {
  symbol: string;
  file: string;
  callers: CallerEntry[];
  error?: string;
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface SymbolIdRow {
  id: number;
}

interface RawCallerRow {
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  depth: number;
  authority: number | null;
}

// ── Depth tagging ────────────────────────────────────────────────────────────

function depthTag(depth: number): "DIRECT" | "TRANSITIVE" | "DISTANT" {
  if (depth === 1) return "DIRECT";
  if (depth <= 3) return "TRANSITIVE";
  return "DISTANT";
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Find all callers of a symbol, up to 5 levels deep.
 *
 * Uses a recursive CTE on symbol_edges to walk the caller chain backwards.
 * UNION deduplicates at each recursion level, preventing exponential expansion
 * when cycles exist (e.g. A calls B calls A). The depth limit is a safety net.
 * Branching factor limited to 4 per level (highest authority) in post-processing.
 */
export function executeCallers(db: DatabaseAdapter, input: CallersInput): CallersOutput {
  const { symbol, file } = input;

  // Resolve target symbol ID
  const targetStmt = db.prepare("SELECT id FROM symbols WHERE file_path = ? AND name = ? LIMIT 1");
  const targetRow = targetStmt.get<SymbolIdRow>(file, symbol);

  if (!targetRow) {
    return {
      symbol,
      file,
      callers: [],
      error: `Symbol not found: ${symbol} in ${file}`,
    };
  }

  const targetId = targetRow.id;

  // UNION (not UNION ALL) deduplicates at each recursion level,
  // preventing O(N^depth) intermediate rows on cyclic graphs.
  const callersStmt = db.prepare(`
    WITH RECURSIVE callers(symbol_id, depth) AS (
      SELECT from_symbol_id, 1
      FROM symbol_edges
      WHERE to_symbol_id = ? AND kind IN ('calls', 'extends')
      UNION
      SELECT se.from_symbol_id, c.depth + 1
      FROM symbol_edges se
      JOIN callers c ON se.to_symbol_id = c.symbol_id
      WHERE c.depth < 5 AND se.kind IN ('calls', 'extends')
    )
    SELECT DISTINCT s.file_path, s.name, s.kind, s.start_line, c.depth, s.authority
    FROM callers c
    JOIN symbols s ON s.id = c.symbol_id
    ORDER BY c.depth, s.authority DESC NULLS LAST, s.file_path
  `);

  const rawCallers = callersStmt.all<RawCallerRow>(targetId);

  // Apply branching factor limit: 4 per depth level (highest authority first)
  const MAX_PER_LEVEL = 4;
  const byDepth = new Map<number, RawCallerRow[]>();
  for (const row of rawCallers) {
    let arr = byDepth.get(row.depth);
    if (!arr) {
      arr = [];
      byDepth.set(row.depth, arr);
    }
    if (arr.length < MAX_PER_LEVEL) {
      arr.push(row);
    }
  }

  const callers: CallerEntry[] = [];
  for (const [, rows] of [...byDepth.entries()].sort((a, b) => a[0] - b[0])) {
    for (const row of rows) {
      const tag = depthTag(row.depth);
      const rationale =
        tag === "DIRECT"
          ? `Direct '${row.kind}' edge: ${row.name}() in ${row.file_path}:${row.start_line}`
          : `${row.depth}-hop transitive '${row.kind}' chain (authority: ${(row.authority ?? 0).toFixed(2)})`;
      callers.push({
        file: row.file_path,
        symbol: row.name,
        kind: row.kind,
        line: row.start_line,
        depth: row.depth,
        tag,
        rationale,
      });
    }
  }

  return { symbol, file, callers };
}
