/**
 * Execution flow tracing engine.
 *
 * Composes dominator trees, k-diverse-shortest-paths and community-aware
 * path annotation into a complete flow tracing pipeline. Given a target
 * file/symbol, identifies entry-to-terminal execution flows with mandatory
 * waypoints, community transitions and confidence scores.
 */

import type { InMemorySymbolGraph, LeanFileGraph } from "../../storage/types";
import type { CommunityInfo } from "./flow-annotation";
import type { ScoredEntryPoint, TerminalNode } from "./entry-points";
import { computeDominatorTree, dominates } from "./dominator";
import { kShortestPaths } from "./k-shortest-paths";
import { annotateCommunities } from "./flow-annotation";
import { findScoredEntryPoints, findTerminalNodes } from "./entry-points";
import { getEdgeWeight } from "./symbol-types";
import {
  MAX_FLOW_DEPTH,
  MAX_FLOWS,
  K_DIVERSE_PATHS,
  FLOW_EDGE_KINDS,
  FLOW_GHOST_DISCOUNT,
  MIN_FLOW_LENGTH,
  MAX_ENTRY_TERMINAL_PAIRS,
  FLOW_SUBGRAPH_MAX_NODES,
  COMPRESSION_BETWEENNESS_PERCENTILE,
} from "../config/flow-constants";

// ── Types ────────────────────────────────────────────────────────────────────

export interface FlowTraceOptions {
  maxFlows?: number;
  maxDepth?: number;
  kPaths?: number;
  compress?: boolean;
}

export interface FlowNode {
  symbolId: number;
  file: string;
  name: string;
  line: number;
  communityId: number | null;
  communityLabel: string | null;
  isDominator: boolean;
  isBoundary: boolean;
}

export interface FlowEdge {
  fromId: number;
  toId: number;
  kind: string;
}

export interface ExecutionFlowTrace {
  entryPoint: ScoredEntryPoint;
  terminal: TerminalNode | null;
  nodes: FlowNode[];
  edges: FlowEdge[];
  confidence: number;
  communityTransitions: string[];
  summary: string;
}

// ── Flow adjacency builder ───────────────────────────────────────────────────

interface FlowAdj {
  target: number;
  kind: string;
}

function buildFlowAdjacency(symbolGraph: InMemorySymbolGraph): {
  adjacency: Map<number, FlowAdj[]>;
  reverseAdj: Map<number, number[]>;
  nodeCount: number;
} {
  const adjacency = new Map<number, FlowAdj[]>();
  const reverseAdj = new Map<number, number[]>();
  const allNodes = new Set<number>();

  for (const [fromId, edges] of symbolGraph.forward) {
    for (const e of edges) {
      if (!FLOW_EDGE_KINDS.has(e.kind)) continue;
      allNodes.add(fromId);
      allNodes.add(e.toSymbolId);

      let fwd = adjacency.get(fromId);
      if (!fwd) {
        fwd = [];
        adjacency.set(fromId, fwd);
      }
      fwd.push({ target: e.toSymbolId, kind: e.kind });

      let rev = reverseAdj.get(e.toSymbolId);
      if (!rev) {
        rev = [];
        reverseAdj.set(e.toSymbolId, rev);
      }
      rev.push(fromId);
    }
  }

  return { adjacency, reverseAdj, nodeCount: allNodes.size };
}

// ── BFS reachability ─────────────────────────────────────────────────────────

function bfsReachable(start: Set<number>, adj: Map<number, FlowAdj[] | number[]>, maxHops: number): Set<number> {
  const visited = new Set<number>(start);
  let frontier = [...start];

  for (let hop = 0; hop < maxHops && frontier.length > 0; hop++) {
    const next: number[] = [];
    for (const node of frontier) {
      const neighbors = adj.get(node);
      if (!neighbors) continue;
      for (const n of neighbors) {
        const id = typeof n === "number" ? n : n.target;
        if (!visited.has(id)) {
          visited.add(id);
          next.push(id);
        }
      }
    }
    frontier = next;
  }

  return visited;
}

