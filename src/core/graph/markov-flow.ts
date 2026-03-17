/**
 * Probabilistic execution flow tracing.
 *
 * Demand-driven Markov Chain model where the call graph acts as an absorbing
 * state machine. Transition probabilities fuse edge weights, HITS authority
 * and git change coupling with exponential time-decay.
 *
 * Domain-Terminal Filter: cross-community utility sinks (loggers, formatters)
 * with high indegree receive a UTILITY_TERMINAL_PENALTY weight multiplier
 * to keep probability mass circulating within the actual domain logic.
 *
 * Lazy matrix evaluation: transition rows are computed on-demand the first
 * time a node receives probability mass, then cached. Memory footprint is
 * O(|E_visited|) instead of O(|E|). Row cache is explicitly cleared after
 * propagation completes.
 *
 * This module is a pure mathematical service: it does not import from the
 * steer layer. Context selection (submodular pruning) is the caller's
 * responsibility via the returned visitedSubgraph.
 */

import type { InMemorySymbolGraph, InMemorySymbolNode, LeanFileGraph } from "../../storage/types";
import type { SymbolSubgraph, SymbolSubEdge } from "./intent-subgraph";
import type { ExtendedEdgeKind } from "./symbol-types";
import { getEdgeWeight } from "./symbol-types";
import { FLOW_EDGE_KINDS } from "../config/flow-constants";
import { compressFlowPath, type FlowNode } from "./flow-trace";
import {
  MARKOV_AUTHORITY_BETA,
  MARKOV_AUTHORITY_FLOOR,
  MARKOV_TEMPORAL_FLOOR,
  MARKOV_TEMPORAL_LAMBDA,
  MARKOV_CONVERGENCE_EPSILON,
  MARKOV_MAX_STEPS,
  MARKOV_VISIT_THRESHOLD,
  MARKOV_MAX_FLOW_STATES,
  MARKOV_MASS_FLOOR,
} from "../config/proximity-constants";
import { computeINF } from "./inf-attenuation";
import { BLAME_LAMBDA, BLAME_FLOOR, BLAME_DEFAULT_DAYS } from "../config/semantic-constants";

// ── Types ────────────────────────────────────────────────────────────────────

interface TransitionRow {
  targets: number[];
  weights: number[];
}

export interface PropagationResult {
  /** Cumulative visit probability per symbol (transitive + absorbed) */
  visits: Map<number, number>;
  /** Per-terminal absorption probability */
  absorbed: Map<number, number>;
  /** Iterations to convergence (or max steps) */
  steps: number;
  /** Unabsorbed mass remaining on cyclic nodes at termination */
  residualMass: number;
}

export interface FlowState {
  symbolId: number;
  file: string;
  name: string;
  visitProbability: number;
  authority: number;
}

export interface FlowSignature {
  entrySymbolId: number;
  states: FlowState[];
  absorptionProbabilities: Map<number, number>;
  convergenceSteps: number;
  residualMass: number;
  /** Subgraph of visited nodes for downstream context selection (caller responsibility) */
  visitedSubgraph: SymbolSubgraph;
  summary: string;
}

// ── Absorbing state classification ───────────────────────────────────────────

/**
 * Classify absorbing states: symbols with no outgoing flow-eligible edges.
 * O(|V| + |E|).
 */
export function classifyAbsorbing(symbolGraph: InMemorySymbolGraph): Set<number> {
  const absorbing = new Set<number>();

  for (const [symbolId] of symbolGraph.symbols) {
    const edges = symbolGraph.forward.get(symbolId);
    if (!edges) {
      absorbing.add(symbolId);
      continue;
    }
    const hasFlowEdge = edges.some((e) => FLOW_EDGE_KINDS.has(e.kind));
    if (!hasFlowEdge) absorbing.add(symbolId);
  }

  return absorbing;
}

// ── Lazy transition row computation ──────────────────────────────────────────

