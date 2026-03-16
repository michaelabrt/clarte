/**
 * HITS on the symbol graph (RFC §2.10) and file-level aggregation (RFC §2.9).
 *
 * Runs HITS on symbol nodes with edge-kind weights. File-level metrics are
 * derived by aggregation (max), not computed directly.
 */

import { HITS as HITS_CONFIG } from "../config/thresholds.js";
import { SYMBOL_EDGE_WEIGHTS, type SymbolEdgeKind } from "./symbol-types.js";
import type { ResolvedSymbolEdge } from "./symbol-types.js";

// ── Symbol HITS input/output ──────────────────────────────────────────────────

export interface SymbolNode {
  id: number;
  filePath: string;
  name: string;
  kind: string;
  isBarrel: boolean;
}

export interface SymbolHITSResult {
  /** Per-symbol authority scores (symbol ID -> score) */
  authority: Map<number, number>;
  /** Per-symbol hub scores (symbol ID -> score) */
  hub: Map<number, number>;
}

// ── File-level aggregation output ─────────────────────────────────────────────

export interface FileAggregation {
  /** File authority = max(symbol authorities in file) */
  authority: Map<string, number>;
  /** File hub = max(symbol hubs in file) */
  hubScores: Map<string, number>;
  /**
   * Derived file edges from symbol edges.
   * Key: "from|to", value: { importedNames, isTypeOnly }
   */
  fileEdges: DerivedFileEdge[];
}

export interface DerivedFileEdge {
  fromPath: string;
  toPath: string;
  importedNames: string[];
  isTypeOnly: boolean;
}

// ── Symbol-level HITS ─────────────────────────────────────────────────────────

/**
 * Compute HITS on the symbol graph with edge-kind weights.
 *
 * Each symbol edge contributes its weight (from SYMBOL_EDGE_WEIGHTS) to the
 * authority/hub update. Barrel file symbols get a discount on authority.
 *
 * Same convergence parameters as file-level HITS.
 */
export function computeSymbolHITS(
  symbolNodes: SymbolNode[],
  resolvedEdges: ResolvedSymbolEdge[],
  symbolIdLookup: (file: string, name: string) => number | null,
  maxIterations = HITS_CONFIG.MAX_ITERATIONS,
  epsilon = HITS_CONFIG.EPSILON,
): SymbolHITSResult {
  const n = symbolNodes.length;
  if (n === 0) return { authority: new Map(), hub: new Map() };

  if (n === 1) {
    return {
      authority: new Map([[symbolNodes[0].id, 0.5]]),
      hub: new Map([[symbolNodes[0].id, 0.5]]),
    };
  }

  const alpha = HITS_CONFIG.TELEPORT_ALPHA;
  const baseScore = 1 / n;

  // Map symbol ID to index
  const idToIndex = new Map<number, number>();
  for (let i = 0; i < n; i++) idToIndex.set(symbolNodes[i].id, i);

  // Build weighted forward/reverse adjacency
  const forward: Array<Array<{ to: number; weight: number }>> = Array.from({ length: n }, () => []);
  const reverse: Array<Array<{ from: number; weight: number }>> = Array.from({ length: n }, () => []);

  for (const edge of resolvedEdges) {
    const fromId = symbolIdLookup(edge.fromFile, edge.fromSymbol);
    const toId = symbolIdLookup(edge.toFile, edge.toSymbol);
    if (fromId === null || toId === null) continue;

    const fromIdx = idToIndex.get(fromId);
    const toIdx = idToIndex.get(toId);
    if (fromIdx === undefined || toIdx === undefined) continue;

    const edgeWeight = SYMBOL_EDGE_WEIGHTS[edge.kind as SymbolEdgeKind] ?? 1.0;

    // Barrel discount on authority (target is in a barrel file)
    const toNode = symbolNodes[toIdx];
    const barrelDiscount = toNode.isBarrel ? HITS_CONFIG.BARREL_DISCOUNT : 1.0;

    // Barrel outgoing discount (source is in a barrel file)
    const fromNode = symbolNodes[fromIdx];
    const outgoingDiscount = fromNode.isBarrel ? HITS_CONFIG.BARREL_DISCOUNT : 1.0;

    const weight = edgeWeight * barrelDiscount * outgoingDiscount * edge.confidence;

    forward[fromIdx].push({ to: toIdx, weight });
    reverse[toIdx].push({ from: fromIdx, weight });
  }

  let auth = new Float64Array(n).fill(1);
  let hub = new Float64Array(n).fill(1);

  for (let iter = 0; iter < maxIterations; iter++) {
    const newAuth = new Float64Array(n);
    const newHub = new Float64Array(n);

    // Authority update: auth(v) = alpha * base + (1-alpha) * sum(hub(u) * w(u->v))
    for (let vi = 0; vi < n; vi++) {
      let sum = 0;
      for (const { from, weight } of reverse[vi]) {
        sum += hub[from] * weight;
      }
      newAuth[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // Hub update: hub(v) = alpha * base + (1-alpha) * sum(auth(w) * w(v->w))
    // Uses prior-iteration auth (standard HITS)
    for (let vi = 0; vi < n; vi++) {
      let sum = 0;
      for (const { to, weight } of forward[vi]) {
        sum += auth[to] * weight;
      }
      newHub[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // L2 normalize
    let authNorm = 0;
    let hubNorm = 0;
    for (let i = 0; i < n; i++) {
      authNorm += newAuth[i] * newAuth[i];
      hubNorm += newHub[i] * newHub[i];
    }
    authNorm = Math.sqrt(authNorm) || 1;
    hubNorm = Math.sqrt(hubNorm) || 1;
    for (let i = 0; i < n; i++) {
      newAuth[i] /= authNorm;
      newHub[i] /= hubNorm;
    }

    // Convergence check
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newAuth[i] - auth[i]) + Math.abs(newHub[i] - hub[i]));
    }

    auth = newAuth;
    hub = newHub;

    if (maxDelta < epsilon) break;
  }

  // Min-max normalize to 0-1
  let authMin = Infinity;
  let authMax = -Infinity;
  let hubMin = Infinity;
  let hubMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (auth[i] < authMin) authMin = auth[i];
    if (auth[i] > authMax) authMax = auth[i];
    if (hub[i] < hubMin) hubMin = hub[i];
    if (hub[i] > hubMax) hubMax = hub[i];
  }

  const NORM_EPSILON = 1e-9;
  const authRange = authMax - authMin;
  const hubRange = hubMax - hubMin;

  const authorityMap = new Map<number, number>();
  const hubMap = new Map<number, number>();
  for (let i = 0; i < n; i++) {
    const id = symbolNodes[i].id;
    authorityMap.set(id, authRange > NORM_EPSILON ? (auth[i] - authMin) / authRange : 0.5);
    hubMap.set(id, hubRange > NORM_EPSILON ? (hub[i] - hubMin) / hubRange : 0.5);
  }

  return { authority: authorityMap, hub: hubMap };
}