// ── Community label inference ─────────────────────────────────────────────────

/**
 * Build community labels from the most common directory among each community's files.
 * E.g. community 0 has files mostly in "src/auth/" -> label "auth".
 */
function buildCommunityLabels(fileGraph: LeanFileGraph): Map<number, string> {
  const dirCounts = new Map<number, Map<string, number>>();

  for (const [path, fileNode] of fileGraph.nodes) {
    if (fileNode.communityId == null) continue;
    if (!dirCounts.has(fileNode.communityId)) {
      dirCounts.set(fileNode.communityId, new Map());
    }
    const dir = parentDir(path);
    const counts = dirCounts.get(fileNode.communityId) as Map<string, number>;
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }

  const labels = new Map<number, string>();
  for (const [communityId, counts] of dirCounts) {
    let bestDir = "";
    let bestCount = 0;
    for (const [dir, count] of counts) {
      if (count > bestCount) {
        bestDir = dir;
        bestCount = count;
      }
    }
    if (bestDir) labels.set(communityId, bestDir);
  }

  return labels;
}

function parentDir(filePath: string): string {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash === -1) return filePath;
  const dir = filePath.slice(0, lastSlash);
  const lastSegment = dir.slice(dir.lastIndexOf("/") + 1);
  return lastSegment || dir;
}

// ── Edge weight function ─────────────────────────────────────────────────────

function flowEdgeWeight(_from: number, _to: number, kind: string): number {
  const base = getEdgeWeight(kind);
  const discount = kind.startsWith("ghost:") ? FLOW_GHOST_DISCOUNT : 1.0;
  return -Math.log(base * discount);
}

// ── Betweenness compression ──────────────────────────────────────────────────

/**
 * Compress a flow path into a summary string.
 * High-betweenness nodes, dominators and community boundaries are shown
 * by name. Low-betweenness chains are collapsed to "[N calls]".
 */
export function compressFlowPath(
  nodes: FlowNode[],
  fileBetweenness: Map<string, number>,
  percentileThreshold?: number,
): string {
  if (nodes.length === 0) return "";
  if (nodes.length <= 2) return nodes.map((n) => n.name).join(" -> ");

  const threshold = computeBetweennessThreshold(
    fileBetweenness,
    percentileThreshold ?? COMPRESSION_BETWEENNESS_PERCENTILE,
  );
  const parts: string[] = [];
  let buffer = 0;

  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    const isFirst = i === 0;
    const isLast = i === nodes.length - 1;
    const bet = fileBetweenness.get(n.file) ?? 0;
    const isWaypoint = isFirst || isLast || n.isDominator || n.isBoundary || bet > threshold;

    if (isWaypoint) {
      if (buffer > 0) {
        parts.push(`[${buffer} calls]`);
        buffer = 0;
      }
      if (n.isBoundary && n.communityLabel) {
        parts.push(`[${n.communityLabel}]`);
      }
      parts.push(n.name);
    } else {
      buffer++;
    }
  }

  if (buffer > 0) {
    parts.push(`[${buffer} calls]`);
  }

  return parts.join(" -> ");
}

function computeBetweennessThreshold(fileBetweenness: Map<string, number>, percentile: number): number {
  const values = [...fileBetweenness.values()].sort((a, b) => a - b);
  if (values.length === 0) return 0;
  const idx = Math.floor(values.length * percentile);
  return values[Math.min(idx, values.length - 1)];
}

// ── Main orchestrator ────────────────────────────────────────────────────────

/**
 * Trace execution flows through a target file or symbol.
 *
 * Pipeline:
 * 1. Build flow-filtered adjacency from symbol graph
 * 2. Find entry points and terminals
 * 3. For each (entry, terminal) pair:
 *    a. Compute dominator tree from entry
 *    b. Find k-diverse shortest paths
 *    c. Filter to paths passing through target
 *    d. Annotate with communities, mark dominators
 * 4. Rank by confidence, compress summaries, return top flows
 */
