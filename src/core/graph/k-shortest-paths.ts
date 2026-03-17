/**
 * k-Diverse-Shortest-Paths (Yen's algorithm).
 *
 * Finds k shortest loopless paths from source to target in a weighted
 * directed graph, with an optional diversity filter that rejects paths
 * sharing too many nodes with already-accepted paths.
 *
 * Edge costs are in -log(weight) space: higher transmission = lower cost.
 *
 * Reference: Jin Y. Yen,
 * "Finding the K Shortest Loopless Paths in a Network" (1971).
 */

import { PATH_OVERLAP_THRESHOLD } from "../config/flow-constants";

// ── Types ────────────────────────────────────────────────────────────────────

export interface WeightedPath {
  /** Ordered node IDs from source to target */
  nodes: number[];
  /** Total path cost in -log(weight) space */
  cost: number;
  /** Edge kinds along the path (length = nodes.length - 1) */
  edgeKinds: string[];
  /** Product of edge weights along the path: exp(-cost) */
  confidence: number;
}

interface AdjEntry {
  target: number;
  kind: string;
}

// ── Min-heap for candidate paths ─────────────────────────────────────────────

class PathHeap {
  private data: WeightedPath[] = [];

  get size(): number {
    return this.data.length;
  }

  push(path: WeightedPath): void {
    this.data.push(path);
    this.bubbleUp(this.data.length - 1);
  }

  pop(): WeightedPath | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const last = this.data.pop() as WeightedPath;
    if (this.data.length > 0) {
      this.data[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.data[i].cost >= this.data[parent].cost) break;
      [this.data[i], this.data[parent]] = [this.data[parent], this.data[i]];
      i = parent;
    }
  }

  private sinkDown(i: number): void {
    const n = this.data.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      if (left < n && this.data[left].cost < this.data[smallest].cost) smallest = left;
      if (right < n && this.data[right].cost < this.data[smallest].cost) smallest = right;
      if (smallest === i) break;
      [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
      i = smallest;
    }
  }
}

// ── Dijkstra with exclusion sets ─────────────────────────────────────────────

interface DijkstraResult {
  nodes: number[];
  cost: number;
  edgeKinds: string[];
}

/**
 * Dijkstra from source to target, excluding specified nodes and edges.
 * Returns null if no path exists.
 */
function dijkstra(
  adjacency: Map<number, AdjEntry[]>,
  edgeWeightFn: (from: number, to: number, kind: string) => number,
  source: number,
  target: number,
  excludeNodes: Set<number>,
  excludeEdges: Set<string>,
): DijkstraResult | null {
  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const prevKind = new Map<number, string>();

  // Simple priority queue (array-based, sufficient for subgraphs < 2000 nodes)
  const queue: Array<[number, number]> = []; // [node, dist]
  const visited = new Set<number>();

  dist.set(source, 0);
  queue.push([source, 0]);

  while (queue.length > 0) {
    // Find min-distance node (linear scan is fine for small graphs)
    let minIdx = 0;
    for (let i = 1; i < queue.length; i++) {
      if (queue[i][1] < queue[minIdx][1]) minIdx = i;
    }
    const [u, uDist] = queue[minIdx];
    queue.splice(minIdx, 1);

    if (visited.has(u)) continue;
    visited.add(u);

    if (u === target) break;

    const neighbors = adjacency.get(u) ?? [];
    for (const { target: v, kind } of neighbors) {
      if (excludeNodes.has(v)) continue;
      if (excludeEdges.has(edgeKey(u, v))) continue;

      const w = edgeWeightFn(u, v, kind);
      const newDist = uDist + w;
      const currentDist = dist.get(v);

      if (currentDist === undefined || newDist < currentDist) {
        dist.set(v, newDist);
        prev.set(v, u);
        prevKind.set(v, kind);
        queue.push([v, newDist]);
      }
    }
  }

  // Reconstruct path
  if (!prev.has(target) && source !== target) return null;
  if (source === target) return { nodes: [source], cost: 0, edgeKinds: [] };

  const nodes: number[] = [];
  const edgeKinds: string[] = [];
  let current = target;
  while (current !== source) {
    nodes.push(current);
    edgeKinds.push(prevKind.get(current) ?? "calls");
    current = prev.get(current) ?? source;
  }
  nodes.push(source);
  nodes.reverse();
  edgeKinds.reverse();

  return { nodes, cost: dist.get(target) ?? 0, edgeKinds };
}