/**
 * Compute a single row of the transition matrix on-demand.
 * Returns null for nodes with no flow-eligible outgoing edges.
 *
 * Each raw weight combines four factors:
 *   w(u,v) = s(kind) * confidence * alpha(v)^beta * tau(u,v)
 * where s = edge kind weight, alpha = HITS authority with floor,
 * beta = MARKOV_AUTHORITY_BETA, and tau = exponential time-decay
 * on git change coupling between the source and target files.
 *
 * Row stochasticity: raw weights are L1-normalized so the row sums to 1.0,
 * making each row a valid probability distribution over successors.
 *
 * Domain-Terminal Filter: if a target is absorbing, outside the entry's
 * Leiden community, and has indegree >= UTILITY_INDEGREE_THRESHOLD,
 * its weight is penalized by UTILITY_TERMINAL_PENALTY before row
 * normalization. This redistributes mass toward domain-relevant targets
 * and prevents loggers/formatters from absorbing disproportionate probability.
 */
export function computeTransitionRow(
  symbolId: number,
  symbolGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  changeCouplingIndex: Map<string, number>,
  entryCommunity: number | null,
  absorbing: Set<number>,
  symbolBlame?: Map<number, number>,
  edgePriors?: Map<string, number>,
): TransitionRow | null {
  const edges = symbolGraph.forward.get(symbolId);
  if (!edges) return null;

  const node = symbolGraph.symbols.get(symbolId);
  if (!node) return null;

  const totalSymbols = symbolGraph.symbols.size;
  const targets: number[] = [];
  const rawWeights: number[] = [];

  for (const edge of edges) {
    if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;

    const targetNode = symbolGraph.symbols.get(edge.toSymbolId);
    if (!targetNode) continue;

    // s(k): edge kind weight
    const s = getEdgeWeight(edge.kind);
    // c: resolution confidence
    const c = edge.confidence ?? 0.5;
    // alpha(v)^beta: authority with floor
    const alpha = Math.max(targetNode.authority ?? 0, MARKOV_AUTHORITY_FLOOR);

    // tau: exponential temporal decay on change coupling
    const couplingKey =
      node.filePath < targetNode.filePath
        ? `${node.filePath}||${targetNode.filePath}`
        : `${targetNode.filePath}||${node.filePath}`;
    const lastDays = changeCouplingIndex.get(couplingKey);
    const tau =
      lastDays !== undefined
        ? Math.max(MARKOV_TEMPORAL_FLOOR, Math.exp(-MARKOV_TEMPORAL_LAMBDA * lastDays))
        : MARKOV_TEMPORAL_FLOOR;

    // Blame-boundary temporal decay: per-symbol recency factor
    const blameDays = symbolBlame?.get(edge.toSymbolId) ?? BLAME_DEFAULT_DAYS;
    const tauBlame = symbolBlame ? Math.max(BLAME_FLOOR, Math.exp(-BLAME_LAMBDA * blameDays)) : 1.0;

    let raw = s * c * alpha ** MARKOV_AUTHORITY_BETA * tau * tauBlame;

    // INF Edge Attenuation: continuous, information-theoretic replacement for
    // the hardcoded Domain-Terminal Filter. Uses directed indegree/outdegree
    // to penalize pure utility sinks while preserving flow through hubs.
    const targetIndegree = symbolGraph.reverse.get(edge.toSymbolId)?.length ?? 0;
    const targetOutdegree = (symbolGraph.forward.get(edge.toSymbolId) ?? []).filter((e) =>
      FLOW_EDGE_KINDS.has(e.kind),
    ).length;
    raw *= computeINF(targetIndegree, targetOutdegree, totalSymbols);

    // Bayesian edge prior: EWMA-learned co-change probability modulates
    // the transition weight. Neutral priors (0.5) cancel out after row
    // normalization; only differential priors shift the distribution.
    if (edgePriors) {
      const priorKey = `${node.filePath}||${targetNode.filePath}`;
      const prior = edgePriors.get(priorKey);
      if (prior !== undefined) raw *= prior;
    }

    targets.push(edge.toSymbolId);
    rawWeights.push(raw);
  }

  if (targets.length === 0) return null;

  // Normalize to stochastic row
  const sum = rawWeights.reduce((a, b) => a + b, 0);
  if (sum === 0) return null;
  const weights = rawWeights.map((w) => w / sum);

  return { targets, weights };
}