// ── File-level aggregation from symbol scores ─────────────────────────────────

/**
 * Aggregate symbol-level HITS scores to file level (RFC §2.9).
 * File authority = max symbol authority within the file.
 * File hub score = max symbol hub score within the file.
 */
export function aggregateToFileLevel(
  symbolNodes: SymbolNode[],
  symbolHITS: SymbolHITSResult,
  resolvedEdges: ResolvedSymbolEdge[],
): FileAggregation {
  // Group symbols by file
  const symbolsByFile = new Map<string, SymbolNode[]>();
  for (const node of symbolNodes) {
    let arr = symbolsByFile.get(node.filePath);
    if (!arr) {
      arr = [];
      symbolsByFile.set(node.filePath, arr);
    }
    arr.push(node);
  }

  // File authority/hub = max of symbol scores
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  for (const [filePath, symbols] of symbolsByFile) {
    let maxAuth = 0;
    let maxHub = 0;
    for (const sym of symbols) {
      const a = symbolHITS.authority.get(sym.id) ?? 0;
      const h = symbolHITS.hub.get(sym.id) ?? 0;
      if (a > maxAuth) maxAuth = a;
      if (h > maxHub) maxHub = h;
    }
    authority.set(filePath, maxAuth);
    hubScores.set(filePath, maxHub);
  }

  // Derive file edges from symbol edges
  const fileEdges = deriveFileEdges(resolvedEdges);

  return { authority, hubScores, fileEdges };
}

/**
 * Derive file-level edges from symbol edges (RFC §2.9).
 * If any symbol in file A has an edge to any symbol in file B, create a file edge A -> B.
 * is_type_only is true only if ALL edges from A to B are type-only kinds.
 */
function deriveFileEdges(resolvedEdges: ResolvedSymbolEdge[]): DerivedFileEdge[] {
  const TYPE_ONLY_KINDS = new Set(["implements", "uses_type"]);

  // Group edges by file pair
  const pairMap = new Map<
    string,
    {
      fromPath: string;
      toPath: string;
      symbolNames: Set<string>;
      hasNonTypeOnly: boolean;
    }
  >();

  for (const edge of resolvedEdges) {
    if (edge.fromFile === edge.toFile) continue; // Skip same-file edges

    const key = `${edge.fromFile}|${edge.toFile}`;
    let pair = pairMap.get(key);
    if (!pair) {
      pair = { fromPath: edge.fromFile, toPath: edge.toFile, symbolNames: new Set(), hasNonTypeOnly: false };
      pairMap.set(key, pair);
    }
    pair.symbolNames.add(edge.toSymbol);
    if (!TYPE_ONLY_KINDS.has(edge.kind)) {
      pair.hasNonTypeOnly = true;
    }
  }

  return [...pairMap.values()].map((pair) => ({
    fromPath: pair.fromPath,
    toPath: pair.toPath,
    importedNames: [...pair.symbolNames],
    isTypeOnly: !pair.hasNonTypeOnly,
  }));
}