function edgeKey(from: number, to: number): string {
  return `${from}\0${to}`;
}

// ── Diversity filter ─────────────────────────────────────────────────────────

function nodeOverlap(a: number[], b: number[]): number {
  const setA = new Set(a);
  let shared = 0;
  for (const n of b) {
    if (setA.has(n)) shared++;
  }
  return shared / Math.max(a.length, b.length);
}

// ── Main algorithm ───────────────────────────────────────────────────────────

/**
 * Find k shortest loopless paths from source to target.
 *
 * @param adjacency - forward adjacency: node -> [{target, kind}]
 * @param edgeWeightFn - cost for an edge (in -log(weight) space)
 * @param source - start node
 * @param target - end node
 * @param k - maximum paths to return
 * @param overlapThreshold - max node overlap fraction (default: PATH_OVERLAP_THRESHOLD)
 */
export function kShortestPaths(
  adjacency: Map<number, Array<{ target: number; kind: string }>>,
  edgeWeightFn: (from: number, to: number, kind: string) => number,
  source: number,
  target: number,
  k: number,
  overlapThreshold = PATH_OVERLAP_THRESHOLD,
): WeightedPath[] {
  if (k <= 0) return [];

  // Step 1: Find shortest path
  const first = dijkstra(adjacency, edgeWeightFn, source, target, new Set(), new Set());
  if (!first) return [];

  const accepted: WeightedPath[] = [
    {
      nodes: first.nodes,
      cost: first.cost,
      edgeKinds: first.edgeKinds,
      confidence: Math.exp(-first.cost),
    },
  ];

  if (k === 1) return accepted;

  const candidates = new PathHeap();
  const seen = new Set<string>(); // Deduplicate identical paths

  for (let i = 0; i < k - 1 && accepted.length < k; i++) {
    const prevPath = accepted[accepted.length - 1];

    for (let j = 0; j < prevPath.nodes.length - 1; j++) {
      const spurNode = prevPath.nodes[j];
      const rootPath = prevPath.nodes.slice(0, j + 1);
      const rootKinds = prevPath.edgeKinds.slice(0, j);
      const rootCost =
        j === 0
          ? 0
          : accepted
              .filter((a) => {
                for (let x = 0; x <= j; x++) {
                  if (a.nodes[x] !== rootPath[x]) return false;
                }
                return true;
              })
              .reduce((_, a) => {
                // Compute root cost from first accepted path that matches
                let c = 0;
                for (let x = 0; x < j; x++) {
                  c += edgeWeightFn(a.nodes[x], a.nodes[x + 1], a.edgeKinds[x]);
                }
                return c;
              }, 0);

      // Exclude edges from spur node that overlap with previous paths' root
      const excludeEdges = new Set<string>();
      for (const a of accepted) {
        if (a.nodes.length > j + 1) {
          let matchesRoot = true;
          for (let x = 0; x <= j; x++) {
            if (a.nodes[x] !== rootPath[x]) {
              matchesRoot = false;
              break;
            }
          }
          if (matchesRoot) {
            excludeEdges.add(edgeKey(a.nodes[j], a.nodes[j + 1]));
          }
        }
      }

      // Exclude root path nodes (except spur node) to enforce loopless
      const excludeNodes = new Set<number>();
      for (let x = 0; x < j; x++) {
        excludeNodes.add(rootPath[x]);
      }

      const spurResult = dijkstra(adjacency, edgeWeightFn, spurNode, target, excludeNodes, excludeEdges);
      if (!spurResult) continue;

      const totalNodes = [...rootPath.slice(0, -1), ...spurResult.nodes];
      const totalKinds = [...rootKinds, ...spurResult.edgeKinds];
      const totalCost = rootCost + spurResult.cost;

      const pathKey = totalNodes.join(",");
      if (seen.has(pathKey)) continue;
      seen.add(pathKey);

      candidates.push({
        nodes: totalNodes,
        cost: totalCost,
        edgeKinds: totalKinds,
        confidence: Math.exp(-totalCost),
      });
    }

    // Pop best candidate that passes diversity filter
    while (candidates.size > 0) {
      const candidate = candidates.pop() as WeightedPath;
      const tooSimilar = accepted.some((a) => nodeOverlap(a.nodes, candidate.nodes) > overlapThreshold);
      if (!tooSimilar) {
        accepted.push(candidate);
        break;
      }
    }

    if (candidates.size === 0 && accepted.length <= i + 1) break;
  }

  return accepted;
}