// ── Forward propagation ──────────────────────────────────────────────────────

/**
 * Forward propagation through the absorbing Markov chain.
 *
 * Lazy evaluation: transition rows are computed on-demand when a node first
 * receives probability mass, then cached. Memory: O(|E_visited|).
 *
 * Convergence check precedes visit accumulation to prevent double-counting:
 * if total mass < epsilon, the loop breaks and residual mass is flushed
 * exactly once by the post-loop handler.
 */
export function propagateAbsorbing(
  entryId: number,
  symbolGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  changeCouplingIndex: Map<string, number>,
  entryCommunity: number | null,
  absorbing: Set<number>,
  maxSteps: number = MARKOV_MAX_STEPS,
  epsilon: number = MARKOV_CONVERGENCE_EPSILON,
  symbolBlame?: Map<number, number>,
  edgePriors?: Map<string, number>,
): PropagationResult {
  const visits = new Map<number, number>();
  const absorbed = new Map<number, number>();
  const rowCache = new Map<number, TransitionRow | null>();

  let pi = new Map<number, number>();
  pi.set(entryId, 1.0);

  let steps = 0;

  for (steps = 0; steps < maxSteps; steps++) {
    // Check convergence BEFORE accumulation to prevent double-counting
    // when the loop breaks: residual handler below adds pi exactly once.
    let totalMass = 0;
    for (const mass of pi.values()) totalMass += mass;
    if (totalMass < epsilon) break;

    // Accumulate current mass into visits (each pi vector counted once)
    for (const [u, mass] of pi) {
      visits.set(u, (visits.get(u) ?? 0) + mass);
    }

    const piNext = new Map<number, number>();

    for (const [u, mass] of pi) {
      if (mass < MARKOV_MASS_FLOOR) continue;

      // Absorbing nodes: mass is absorbed (already counted in visits above)
      if (absorbing.has(u)) {
        absorbed.set(u, (absorbed.get(u) ?? 0) + mass);
        continue;
      }

      // Lazy row computation with cache
      let row = rowCache.get(u);
      if (row === undefined) {
        row = computeTransitionRow(
          u,
          symbolGraph,
          fileGraph,
          changeCouplingIndex,
          entryCommunity,
          absorbing,
          symbolBlame,
          edgePriors,
        );
        rowCache.set(u, row);
      }

      if (!row) {
        // No outgoing flow edges but not classified absorbing (edge case)
        absorbed.set(u, (absorbed.get(u) ?? 0) + mass);
        continue;
      }

      for (let i = 0; i < row.targets.length; i++) {
        const target = row.targets[i];
        const transferMass = mass * row.weights[i];

        if (absorbing.has(target)) {
          absorbed.set(target, (absorbed.get(target) ?? 0) + transferMass);
          // Also record in visits so flow signature includes terminals
          visits.set(target, (visits.get(target) ?? 0) + transferMass);
        } else {
          piNext.set(target, (piNext.get(target) ?? 0) + transferMass);
        }
      }
    }

    pi = piNext;
  }

  // Residual mass: flush remaining probability on non-converged cyclic nodes.
  // Safe because the convergence check above breaks BEFORE accumulation,
  // so pi has not been counted in visits yet.
  let residualMass = 0;
  for (const [u, mass] of pi) {
    visits.set(u, (visits.get(u) ?? 0) + mass);
    residualMass += mass;
  }

  // Explicitly release the row cache (O(|E_visited|) memory)
  rowCache.clear();

  return { visits, absorbed, steps, residualMass };
}

// ── Subgraph extraction ──────────────────────────────────────────────────────

/**
 * Build a SymbolSubgraph from visited nodes for submodular pruning.
 * Extracts the induced subgraph over symbols with visit probability above threshold.
 */
