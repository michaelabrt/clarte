/**
 * Execution flow tracing (RFC §4.5).
 *
 * Computes forward execution flows (entry point -> ... -> target) by traversing
 * the symbol_edges table via recursive CTE. Entry points are functions with
 * zero incoming 'calls' edges from project-internal files.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FlowStep {
  file: string;
  symbol: string;
  line: number;
  depth: number;
  edgeKind: string;
}

export interface ExecutionFlow {
  entryPoint: { file: string; symbol: string; line: number };
  steps: FlowStep[];
}

// ── SQL row types ────────────────────────────────────────────────────────────

interface EntryPointRow {
  id: number;
  file_path: string;
  name: string;
  start_line: number;
}

interface FlowRow {
  file_path: string;
  name: string;
  start_line: number;
  depth: number;
  edge_kind: string;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Identify entry points: functions/methods with no incoming 'calls' edges.
 * These are the roots of execution flows (e.g. HTTP handlers, CLI commands).
 */
export function findEntryPoints(db: DatabaseAdapter): EntryPointRow[] {
  const stmt = db.prepare(`
    SELECT s.id, s.file_path, s.name, s.start_line
    FROM symbols s
    WHERE s.kind IN ('function', 'method')
      AND NOT EXISTS (
        SELECT 1 FROM symbol_edges se
        WHERE se.to_symbol_id = s.id AND se.kind = 'calls'
      )
    ORDER BY s.file_path, s.start_line
  `);
  return stmt.all<EntryPointRow>();
}

/**
 * Trace a forward execution flow from a given symbol.
 *
 * Walks the symbol_edges forward (from_symbol_id -> to_symbol_id) via recursive
 * CTE, limited to 5 hops. Returns the call chain with depth annotations.
 */
export function traceForwardFlow(db: DatabaseAdapter, entrySymbolId: number): FlowStep[] {
  const stmt = db.prepare(`
    WITH RECURSIVE flow(symbol_id, depth, edge_kind) AS (
      SELECT to_symbol_id, 1, kind
      FROM symbol_edges
      WHERE from_symbol_id = ? AND kind IN ('calls', 'extends')
      UNION ALL
      SELECT se.to_symbol_id, f.depth + 1, se.kind
      FROM symbol_edges se
      JOIN flow f ON se.from_symbol_id = f.symbol_id
      WHERE f.depth < 5 AND se.kind IN ('calls', 'extends')
    )
    SELECT DISTINCT s.file_path, s.name, s.start_line, f.depth, f.edge_kind
    FROM flow f
    JOIN symbols s ON s.id = f.symbol_id
    ORDER BY f.depth, s.file_path
  `);

  const rows = stmt.all<FlowRow>(entrySymbolId);
  return rows.map((r) => ({
    file: r.file_path,
    symbol: r.name,
    line: r.start_line,
    depth: r.depth,
    edgeKind: r.edge_kind,
  }));
}

/**
 * Compute execution flows for a set of target files.
 *
 * Finds entry points among symbols in the target files, then traces forward
 * flows from each. Returns at most `maxFlows` flows.
 */
export function computeExecutionFlows(db: DatabaseAdapter, targetFiles: string[], maxFlows = 3): ExecutionFlow[] {
  const targetSet = new Set(targetFiles);
  const entryPoints = findEntryPoints(db);

  // Filter to entry points in the target files
  const relevantEntries = entryPoints.filter((ep) => targetSet.has(ep.file_path));
  const flows: ExecutionFlow[] = [];

  for (const ep of relevantEntries) {
    if (flows.length >= maxFlows) break;

    const steps = traceForwardFlow(db, ep.id);
    if (steps.length === 0) continue;

    // Only include flows that reach another target file
    const reachesOtherTarget = steps.some((s) => targetSet.has(s.file) && s.file !== ep.file_path);
    if (!reachesOtherTarget && targetFiles.length > 1) continue;

    flows.push({
      entryPoint: {
        file: ep.file_path,
        symbol: ep.name,
        line: ep.start_line,
      },
      steps,
    });
  }

  return flows;
}
