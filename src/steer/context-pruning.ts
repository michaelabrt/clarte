/**
 * Context pruning.
 *
 * Submodular coverage-based symbol selection that maximizes information
 * density within a token budget. Greedy algorithm with diminishing
 * returns guard and topological presentation ordering.
 */

import type { InMemorySymbolGraph } from "../storage/types";
import type { SymbolSubgraph } from "../core/graph/intent-subgraph";
import {
  MAX_CONTEXT_TOKENS,
  GAMMA_MAX_COVERAGE,
  DIMINISHING_RETURNS_EPSILON,
  SUBMODULAR_FALLBACK_THRESHOLD,
} from "../core/config/intent-constants";

// Pre-computed powers for dist ∈ {0, 1, 2} — avoids ** operator in hot loops
const GAMMA_POWERS = [1, GAMMA_MAX_COVERAGE, GAMMA_MAX_COVERAGE * GAMMA_MAX_COVERAGE];

// ── Types ───────────────────────────────────────────────────────────────────

export interface CoverageState {
  /** symbol_id -> current coverage level [0, 1] */
  covered: Map<number, number>;
  /** Sum of covered values */
  totalCoverage: number;
}

export interface ContextSelection {
  /** Symbol IDs in selection order */
  selectedSymbols: number[];
  /** Total estimated tokens consumed */
  tokenBudgetUsed: number;
  /** gain/cost ratio when greedy stopped */
  marginalGainAtStop: number;
  /** Final f(S) value */
  totalCoverage: number;
}

/** Pre-computed 2-hop neighborhood entry. */
interface NeighborEntry {
  id: number;
  dist: number;
}

// ── Token Cost Estimator ────────────────────────────────────────────────────

/**
 * Count tokens in an identifier by splitting on camelCase, PascalCase
 * and non-alphanumeric boundaries. Uses the same two-rule split as
 * splitCamelCase in targets-resolve.ts:
 *   1. ([a-z])([A-Z])     - standard camelCase: "validateSession" -> 2
 *   2. ([A-Z]+)([A-Z][a-z]) - acronym boundary: "XMLParser" -> 2
 *
 * No stop-word filtering (we want raw token count for cost estimation).
 */