function buildVisitedSubgraph(
  visits: Map<number, number>,
  symbolGraph: InMemorySymbolGraph,
  threshold: number,
): SymbolSubgraph {
  const nodes = new Map<number, InMemorySymbolNode>();
  const forward = new Map<number, SymbolSubEdge[]>();
  const reverse = new Map<number, SymbolSubEdge[]>();
  const fileSet = new Set<string>();
  const seedIds = new Set<number>();

  // Collect nodes above threshold
  for (const [symbolId, prob] of visits) {
    if (prob < threshold) continue;
    const node = symbolGraph.symbols.get(symbolId);
    if (!node) continue;
    nodes.set(symbolId, node);
    fileSet.add(node.filePath);
    seedIds.add(symbolId);
  }

  // Extract induced edges (forward direction only within visited set)
  for (const [symbolId] of nodes) {
    const edges = symbolGraph.forward.get(symbolId);
    if (!edges) continue;

    for (const edge of edges) {
      if (!nodes.has(edge.toSymbolId)) continue;
      if (!FLOW_EDGE_KINDS.has(edge.kind)) continue;

      const subEdge: SymbolSubEdge = {
        targetId: edge.toSymbolId,
        kind: edge.kind as ExtendedEdgeKind,
        confidence: edge.confidence ?? 0.5,
        isReverse: false,
        isBarrelRouted: false,
      };

      let fwd = forward.get(symbolId);
      if (!fwd) {
        fwd = [];
        forward.set(symbolId, fwd);
      }
      fwd.push(subEdge);

      // Reverse view for submodular pruning BFS
      const revEdge: SymbolSubEdge = {
        targetId: symbolId,
        kind: edge.kind as ExtendedEdgeKind,
        confidence: edge.confidence ?? 0.5,
        isReverse: true,
        isBarrelRouted: false,
      };
      let rev = reverse.get(edge.toSymbolId);
      if (!rev) {
        rev = [];
        reverse.set(edge.toSymbolId, rev);
      }
      rev.push(revEdge);
    }
  }

  return { nodes, forward, reverse, fileSet, seedIds };
}

// ── Greedy path reconstruction ───────────────────────────────────────────────

/**
 * Reconstruct a concrete execution path by greedily following the
 * highest-probability transition at each step. Stops at an absorbing
 * state, a cycle, or when maxLength is reached.
 *
 * This produces a real execution path (connected sequence of calls)
 * suitable for compression, unlike probability-sorted states which
 * may not form a connected path.
 */
