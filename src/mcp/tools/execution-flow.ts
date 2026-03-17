/**
 * Execution flow tracing MCP tool.
 *
 * Traces entry-to-terminal execution flows through a file or symbol using
 * dominator trees (mandatory waypoints), k-diverse-shortest-paths (distinct
 * routes) and community-aware path annotation (architectural context).
 *
 * Replaces the previous SQL-based 5-hop BFS with an in-memory graph algorithm
 * pipeline that leverages the full symbol graph, ghost edges, HITS scores,
 * betweenness centrality and Leiden communities.
 */

import type { DatabaseAdapter } from "../../storage/db-adapter";
import type { InMemorySymbolGraph, LeanFileGraph } from "../../storage/types";
import { GraphStore } from "../../storage/graph-store";
import { traceExecutionFlows } from "../../core/graph/flow-trace";
import type { ExecutionFlowTrace } from "../../core/graph/flow-trace";

// ── Legacy types (consumed by render-task-context.ts) ────────────────────────

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

// ── Module-level cache (mtime-invalidated) ───────────────────────────────────

let cachedSymGraph: InMemorySymbolGraph | null = null;
let cachedFileGraph: LeanFileGraph | null = null;
let cachedDbMtime = 0;

function loadGraphs(
  db: DatabaseAdapter,
  dbMtimeMs: number,
): { symGraph: InMemorySymbolGraph; fileGraph: LeanFileGraph } {
  if (cachedSymGraph && cachedFileGraph && dbMtimeMs === cachedDbMtime) {
    return { symGraph: cachedSymGraph, fileGraph: cachedFileGraph };
  }

  const store = new GraphStore(db);
  cachedSymGraph = store.loadSymbolGraph();
  cachedFileGraph = store.loadFileGraphLean();
  cachedDbMtime = dbMtimeMs;

  return { symGraph: cachedSymGraph, fileGraph: cachedFileGraph };
}

/** Reset cache (for testing). */
export function _resetFlowCache(): void {
  cachedSymGraph = null;
  cachedFileGraph = null;
  cachedDbMtime = 0;
}

// ── Response types ───────────────────────────────────────────────────────────

export interface ExecutionFlowResponse {
  file: string;
  symbol?: string;
  flowCount: number;
  flows: Array<{
    summary: string;
    confidence: number;
    entryPoint: { file: string; symbol: string; kind: string };
    terminal: { file: string; symbol: string } | null;
    communityPath: string[];
    dominatorWaypoints: Array<{ file: string; symbol: string }>;
    steps: Array<{
      file: string;
      symbol: string;
      line: number;
      edgeKind: string;
      community: string | null;
      isDominator: boolean;
    }>;
  }>;
}

// ── Implementation ───────────────────────────────────────────────────────────

export function executeExecutionFlow(
  db: DatabaseAdapter,
  dbMtimeMs: number,
  input: { file: string; symbol?: string; maxFlows?: number; maxDepth?: number },
): ExecutionFlowResponse {
  const { symGraph, fileGraph } = loadGraphs(db, dbMtimeMs);

  const flows = traceExecutionFlows([input.file], input.symbol, symGraph, fileGraph, {
    maxFlows: input.maxFlows,
    maxDepth: input.maxDepth,
  });

  return formatResponse(input.file, input.symbol, flows);
}

function formatResponse(file: string, symbol: string | undefined, flows: ExecutionFlowTrace[]): ExecutionFlowResponse {
  return {
    file,
    symbol,
    flowCount: flows.length,
    flows: flows.map((f) => ({
      summary: f.summary,
      confidence: f.confidence,
      entryPoint: {
        file: f.entryPoint.filePath,
        symbol: f.entryPoint.name,
        kind: f.entryPoint.kind,
      },
      terminal: f.terminal ? { file: f.terminal.filePath, symbol: f.terminal.name } : null,
      communityPath: f.communityTransitions,
      dominatorWaypoints: f.nodes.filter((n) => n.isDominator).map((n) => ({ file: n.file, symbol: n.name })),
      steps: f.nodes.map((n, i) => ({
        file: n.file,
        symbol: n.name,
        line: n.line,
        edgeKind: i === 0 ? "entry" : "calls", // TODO: preserve edge kinds from path
        community: n.communityLabel,
        isDominator: n.isDominator,
      })),
    })),
  };
}