function countIdentifierTokens(name: string): number {
  let count = 0;
  for (const part of name.split(/[^a-zA-Z0-9]+/)) {
    if (!part) continue;
    const camel = part
      .replace(/([a-z])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0")
      .filter(Boolean);
    count += camel.length;
  }
  return count;
}

/** Split a file path into tokens by "/" and ".". */
function countPathTokens(filePath: string): number {
  return filePath.split(/[/.]+/).filter(Boolean).length;
}

/**
 * Estimate the token cost of including a symbol in the context payload.
 *
 * token_cost(s) = |signature_tokens(s)| + |path_tokens(s)| + 5 * |edges(s) ∩ E_tau|
 * Minimum cost: 10 tokens.
 */
export function estimateTokenCost(symbolId: number, symbolGraph: InMemorySymbolGraph, taskEdges: Set<string>): number {
  const node = symbolGraph.symbols.get(symbolId);
  if (!node) return 10;

  const sigTokens = countIdentifierTokens(node.name) + 1; // +1 for the kind token
  const pathTokens = countPathTokens(node.filePath);

  // Count edges in the task subgraph touching this symbol
  let edgeCount = 0;
  for (const key of taskEdges) {
    const sep = key.indexOf("-");
    const from = Number(key.slice(0, sep));
    const to = Number(key.slice(sep + 1));
    if (from === symbolId || to === symbolId) edgeCount++;
  }

  return Math.max(sigTokens + pathTokens + 5 * edgeCount, 10);
}

// ── Structural Reach Computation ────────────────────────────────────────────

/**
 * BFS up to depth 2 from a source node in the subgraph.
 * Returns all reachable nodes with their shortest distance.
 */
function bfs2Hop(sourceId: number, subgraph: SymbolSubgraph): NeighborEntry[] {
  const result: NeighborEntry[] = [{ id: sourceId, dist: 0 }];
  const visited = new Set<number>();
  visited.add(sourceId);

  let frontier = [sourceId];

  for (let depth = 1; depth <= 2; depth++) {
    const next: number[] = [];
    for (const u of frontier) {
      // Forward edges
      for (const edge of subgraph.forward.get(u) ?? []) {
        if (!visited.has(edge.targetId) && subgraph.nodes.has(edge.targetId)) {
          visited.add(edge.targetId);
          next.push(edge.targetId);
          result.push({ id: edge.targetId, dist: depth });
        }
      }
      // Reverse edges
      for (const edge of subgraph.reverse.get(u) ?? []) {
        if (!visited.has(edge.targetId) && subgraph.nodes.has(edge.targetId)) {
          visited.add(edge.targetId);
          next.push(edge.targetId);
          result.push({ id: edge.targetId, dist: depth });
        }
      }
    }
    frontier = next;
  }

  return result;
}

/**
 * Compute structural reach for every symbol in the subgraph.
 * reach(s) = |{v in V_tau : dist(s,v) <= 2}| / |V_tau|
 *
 * Also returns the pre-computed 2-hop neighborhoods (reused by greedy selection).
 */
export function computeStructuralReach(subgraph: SymbolSubgraph): {
  reach: Map<number, number>;
  neighborhoods: Map<number, NeighborEntry[]>;
} {
  const totalNodes = subgraph.nodes.size;
  if (totalNodes === 0) return { reach: new Map(), neighborhoods: new Map() };

  const reach = new Map<number, number>();
  const neighborhoods = new Map<number, NeighborEntry[]>();

  for (const id of subgraph.nodes.keys()) {
    const hood = bfs2Hop(id, subgraph);
    neighborhoods.set(id, hood);
    reach.set(id, hood.length / totalNodes);
  }

  return { reach, neighborhoods };
}

// ── Submodular Coverage Function ────────────────────────────────────────────

/**
 * Compute the marginal gain of adding candidate `candidateId` to the
 * current coverage state.
 *
 * marginal_gain(c) = Σ_{(v, dist) ∈ neighborhoods[c]} max(0, γ^dist - covered[v])
 *
 * γ = GAMMA_MAX_COVERAGE (0.8). This is a weighted max-coverage function:
 * submodular because the max(0, ...) term can only shrink as covered[v] grows.
 */
export function computeMarginalGain(
  candidateId: number,
  neighborhoods: Map<number, NeighborEntry[]>,
  state: CoverageState,
): number {
  const hood = neighborhoods.get(candidateId);
  if (!hood) return 0;

  let gain = 0;
  for (const { id, dist } of hood) {
    const offer = GAMMA_POWERS[dist]; // 1.0 for self (dist=0), 0.8 for dist=1, 0.64 for dist=2
    const current = state.covered.get(id) ?? 0;
    const delta = offer - current;
    if (delta > 0) gain += delta;
  }

  return gain;
}

/**
 * After selecting a symbol, update the coverage state with its neighborhood.
 */
export function applyCoverage(
  selectedId: number,
  neighborhoods: Map<number, NeighborEntry[]>,
  state: CoverageState,
): void {
  const hood = neighborhoods.get(selectedId);
  if (!hood) return;

  for (const { id, dist } of hood) {
    const offer = GAMMA_POWERS[dist];
    const current = state.covered.get(id) ?? 0;
    if (offer > current) {
      state.totalCoverage += offer - current;
      state.covered.set(id, offer);
    }
  }
}

// ── Greedy Symbol Selection ─────────────────────────────────────────────────

/**
 * Select context symbols using the submodular greedy algorithm.
 *
 * For subgraphs exceeding SUBMODULAR_FALLBACK_THRESHOLD (2000 nodes),
 * falls back to a simpler top-K by intent score (at most 2 per file).
 */
export function selectContextSymbols(
  subgraph: SymbolSubgraph,
  intentScores: Map<number, number>,
  symbolGraph: InMemorySymbolGraph,
  taskEdgeKeys: Set<string>,
  budgetTokens: number = MAX_CONTEXT_TOKENS,
): ContextSelection {
  const empty: ContextSelection = {
    selectedSymbols: [],
    tokenBudgetUsed: 0,
    marginalGainAtStop: 0,
    totalCoverage: 0,
  };

  if (subgraph.nodes.size === 0 || budgetTokens <= 0) return empty;

  // Large subgraph fallback: top-K by intent score, max 2 per file
  if (subgraph.nodes.size > SUBMODULAR_FALLBACK_THRESHOLD) {
    return topKFallback(subgraph, intentScores, symbolGraph, taskEdgeKeys, budgetTokens);
  }

  // Pre-compute neighborhoods (shared with structural reach)
  const { neighborhoods } = computeStructuralReach(subgraph);

  // Pre-compute token costs for all candidates
  const costs = new Map<number, number>();
  for (const id of subgraph.nodes.keys()) {
    costs.set(id, estimateTokenCost(id, symbolGraph, taskEdgeKeys));
  }

  // Initialize coverage state
  const state: CoverageState = {
    covered: new Map(),
    totalCoverage: 0,
  };

  const selected: number[] = [];
  const candidates = [...subgraph.nodes.keys()];
  let remainingBudget = budgetTokens;
  let firstRatio: number | null = null;
  let lastRatio = 0;

  // Greedy loop with shrinking candidate array (swap-remove on selection)
  while (remainingBudget > 0 && candidates.length > 0) {
    let bestIdx = -1;
    let bestRatio = 0;

    for (let i = 0; i < candidates.length; i++) {
      const id = candidates[i];
      const cost = costs.get(id) ?? 10;
      if (cost > remainingBudget) continue;

      const gain = computeMarginalGain(id, neighborhoods, state);
      const ratio = gain / cost;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestIdx = i;
      }
    }

    if (bestIdx === -1) break;

    const bestId = candidates[bestIdx];

    // Diminishing returns guard
    if (firstRatio === null) {
      firstRatio = bestRatio;
    } else if (bestRatio < DIMINISHING_RETURNS_EPSILON * firstRatio) {
      lastRatio = bestRatio;
      break;
    }

    selected.push(bestId);
    // Swap-remove: replace selected with last element, shrink array
    candidates[bestIdx] = candidates[candidates.length - 1];
    candidates.pop();
    remainingBudget -= costs.get(bestId) ?? 10;
    applyCoverage(bestId, neighborhoods, state);
    lastRatio = bestRatio;
  }

  return {
    selectedSymbols: selected,
    tokenBudgetUsed: budgetTokens - remainingBudget,
    marginalGainAtStop: lastRatio,
    totalCoverage: state.totalCoverage,
  };
}