export function traceExecutionFlows(
  targetFiles: string[],
  targetSymbol: string | undefined,
  symbolGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  options?: FlowTraceOptions,
): ExecutionFlowTrace[] {
  const maxFlows = options?.maxFlows ?? MAX_FLOWS;
  const maxDepth = options?.maxDepth ?? MAX_FLOW_DEPTH;
  const kPaths = options?.kPaths ?? K_DIVERSE_PATHS;
  const compress = options?.compress ?? true;

  // Step 1: Resolve target symbol IDs
  const targetSymbolIds = new Set<number>();
  for (const file of targetFiles) {
    const ids = symbolGraph.byFile.get(file) ?? [];
    for (const id of ids) {
      const node = symbolGraph.symbols.get(id);
      if (node && (!targetSymbol || node.name === targetSymbol)) {
        targetSymbolIds.add(id);
      }
    }
  }
  if (targetSymbolIds.size === 0) return [];

  // Step 2: Build flow-filtered adjacency
  const { adjacency, reverseAdj, nodeCount } = buildFlowAdjacency(symbolGraph);

  // Safety valve: fall back to simple BFS if graph is too large
  if (nodeCount > FLOW_SUBGRAPH_MAX_NODES) return [];

  // Step 3: Find entry points reachable (backward) from target
  const fileHubScores = new Map<string, number>();
  for (const [path, node] of fileGraph.nodes) {
    fileHubScores.set(path, node.hubScore);
  }
  const allEntryPoints = findScoredEntryPoints(symbolGraph, fileHubScores);
  const reachableFromTarget = bfsReachable(targetSymbolIds, reverseAdj, maxDepth);
  const reachableEntries = allEntryPoints.filter((ep) => reachableFromTarget.has(ep.symbolId));

  // Step 4: Find terminals reachable (forward) from target
  const allTerminals = findTerminalNodes(symbolGraph);
  const reachableForward = bfsReachable(targetSymbolIds, adjacency, maxDepth);
  const reachableTerminals = allTerminals.filter((t) => reachableForward.has(t.symbolId));

  // Step 5: Build dominator-forward adjacency for dominator tree
  const dominatorForward = new Map<number, number[]>();
  const dominatorReverse = new Map<number, number[]>();
  for (const [fromId, targets] of adjacency) {
    const ids = targets.map((t) => t.target);
    dominatorForward.set(fromId, ids);
    for (const toId of ids) {
      let rev = dominatorReverse.get(toId);
      if (!rev) {
        rev = [];
        dominatorReverse.set(toId, rev);
      }
      rev.push(fromId);
    }
  }

  // Step 6: Community lookup with directory-based labels
  const communityLabels = buildCommunityLabels(fileGraph);
  const communityLookup = (nodeId: number): CommunityInfo | null => {
    const node = symbolGraph.symbols.get(nodeId);
    if (!node) return null;
    const fileNode = fileGraph.nodes.get(node.filePath);
    if (!fileNode || fileNode.communityId == null) return null;
    return { communityId: fileNode.communityId, label: communityLabels.get(fileNode.communityId) ?? null };
  };

  // Step 7: Betweenness map
  const fileBetweenness = new Map<string, number>();
  for (const [path, node] of fileGraph.nodes) {
    fileBetweenness.set(path, node.betweenness);
  }

  // Step 8: Generate flows per (entry, terminal) pair
  const flows: ExecutionFlowTrace[] = [];
  let pairCount = 0;

  const topEntries = reachableEntries.slice(0, 3);
  const topTerminals = reachableTerminals.slice(0, 3);

  // Also allow entry-to-target flows (no terminal required)
  if (topTerminals.length === 0) {
    for (const entry of topEntries) {
      if (pairCount >= MAX_ENTRY_TERMINAL_PAIRS) break;
      pairCount++;

      const domTree = computeDominatorTree(entry.symbolId, dominatorForward, dominatorReverse);
      const paths = kShortestPaths(adjacency, flowEdgeWeight, entry.symbolId, [...targetSymbolIds][0], kPaths);

      for (const path of paths) {
        if (path.nodes.length - 1 < MIN_FLOW_LENGTH) continue;
        const flow = buildFlowTrace(
          path.nodes,
          path.edgeKinds,
          path.confidence,
          entry,
          null,
          domTree.idom,
          domTree.children,
          communityLookup,
          symbolGraph,
          fileBetweenness,
          compress,
        );
        if (flow) flows.push(flow);
      }
    }
  }

  for (const entry of topEntries) {
    for (const terminal of topTerminals) {
      if (pairCount >= MAX_ENTRY_TERMINAL_PAIRS) break;
      pairCount++;

      const domTree = computeDominatorTree(entry.symbolId, dominatorForward, dominatorReverse);
      const paths = kShortestPaths(adjacency, flowEdgeWeight, entry.symbolId, terminal.symbolId, kPaths);

      for (const path of paths) {
        if (path.nodes.length - 1 < MIN_FLOW_LENGTH) continue;
        // Filter to paths that pass through a target symbol
        const passesTarget = path.nodes.some((n) => targetSymbolIds.has(n));
        if (!passesTarget && targetFiles.length > 1) continue;

        const flow = buildFlowTrace(
          path.nodes,
          path.edgeKinds,
          path.confidence,
          entry,
          terminal,
          domTree.idom,
          domTree.children,
          communityLookup,
          symbolGraph,
          fileBetweenness,
          compress,
        );
        if (flow) flows.push(flow);
      }
    }
  }

  // Rank by confidence descending
  flows.sort((a, b) => b.confidence - a.confidence);
  return flows.slice(0, maxFlows);
}

