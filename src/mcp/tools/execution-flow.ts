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
import { traceMarkovFlow } from "../../core/graph/markov-flow";

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
let cachedCouplingIndex: Map<string, number> | null = null;
let cachedDbMtime = 0;

let cachedBlameData: Map<number, number> | null = null;

function loadGraphs(
  db: DatabaseAdapter,
  dbMtimeMs: number,
): {
  symGraph: InMemorySymbolGraph;
  fileGraph: LeanFileGraph;
  couplingIndex: Map<string, number>;
  blameData: Map<number, number> | null;
} {
  if (cachedSymGraph && cachedFileGraph && cachedCouplingIndex && dbMtimeMs === cachedDbMtime) {
    return {
      symGraph: cachedSymGraph,
      fileGraph: cachedFileGraph,
      couplingIndex: cachedCouplingIndex,
      blameData: cachedBlameData,
    };
  }

  const store = new GraphStore(db);
  cachedSymGraph = store.loadSymbolGraph();
  cachedFileGraph = store.loadFileGraphLean();

  // Load blame data for Markov flow temporal decay
  const headCommit = store.getMeta("head_commit");
  cachedBlameData = headCommit ? store.loadSymbolBlame(headCommit) : null;

  // Build change coupling index for Markov flow temporal decay
  const couplingRows = store.loadChangeCoupling();
  cachedCouplingIndex = new Map<string, number>();
  for (const row of couplingRows) {
    const key = row.file_a < row.file_b ? `${row.file_a}||${row.file_b}` : `${row.file_b}||${row.file_a}`;
    if (row.last_cochange_days != null) {
      cachedCouplingIndex.set(key, row.last_cochange_days);
    }
  }

  cachedDbMtime = dbMtimeMs;
  return {
    symGraph: cachedSymGraph,
    fileGraph: cachedFileGraph,
    couplingIndex: cachedCouplingIndex,
    blameData: cachedBlameData,
  };
}

/** Reset cache (for testing). */
export function _resetFlowCache(): void {
  cachedSymGraph = null;
  cachedFileGraph = null;
  cachedCouplingIndex = null;
  cachedBlameData = null;
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
  input: { file: string; symbol?: string; maxFlows?: number; maxDepth?: number; mode?: "dominator" | "markov" },
): ExecutionFlowResponse {
  const { symGraph, fileGraph, couplingIndex, blameData } = loadGraphs(db, dbMtimeMs);

  if (input.mode === "markov") {
    return executeMarkovFlow(input.file, input.symbol, symGraph, fileGraph, couplingIndex, blameData);
  }

  const flows = traceExecutionFlows([input.file], input.symbol, symGraph, fileGraph, {
    maxFlows: input.maxFlows,
    maxDepth: input.maxDepth,
  });

  return formatResponse(input.file, input.symbol, flows);
}

function executeMarkovFlow(
  file: string,
  symbol: string | undefined,
  symGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  couplingIndex: Map<string, number>,
  blameData: Map<number, number> | null,
): ExecutionFlowResponse {
  // Find entry symbol ID from file + optional symbol name
  const fileSymIds = symGraph.byFile.get(file) ?? [];
  let entryId: number | undefined;
  for (const id of fileSymIds) {
    const node = symGraph.symbols.get(id);
    if (node && (!symbol || node.name === symbol)) {
      entryId = id;
      break;
    }
  }

  if (entryId === undefined) {
    return { file, symbol, flowCount: 0, flows: [] };
  }

  const sig = traceMarkovFlow(entryId, symGraph, fileGraph, couplingIndex, blameData ?? undefined);

  return {
    file,
    symbol,
    flowCount: sig.states.length > 0 ? 1 : 0,
    flows:
      sig.states.length > 0
        ? [
            {
              summary: sig.summary,
              confidence: 1.0 - sig.residualMass,
              entryPoint: {
                file,
                symbol: symGraph.symbols.get(entryId)?.name ?? "",
                kind: "markov",
              },
              terminal: null,
              communityPath: [],
              dominatorWaypoints: [],
              steps: sig.states.map((s) => ({
                file: s.file,
                symbol: s.name,
                line: symGraph.symbols.get(s.symbolId)?.startLine ?? 0,
                edgeKind: "markov",
                community: null,
                isDominator: false,
              })),
            },
          ]
        : [],
  };
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
        edgeKind: i === 0 ? "entry" : (f.edges[i - 1]?.kind ?? "calls"),
        community: n.communityLabel,
        isDominator: n.isDominator,
      })),
    })),
  };
}