/** Top-K fallback for large subgraphs (>2000 nodes). */
function topKFallback(
  subgraph: SymbolSubgraph,
  intentScores: Map<number, number>,
  symbolGraph: InMemorySymbolGraph,
  taskEdgeKeys: Set<string>,
  budgetTokens: number,
): ContextSelection {
  // Sort by intent score descending
  const candidates = [...subgraph.nodes.keys()].sort((a, b) => (intentScores.get(b) ?? 0) - (intentScores.get(a) ?? 0));

  const selected: number[] = [];
  const fileCounts = new Map<string, number>();
  let used = 0;

  for (const id of candidates) {
    const node = symbolGraph.symbols.get(id) ?? subgraph.nodes.get(id);
    if (!node) continue;

    const fileCount = fileCounts.get(node.filePath) ?? 0;
    if (fileCount >= 2) continue; // Max 2 per file

    const cost = estimateTokenCost(id, symbolGraph, taskEdgeKeys);
    if (used + cost > budgetTokens) continue;

    selected.push(id);
    used += cost;
    fileCounts.set(node.filePath, fileCount + 1);
  }

  return {
    selectedSymbols: selected,
    tokenBudgetUsed: used,
    marginalGainAtStop: 0,
    totalCoverage: 0,
  };
}

// ── Presentation Ordering ───────────────────────────────────────────────────

/**
 * Order selected symbols for presentation to maximize LLM attention.
 *
 * Uses topological dependency flow (roots before leaves) rather than a
 * "sandwich layout" (high-value at top and bottom). Dependency flow
 * gives the LLM a coherent mental model: entry points first, then the
 * functions they call, then the implementations those depend on.
 *
 * 1. Compute topological depth via BFS from in-degree-0 roots (forward edges only).
 * 2. Sort by: topological depth (asc), intent score (desc), authority (desc), path (asc).
 */
export function orderForPresentation(
  selectedSymbols: number[],
  subgraph: SymbolSubgraph,
  intentScores: Map<number, number>,
  symbolGraph: InMemorySymbolGraph,
): number[] {
  if (selectedSymbols.length <= 1) return [...selectedSymbols];

  const selectedSet = new Set(selectedSymbols);

  // Compute in-degree within the selected set (forward edges only)
  const inDegree = new Map<number, number>();
  for (const id of selectedSymbols) inDegree.set(id, 0);

  for (const id of selectedSymbols) {
    for (const edge of subgraph.forward.get(id) ?? []) {
      if (selectedSet.has(edge.targetId)) {
        inDegree.set(edge.targetId, (inDegree.get(edge.targetId) ?? 0) + 1);
      }
    }
  }

  // BFS from roots (in-degree 0) to compute topological depth
  const depth = new Map<number, number>();
  const roots: number[] = [];

  for (const [id, deg] of inDegree) {
    if (deg === 0) {
      roots.push(id);
      depth.set(id, 0);
    }
  }

  let frontier = roots;
  let currentDepth = 0;

  while (frontier.length > 0) {
    const next: number[] = [];
    currentDepth++;
    for (const u of frontier) {
      for (const edge of subgraph.forward.get(u) ?? []) {
        if (selectedSet.has(edge.targetId) && !depth.has(edge.targetId)) {
          depth.set(edge.targetId, currentDepth);
          next.push(edge.targetId);
        }
      }
    }
    frontier = next;
  }

  // Symbols not reachable from any root get depth = Infinity
  for (const id of selectedSymbols) {
    if (!depth.has(id)) depth.set(id, Infinity);
  }

  // Sort: depth asc, intent desc, authority desc, filePath asc
  return [...selectedSymbols].sort((a, b) => {
    const da = depth.get(a) ?? Infinity;
    const db = depth.get(b) ?? Infinity;
    if (da !== db) return da - db;

    const ia = intentScores.get(a) ?? 0;
    const ib = intentScores.get(b) ?? 0;
    if (ia !== ib) return ib - ia;

    const nodeA = symbolGraph.symbols.get(a);
    const nodeB = symbolGraph.symbols.get(b);
    const authA = nodeA?.authority ?? 0;
    const authB = nodeB?.authority ?? 0;
    if (authA !== authB) return authB - authA;

    const pathA = nodeA?.filePath ?? "";
    const pathB = nodeB?.filePath ?? "";
    return pathA.localeCompare(pathB);
  });
}