export function reconstructGreedyPath(
  entryId: number,
  symbolGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  changeCouplingIndex: Map<string, number>,
  entryCommunity: number | null,
  absorbing: Set<number>,
  maxLength: number,
  symbolBlame?: Map<number, number>,
  edgePriors?: Map<string, number>,
): number[] {
  const path: number[] = [entryId];
  const visited = new Set<number>([entryId]);
  let current = entryId;

  for (let step = 0; step < maxLength; step++) {
    if (absorbing.has(current)) break;

    const row = computeTransitionRow(
      current,
      symbolGraph,
      fileGraph,
      changeCouplingIndex,
      entryCommunity,
      absorbing,
      symbolBlame,
      edgePriors,
    );
    if (!row || row.targets.length === 0) break;

    // Follow the highest-probability transition
    let bestIdx = 0;
    for (let j = 1; j < row.weights.length; j++) {
      if (row.weights[j] > row.weights[bestIdx]) bestIdx = j;
    }
    const next = row.targets[bestIdx];

    if (visited.has(next)) break;
    path.push(next);
    visited.add(next);
    current = next;
  }

  return path;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Trace a probabilistic execution flow from an entry symbol.
 *
 * Pipeline:
 * 1. Classify absorbing states (zero flow-outdegree)
 * 2. Forward-propagate through the absorbing Markov chain (lazy rows)
 * 3. Build induced subgraph from visited nodes
 * 4. Compress into a FlowSignature with betweenness-weighted summary
 *
 * Context selection (submodular pruning) is NOT performed here; the caller
 * receives the visited subgraph via FlowSignature.visitedSubgraph and is
 * responsible for running selectContextSymbols from the steer layer.
 * This keeps core/graph free of steer-layer dependencies.
 */
export function traceMarkovFlow(
  entryId: number,
  symbolGraph: InMemorySymbolGraph,
  fileGraph: LeanFileGraph,
  changeCouplingIndex: Map<string, number>,
  symbolBlame?: Map<number, number>,
  edgePriors?: Map<string, number>,
): FlowSignature {
  const entryNode = symbolGraph.symbols.get(entryId);
  if (!entryNode) return emptySignature(entryId);

  const entryCommunity = fileGraph.nodes.get(entryNode.filePath)?.communityId ?? null;

  // 1. Classify absorbing states
  const absorbing = classifyAbsorbing(symbolGraph);

  // 2. Forward propagation (lazy matrix evaluation)
  const result = propagateAbsorbing(
    entryId,
    symbolGraph,
    fileGraph,
    changeCouplingIndex,
    entryCommunity,
    absorbing,
    MARKOV_MAX_STEPS,
    MARKOV_CONVERGENCE_EPSILON,
    symbolBlame,
    edgePriors,
  );

  // 3. Build subgraph from visited nodes (context selection is caller's responsibility)
  const subgraph = buildVisitedSubgraph(result.visits, symbolGraph, MARKOV_VISIT_THRESHOLD);

  // 4. Build flow states sorted by visit probability
  const states: FlowState[] = [];
  for (const [symbolId, prob] of result.visits) {
    if (prob < MARKOV_VISIT_THRESHOLD) continue;
    const node = symbolGraph.symbols.get(symbolId);
    if (!node) continue;
    states.push({
      symbolId,
      file: node.filePath,
      name: node.name,
      visitProbability: prob,
      authority: node.authority ?? 0,
    });
  }
  states.sort((a, b) => b.visitProbability - a.visitProbability);
  const trimmedStates = states.slice(0, MARKOV_MAX_FLOW_STATES);

  // 5. Greedy path reconstruction for summary (concrete call sequence, not probability-sorted list)
  const greedyPath = reconstructGreedyPath(
    entryId,
    symbolGraph,
    fileGraph,
    changeCouplingIndex,
    entryCommunity,
    absorbing,
    MARKOV_MAX_FLOW_STATES,
    symbolBlame,
    edgePriors,
  );

  const fileBetweenness = new Map<string, number>();
  for (const [path, fnode] of fileGraph.nodes) {
    fileBetweenness.set(path, fnode.betweenness);
  }

  // Detect community boundaries along the greedy path
  let prevCommunityId: number | null = null;
  const flowNodes: FlowNode[] = [];
  for (const symId of greedyPath) {
    const node = symbolGraph.symbols.get(symId);
    if (!node) continue;
    const communityId = fileGraph.nodes.get(node.filePath)?.communityId ?? null;
    const isBoundary = prevCommunityId !== null && communityId !== prevCommunityId;
    prevCommunityId = communityId;
    flowNodes.push({
      symbolId: symId,
      file: node.filePath,
      name: node.name,
      line: node.startLine,
      communityId,
      communityLabel: null,
      isDominator: false,
      isBoundary,
    });
  }

  const summary = compressFlowPath(flowNodes, fileBetweenness);

  return {
    entrySymbolId: entryId,
    states: trimmedStates,
    absorptionProbabilities: result.absorbed,
    convergenceSteps: result.steps,
    residualMass: result.residualMass,
    visitedSubgraph: subgraph,
    summary,
  };
}

function emptySignature(entryId: number): FlowSignature {
  return {
    entrySymbolId: entryId,
    states: [],
    absorptionProbabilities: new Map(),
    convergenceSteps: 0,
    residualMass: 0,
    visitedSubgraph: {
      nodes: new Map(),
      forward: new Map(),
      reverse: new Map(),
      fileSet: new Set(),
      seedIds: new Set(),
    },
    summary: "",
  };
}
