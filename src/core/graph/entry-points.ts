/**
 * Entry point and terminal node detection for execution flow tracing.
 *
 * Entry points are symbols where execution flows begin: route handlers,
 * exported API functions, event handlers, CLI commands. Terminal nodes
 * are where flows end: leaf functions with no outgoing call edges.
 *
 * Scoring combines four signals: structural (no incoming calls),
 * ghost edges (route targets), framework conventions and HITS hub scores.
 */

import type { InMemorySymbolGraph } from "../../storage/types";
import { ENTRY_POINT_MIN_SCORE, ENTRY_WEIGHTS, FLOW_EDGE_KINDS } from "../config/flow-constants";

// ── Types ────────────────────────────────────────────────────────────────────

export type EntryPointKind = "route_handler" | "api_export" | "event_handler" | "cli_command" | "unknown";

export interface ScoredEntryPoint {
  symbolId: number;
  filePath: string;
  name: string;
  line: number;
  score: number;
  kind: EntryPointKind;
  signals: {
    noCallers: boolean;
    isRouteTarget: boolean;
    frameworkMatch: boolean;
    highHubExported: boolean;
  };
}

export interface TerminalNode {
  symbolId: number;
  filePath: string;
  name: string;
  reason: "no_outgoing" | "cross_package" | "leaf_file";
}

// ── Framework name patterns ──────────────────────────────────────────────────

const ENTRY_PATTERNS = [
  /^handle[A-Z]/,
  /^on[A-Z]/,
  /Handler$/,
  /Controller$/,
  /Route$/,
  /Action$/,
  /Command$/,
  /Middleware$/,
  /^main$/,
  /^app$/,
  /^server$/,
  /^bootstrap$/,
  /^setup$/,
  /^init$/,
];

function matchesFrameworkConvention(name: string): boolean {
  return ENTRY_PATTERNS.some((p) => p.test(name));
}

// ── Entry point detection ────────────────────────────────────────────────────

/**
 * Find and score entry points in the symbol graph.
 *
 * Combines four signals with configurable weights:
 * (a) No incoming `calls` edges + is_exported
 * (b) Ghost:route target (HTTP handlers, CLI commands)
 * (c) Framework convention matching (name patterns)
 * (d) High HITS hub score + exported
 */
export function findScoredEntryPoints(
  symbolGraph: InMemorySymbolGraph,
  fileHubScores: Map<string, number>,
  options?: { minScore?: number },
): ScoredEntryPoint[] {
  const minScore = options?.minScore ?? ENTRY_POINT_MIN_SCORE;
  const results: ScoredEntryPoint[] = [];

  for (const [id, node] of symbolGraph.symbols) {
    if (!node.isExported) continue;
    if (node.kind !== "function" && node.kind !== "method") continue;

    const reverseEdges = symbolGraph.reverse.get(id) ?? [];

    // Signal (a): No incoming calls edges
    const hasIncomingCalls = reverseEdges.some((e) => e.kind === "calls");
    const noCallers = !hasIncomingCalls;

    // Signal (b): Has incoming ghost:route edge
    const isRouteTarget = reverseEdges.some((e) => e.kind === "ghost:route");

    // Signal (c): Name matches framework convention
    const frameworkMatch = matchesFrameworkConvention(node.name);

    // Signal (d): High hub score + exported
    const hubScore = fileHubScores.get(node.filePath) ?? 0;
    const highHubExported = hubScore > 0.5;

    const score =
      ENTRY_WEIGHTS.NO_CALLERS * (noCallers ? 1 : 0) +
      ENTRY_WEIGHTS.ROUTE_TARGET * (isRouteTarget ? 1 : 0) +
      ENTRY_WEIGHTS.FRAMEWORK_MATCH * (frameworkMatch ? 1 : 0) +
      ENTRY_WEIGHTS.HUB_EXPORTED * (highHubExported ? hubScore : 0);

    if (score < minScore) continue;

    const kind = classifyEntryPoint(isRouteTarget, frameworkMatch, highHubExported, node.name);

    results.push({
      symbolId: id,
      filePath: node.filePath,
      name: node.name,
      line: node.startLine,
      score,
      kind,
      signals: { noCallers, isRouteTarget, frameworkMatch, highHubExported },
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results;
}

function classifyEntryPoint(
  isRouteTarget: boolean,
  frameworkMatch: boolean,
  highHub: boolean,
  name: string,
): EntryPointKind {
  if (isRouteTarget) return "route_handler";
  if (frameworkMatch) {
    if (/Command$/i.test(name) || /^main$/.test(name)) return "cli_command";
    if (/^on[A-Z]/.test(name)) return "event_handler";
    return "api_export";
  }
  if (highHub) return "api_export";
  return "unknown";
}

// ── Terminal node detection ──────────────────────────────────────────────────

/**
 * Find terminal (sink) nodes in the symbol graph.
 * A symbol is terminal if it has no outgoing flow edges,
 * or all outgoing flow edges cross a package boundary.
 */
export function findTerminalNodes(symbolGraph: InMemorySymbolGraph, flowEdgeKinds?: Set<string>): TerminalNode[] {
  const kinds = flowEdgeKinds ?? FLOW_EDGE_KINDS;
  const results: TerminalNode[] = [];

  for (const [id, node] of symbolGraph.symbols) {
    const forwardEdges = symbolGraph.forward.get(id) ?? [];
    const flowEdges = forwardEdges.filter((e) => kinds.has(e.kind));

    if (flowEdges.length === 0) {
      results.push({
        symbolId: id,
        filePath: node.filePath,
        name: node.name,
        reason: "no_outgoing",
      });
      continue;
    }

    // Check if all flow edges go to different packages
    const allCrossPackage = flowEdges.every((e) => {
      const targetNode = symbolGraph.symbols.get(e.toSymbolId);
      if (!targetNode) return true;
      return getPackage(node.filePath) !== getPackage(targetNode.filePath);
    });

    if (allCrossPackage) {
      results.push({
        symbolId: id,
        filePath: node.filePath,
        name: node.name,
        reason: "cross_package",
      });
    }
  }

  return results;
}

/**
 * Extract package prefix from a file path.
 * For monorepos: "packages/foo/src/bar.ts" -> "packages/foo"
 * For single repos: "src/bar.ts" -> ""
 */
function getPackage(filePath: string): string {
  const match = filePath.match(/^(packages\/[^/]+)/);
  return match ? match[1] : "";
}