// ── Flow construction ────────────────────────────────────────────────────────

function buildFlowTrace(
  pathNodes: number[],
  pathEdgeKinds: string[],
  confidence: number,
  entry: ScoredEntryPoint,
  terminal: TerminalNode | null,
  idom: Map<number, number>,
  domChildren: Map<number, number[]>,
  communityLookup: (nodeId: number) => CommunityInfo | null,
  symbolGraph: InMemorySymbolGraph,
  fileBetweenness: Map<string, number>,
  compress: boolean,
): ExecutionFlowTrace | null {
  const annotated = annotateCommunities(pathNodes, communityLookup);

  // A node is a dominator waypoint if it has children in the dominator tree
  // (meaning other nodes are forced through it). Entry is excluded since it
  // trivially dominates everything.
  const pathTerminus = pathNodes[pathNodes.length - 1];
  const dominatorSet = new Set<number>();
  for (const nodeId of pathNodes) {
    if (nodeId === entry.symbolId) continue;
    if (domChildren.has(nodeId) && dominates(nodeId, pathTerminus, idom)) {
      dominatorSet.add(nodeId);
    }
  }

  const nodes: FlowNode[] = [];
  for (let i = 0; i < pathNodes.length; i++) {
    const symNode = symbolGraph.symbols.get(pathNodes[i]);
    if (!symNode) return null;
    const ann = annotated[i];

    nodes.push({
      symbolId: pathNodes[i],
      file: symNode.filePath,
      name: symNode.name,
      line: symNode.startLine,
      communityId: ann.communityId,
      communityLabel: ann.communityLabel,
      isDominator: dominatorSet.has(pathNodes[i]),
      isBoundary: ann.isBoundary,
    });
  }

  // Build edges from path
  const edges: FlowEdge[] = [];
  for (let i = 0; i < pathNodes.length - 1; i++) {
    edges.push({
      fromId: pathNodes[i],
      toId: pathNodes[i + 1],
      kind: pathEdgeKinds[i] ?? "calls",
    });
  }

  const transitions: string[] = [];
  for (const n of nodes) {
    if (n.isBoundary && n.communityLabel) {
      transitions.push(n.communityLabel);
    }
  }

  const summary = compress ? compressFlowPath(nodes, fileBetweenness) : nodes.map((n) => n.name).join(" -> ");

  return {
    entryPoint: entry,
    terminal,
    nodes,
    edges,
    confidence,
    communityTransitions: transitions,
    summary,
  };
}
