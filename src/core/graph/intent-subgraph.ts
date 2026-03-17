/**
 * RFC-002 §1.4, §6.1 Stage 3: Symbol subgraph extraction.
 *
 * Extracts the k-hop neighborhood from seed symbols in the symbol graph
 * using multi-source BFS. Operates entirely on the in-memory symbol graph
 * loaded by GraphStore.loadSymbolGraph() - no SQLite I/O.
 */

import type { InMemorySymbolGraph, InMemorySymbolNode, InMemorySymEdge } from "../../storage/types";
import { SYMBOL_EDGE_WEIGHTS, type SymbolEdgeKind } from "./symbol-types";
import { HITS } from "../config/thresholds";

// ── Types ───────────────────────────────────────────────────────────────────

export interface SymbolSubEdge {
  targetId: number;
  kind: SymbolEdgeKind;
  /** SYMBOL_EDGE_WEIGHTS[kind] * barrel_discount * confidence */
  weight: number;
  /** Resolution tier confidence */
  confidence: number;
  /** True when Dijkstra would traverse this edge against the original direction */
  isReverse: boolean;
}

export interface SymbolSubgraph {
  /** symbol_id -> node */
  nodes: Map<number, InMemorySymbolNode>;
  /** source -> outgoing edges (original graph direction) */
  forward: Map<number, SymbolSubEdge[]>;
  /** target -> incoming edges (reverse view for Dijkstra traversal) */
  reverse: Map<number, SymbolSubEdge[]>;
  /** All files touched by nodes in this subgraph */
  fileSet: Set<string>;
  /** Original seed symbol IDs */
  seedIds: Set<number>;
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function isValidEdgeKind(kind: string): kind is SymbolEdgeKind {
  return kind in SYMBOL_EDGE_WEIGHTS;
}

function computeEdgeWeight(edge: InMemorySymEdge, sourceIsBarrel: boolean, targetIsBarrel: boolean): number {
  if (!isValidEdgeKind(edge.kind)) return 0;
  const barrelDiscount = sourceIsBarrel || targetIsBarrel ? HITS.BARREL_DISCOUNT : 1.0;
  return SYMBOL_EDGE_WEIGHTS[edge.kind] * barrelDiscount * (edge.confidence ?? 1.0);
}

// ── Main extraction ─────────────────────────────────────────────────────────

/**
 * Extract the k-hop symbol neighborhood from seed files via multi-source BFS.
 *
 * Phase 1: BFS discovers all reachable symbols within maxHops
 * (both forward and reverse edges used for discovery).
 *
 * Phase 2: Collect all original-graph edges where both endpoints are
 * in the discovered set. Build forward/reverse adjacency lists.
 */
export function extractSymbolSubgraph(
  seedFiles: string[],
  symbolGraph: InMemorySymbolGraph,
  maxHops: number,
): SymbolSubgraph {
  const seedIds = new Set<number>();
  const visited = new Set<number>();

  // Resolve seed files to seed symbol IDs
  for (const file of seedFiles) {
    for (const id of symbolGraph.byFile.get(file) ?? []) {
      if (!symbolGraph.symbols.has(id)) continue;
      seedIds.add(id);
      visited.add(id);
    }
  }

  // Empty seed set -> empty subgraph
  if (seedIds.size === 0) {
    return {
      nodes: new Map(),
      forward: new Map(),
      reverse: new Map(),
      fileSet: new Set(),
      seedIds,
    };
  }

  // ── Phase 1: Multi-source BFS for node discovery ────────────────────────

  let frontier = new Set(seedIds);

  for (let hop = 0; hop < maxHops; hop++) {
    const next = new Set<number>();

    for (const symId of frontier) {
      // Forward edges (dependencies)
      for (const edge of symbolGraph.forward.get(symId) ?? []) {
        if (!visited.has(edge.toSymbolId) && symbolGraph.symbols.has(edge.toSymbolId)) {
          visited.add(edge.toSymbolId);
          next.add(edge.toSymbolId);
        }
      }
      // Reverse edges (importers)
      for (const edge of symbolGraph.reverse.get(symId) ?? []) {
        if (!visited.has(edge.fromSymbolId) && symbolGraph.symbols.has(edge.fromSymbolId)) {
          visited.add(edge.fromSymbolId);
          next.add(edge.fromSymbolId);
        }
      }
    }

    frontier = next;
    if (frontier.size === 0) break;
  }

  // ── Phase 2: Build subgraph from discovered nodes ───────────────────────

  const nodes = new Map<number, InMemorySymbolNode>();
  const fileSet = new Set<string>();
  const forward = new Map<number, SymbolSubEdge[]>();
  const reverse = new Map<number, SymbolSubEdge[]>();

  // Barrel detection via index file naming heuristic.
  // We only scan discovered nodes, not the full symbol graph.
  const barrelPaths = new Set<string>();

  for (const id of visited) {
    const node = symbolGraph.symbols.get(id);
    if (!node) continue;
    nodes.set(id, node);
    fileSet.add(node.filePath);
    const base = node.filePath.split("/").pop() ?? "";
    if (/^index\.[jt]sx?$/.test(base)) barrelPaths.add(node.filePath);
  }

  // Collect all original-graph edges where both endpoints are discovered.
  // Only iterate forward edges; this gives us each edge exactly once.
  for (const sourceId of visited) {
    const sourceNode = nodes.get(sourceId);
    if (!sourceNode) continue;
    const sourceIsBarrel = barrelPaths.has(sourceNode.filePath);

    for (const edge of symbolGraph.forward.get(sourceId) ?? []) {
      if (!visited.has(edge.toSymbolId)) continue;
      if (!isValidEdgeKind(edge.kind)) continue;

      const targetNode = nodes.get(edge.toSymbolId);
      if (!targetNode) continue;
      const targetIsBarrel = barrelPaths.has(targetNode.filePath);
      const weight = computeEdgeWeight(edge, sourceIsBarrel, targetIsBarrel);
      const confidence = edge.confidence ?? 1.0;
      const kind = edge.kind as SymbolEdgeKind;

      // Forward adjacency: sourceId -> toSymbolId (original direction, isReverse=false)
      let fwdList = forward.get(sourceId);
      if (!fwdList) {
        fwdList = [];
        forward.set(sourceId, fwdList);
      }
      fwdList.push({ targetId: edge.toSymbolId, kind, weight, confidence, isReverse: false });

      // Reverse adjacency: toSymbolId has incoming from sourceId (isReverse=true).
      // Dijkstra at toSymbolId can traverse this to reach sourceId against the edge direction.
      let revList = reverse.get(edge.toSymbolId);
      if (!revList) {
        revList = [];
        reverse.set(edge.toSymbolId, revList);
      }
      revList.push({ targetId: sourceId, kind, weight, confidence, isReverse: true });
    }
  }

  return { nodes, forward, reverse, fileSet, seedIds };
}
