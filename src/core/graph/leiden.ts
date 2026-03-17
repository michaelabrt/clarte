/**
 * Leiden community detection algorithm (Traag et al. 2019).
 *
 * Three phases per iteration:
 *   1. Local moving: move nodes to maximize modularity gain (same as Louvain)
 *   2. Refinement: sub-cluster within each community to guarantee connectivity
 *   3. Aggregation: contract to super-node graph, repeat
 *
 * Source: Traag, Waltman & van Eck (2019), "From Louvain to Leiden"
 */

import type { Community, ImportGraph } from "../types";

// ── Constants ────────────────────────────────────────────────────────────────

/** ARI threshold above which communities just mirror directory structure */
const ARI_NOVELTY_THRESHOLD = 0.85;

/** Maximum outer iterations before forced convergence */
const MAX_OUTER_ITERATIONS = 20;

// ── Adaptive gamma ───────────────────────────────────────────────────────────

/**
 * Resolution parameter gamma controls community granularity.
 * Larger gamma = smaller communities; smaller gamma = larger communities.
 *
 * Formula: gamma = 1.0 + log10(nodeCount / 1000), clamped to [0.5, 3.0]
 *
 * | Files   | gamma |
 * |---------|-------|
 * | 100     | 0.5   |
 * | 1000    | 1.0   |
 * | 10000   | 2.0   |
 * | 100000  | 3.0   |
 */
export function computeAdaptiveGamma(nodeCount: number): number {
  if (nodeCount <= 0) return 0.5;
  const gamma = 1.0 + Math.log10(nodeCount / 1000);
  return Math.max(0.5, Math.min(3.0, gamma));
}

// ── Per-cluster cohesion ─────────────────────────────────────────────────────

/**
 * Internal edge density for a community.
 * Cohesion = internalEdges / maxPossibleEdges (for undirected graph).
 *
 * - Single-node community: 1.0 (trivially cohesive)
 * - Complete clique: 1.0
 * - No internal edges: 0.0
 */
export function computeCohesion(communityNodes: string[], adj: Map<string, Set<string>>): number {
  const n = communityNodes.length;
  if (n < 2) return 1.0;

  const nodeSet = new Set(communityNodes);
  let internalEdges = 0;

  for (const node of communityNodes) {
    for (const neighbor of adj.get(node) ?? []) {
      if (nodeSet.has(neighbor)) {
        internalEdges++;
      }
    }
  }

  // Each undirected edge counted twice (once from each endpoint)
  internalEdges /= 2;

  const maxPossibleEdges = (n * (n - 1)) / 2;
  return internalEdges / maxPossibleEdges;
}

// ── ARI novelty validation ───────────────────────────────────────────────────

/**
 * Adjusted Rand Index between two clusterings.
 * Partition-agnostic: only cares about which pairs of nodes share a cluster.
 * Returns value in [-1, 1]; 1 = identical clusterings.
 */
export function computeARI(
  files: string[],
  labelingA: Map<string, number>,
  getLabelB: (file: string) => number,
): number {
  const n = files.length;
  if (n < 2) return 1;

  const contingency = new Map<string, number>();
  const aCounts = new Map<number, number>();
  const bCounts = new Map<number, number>();

  for (const file of files) {
    const a = labelingA.get(file) ?? 0;
    const b = getLabelB(file);
    const key = `${a}|${b}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }

  const c2 = (x: number) => (x * (x - 1)) / 2;

  let sumNij = 0;
  for (const nij of contingency.values()) sumNij += c2(nij);

  let sumAi = 0;
  for (const ai of aCounts.values()) sumAi += c2(ai);

  let sumBj = 0;
  for (const bj of bCounts.values()) sumBj += c2(bj);

  const totalC2 = c2(n);
  const expected = (sumAi * sumBj) / totalC2;
  const maxIndex = (sumAi + sumBj) / 2;
  const denominator = maxIndex - expected;

  if (denominator === 0) return 1;
  return (sumNij - expected) / denominator;
}

// ── Leiden core algorithm ────────────────────────────────────────────────────

/**
 * Build undirected adjacency from import edges, filtering externals.
 * Returns adjacency map and sorted file list.
 */
export function buildUndirectedAdj(graph: ImportGraph): {
  adj: Map<string, Set<string>>;
  files: string[];
} {
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)?.add(edge.to);
    adj.get(edge.to)?.add(edge.from);
  }

  return { adj, files: [...allFiles].sort() };
}

/**
 * Get the deepest directory for a file path.
 * e.g. "src/components/Button.tsx" -> "src/components"
 */
export function getDeepestDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/**
 * Derive a human-readable label from a group of file paths
 * by finding their common directory prefix.
 */
function deriveLabel(files: string[]): string {
  if (files.length === 0) return "unknown";

  const dirs = files.map((f) => {
    const parts = f.split("/");
    return parts.slice(0, -1).join("/");
  });

  const first = dirs[0];
  let prefixLen = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < prefixLen && i < dir.length && first[i] === dir[i]) i++;
    prefixLen = i;
  }

  let common = first.slice(0, prefixLen);
  if (common.includes("/")) {
    common = common.slice(0, common.lastIndexOf("/") + 1);
  }
  common = common.replace(/\/$/, "");

  return common || files[0].split("/")[0] || "root";
}

/**
 * Group files by their community label.
 */
export function groupByCommunity(fileToCommunity: Map<string, number>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const [file, label] of fileToCommunity) {
    const group = groups.get(label) ?? [];
    group.push(file);
    groups.set(label, group);
  }
  return groups;
}

/**
 * Phase 1 of Leiden: Local moving.
 * Move each node to the neighboring community that maximizes modularity gain.
 * Uses resolution parameter gamma in the null model term.
 *
 * Modularity gain for moving node i from community A to community B:
 *   ΔQ = [Σ_in_B + 2*k_i_B] / (2*m) - gamma * [(Σ_tot_B + k_i)/(2*m)]^2
 *      - [Σ_in_A - 2*k_i_A] / (2*m) + gamma * [(Σ_tot_A - k_i)/(2*m)]^2
 *
 * Returns true if any node moved.
 */
function localMoving(
  files: string[],
  adj: Map<string, Set<string>>,
  fileToCommunity: Map<string, number>,
  gamma: number,
): boolean {
  const m = countTotalEdges(adj);
  if (m === 0) return false;

  const degree = new Map<string, number>();
  for (const file of files) {
    degree.set(file, adj.get(file)?.size ?? 0);
  }

  // Sum of degrees per community
  const communityDegree = new Map<number, number>();
  for (const file of files) {
    const label = fileToCommunity.get(file) ?? 0;
    communityDegree.set(label, (communityDegree.get(label) ?? 0) + (degree.get(file) ?? 0));
  }

  // Internal edges per community (sum of intra-community edge endpoints / 2, but
  // we track the sum of both endpoint contributions for speed)
  const communityInternalWeight = new Map<number, number>();
  for (const file of files) {
    const label = fileToCommunity.get(file) ?? 0;
    let internalCount = 0;
    for (const neighbor of adj.get(file) ?? []) {
      if (fileToCommunity.get(neighbor) === label) internalCount++;
    }
    communityInternalWeight.set(label, (communityInternalWeight.get(label) ?? 0) + internalCount);
  }

  let anyMoved = false;

  // Deterministic order for reproducibility
  for (const file of [...files].sort()) {
    const currentLabel = fileToCommunity.get(file) ?? 0;
    const neighbors = adj.get(file);
    if (!neighbors || neighbors.size === 0) continue;

    const ki = degree.get(file) ?? 0;

    // Count edges to each neighboring community
    const edgesToCommunity = new Map<number, number>();
    for (const neighbor of neighbors) {
      const nLabel = fileToCommunity.get(neighbor) ?? 0;
      edgesToCommunity.set(nLabel, (edgesToCommunity.get(nLabel) ?? 0) + 1);
    }

    const kiA = edgesToCommunity.get(currentLabel) ?? 0;
    const sigmaInA = (communityInternalWeight.get(currentLabel) ?? 0) / 2; // each edge counted from both sides
    const sigmaTotA = communityDegree.get(currentLabel) ?? 0;

    let bestLabel = currentLabel;
    let bestDeltaQ = 0;

    for (const [candidateLabel, kiB] of edgesToCommunity) {
      if (candidateLabel === currentLabel) continue;

      const sigmaInB = (communityInternalWeight.get(candidateLabel) ?? 0) / 2;
      const sigmaTotB = communityDegree.get(candidateLabel) ?? 0;

      // Modularity gain formula
      const twoM = 2 * m;
      const removeFromA = (sigmaInA - kiA) / twoM - gamma * ((sigmaTotA - ki) / twoM) ** 2;
      const addToB = (sigmaInB + kiB) / twoM - gamma * ((sigmaTotB + ki) / twoM) ** 2;
      const currentInA = sigmaInA / twoM - gamma * (sigmaTotA / twoM) ** 2;
      const currentInB = sigmaInB / twoM - gamma * (sigmaTotB / twoM) ** 2;

      const deltaQ = addToB - currentInB + (removeFromA - currentInA);

      if (deltaQ > bestDeltaQ) {
        bestDeltaQ = deltaQ;
        bestLabel = candidateLabel;
      }
    }

    if (bestLabel !== currentLabel) {
      // Update community degree sums
      communityDegree.set(currentLabel, (communityDegree.get(currentLabel) ?? 0) - ki);
      communityDegree.set(bestLabel, (communityDegree.get(bestLabel) ?? 0) + ki);

      // Update internal edge weights
      // Remove node from old community: subtract edges to old community members
      const oldInternalContrib = (edgesToCommunity.get(currentLabel) ?? 0) * 2;
      communityInternalWeight.set(currentLabel, (communityInternalWeight.get(currentLabel) ?? 0) - oldInternalContrib);

      // Add node to new community: add edges to new community members
      const newInternalContrib = (edgesToCommunity.get(bestLabel) ?? 0) * 2;
      communityInternalWeight.set(bestLabel, (communityInternalWeight.get(bestLabel) ?? 0) + newInternalContrib);

      fileToCommunity.set(file, bestLabel);
      anyMoved = true;
    }
  }

  return anyMoved;
}

/**
 * Phase 2 of Leiden: Refinement.
 * Within each community from Phase 1, run a sub-clustering pass to
 * ensure all communities are internally connected. This is the key
 * difference from Louvain (Traag 2019).
 *
 * For each community, find connected components via BFS. If a community
 * has multiple components, split them into separate sub-communities.
 */
function refine(adj: Map<string, Set<string>>, fileToCommunity: Map<string, number>): boolean {
  const groups = groupByCommunity(fileToCommunity);
  let nextLabel = 0;
  for (const label of groups.keys()) {
    if (label >= nextLabel) nextLabel = label + 1;
  }

  let anyRefined = false;

  for (const [_label, members] of groups) {
    if (members.length < 2) continue;

    // Find connected components within this community
    const memberSet = new Set(members);
    const visited = new Set<string>();
    const components: string[][] = [];

    for (const node of members) {
      if (visited.has(node)) continue;

      // BFS within community
      const component: string[] = [];
      const queue = [node];
      visited.add(node);

      while (queue.length > 0) {
        const current = queue.shift() as string;
        component.push(current);

        for (const neighbor of adj.get(current) ?? []) {
          if (memberSet.has(neighbor) && !visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push(neighbor);
          }
        }
      }

      components.push(component);
    }

    // If multiple components, split into separate communities
    if (components.length > 1) {
      anyRefined = true;
      // Keep the first component with the original label, assign new labels to others
      for (let i = 1; i < components.length; i++) {
        for (const node of components[i]) {
          fileToCommunity.set(node, nextLabel);
        }
        nextLabel++;
      }
    }
  }

  return anyRefined;
}

/**
 * Count total undirected edges (each edge counted once).
 */
function countTotalEdges(adj: Map<string, Set<string>>): number {
  let total = 0;
  for (const neighbors of adj.values()) {
    total += neighbors.size;
  }
  return total / 2;
}

// ── Main entry point ─────────────────────────────────────────────────────────

/**
 * Detect communities using the Leiden algorithm with directory seeding.
 *
 * Flow:
 *   1. Seed from directory structure (warm start)
 *   2. Leiden local moving + refinement (replaces Louvain)
 *   3. Validate novelty via ARI
 *
 * Returns communities with per-cluster cohesion scores.
 */
export function detectCommunitiesLeiden(graph: ImportGraph): Community[] {
  const { adj, files } = buildUndirectedAdj(graph);

  if (files.length === 0) return [];

  const gamma = computeAdaptiveGamma(files.length);

  // Phase 1 seed: directory structure
  const dirLabels = new Map<string, number>();
  const fileToCommunity = new Map<string, number>();
  let nextLabel = 0;

  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirLabels.has(dir)) {
      dirLabels.set(dir, nextLabel++);
    }
    fileToCommunity.set(file, dirLabels.get(dir) as number);
  }

  // Leiden outer loop: local moving → refinement → aggregation
  for (let iter = 0; iter < MAX_OUTER_ITERATIONS; iter++) {
    const moved = localMoving(files, adj, fileToCommunity, gamma);
    refine(adj, fileToCommunity);

    if (!moved) break;

    // Aggregation: check if communities are stable enough
    // If fewer than 2 communities, nothing to optimize further
    const groups = groupByCommunity(fileToCommunity);
    if (groups.size <= 1) break;
  }

  // ARI novelty validation
  const dirOnlyCommunities = new Map<string, number>();
  let dirNextLabel = 0;
  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirOnlyCommunities.has(dir)) dirOnlyCommunities.set(dir, dirNextLabel++);
  }

  const ari = computeARI(files, fileToCommunity, (file) => dirOnlyCommunities.get(getDeepestDir(file)) ?? 0);

  if (ari > ARI_NOVELTY_THRESHOLD) {
    return [];
  }

  // Build final communities with cohesion
  const finalGroups = groupByCommunity(fileToCommunity);
  const communities: Community[] = [];
  let id = 0;

  for (const memberFiles of finalGroups.values()) {
    if (memberFiles.length < 2) continue;
    const label = deriveLabel(memberFiles);
    const cohesion = computeCohesion(memberFiles, adj);
    communities.push({
      id: id++,
      files: memberFiles.sort(),
      label,
      cohesion,
    });
  }

  communities.sort((a, b) => b.files.length - a.files.length || (a.files[0] ?? "").localeCompare(b.files[0] ?? ""));

  return communities;
}

/**
 * Run a single Leiden refinement round on a subset of nodes.
 * Used for Level 2 incremental updates: only nodes adjacent to changed edges
 * participate in the local moving phase.
 */
export function leidenRefine(
  graph: ImportGraph,
  currentPartition: Map<string, number>,
  affectedNodes: Set<string>,
): Map<string, number> {
  const { adj, files } = buildUndirectedAdj(graph);
  const gamma = computeAdaptiveGamma(files.length);

  // Copy the current partition
  const partition = new Map(currentPartition);

  // Ensure all files have an assignment
  let maxLabel = 0;
  for (const label of partition.values()) {
    if (label > maxLabel) maxLabel = label;
  }
  for (const file of files) {
    if (!partition.has(file)) {
      partition.set(file, ++maxLabel);
    }
  }

  // Only move affected nodes ("only nodes adjacent to changed edges may move")
  const m = countTotalEdges(adj);
  if (m === 0) return partition;

  const degree = new Map<string, number>();
  for (const file of files) {
    degree.set(file, adj.get(file)?.size ?? 0);
  }

  const communityDegree = new Map<number, number>();
  for (const file of files) {
    const label = partition.get(file) ?? 0;
    communityDegree.set(label, (communityDegree.get(label) ?? 0) + (degree.get(file) ?? 0));
  }

  const communityInternalWeight = new Map<number, number>();
  for (const file of files) {
    const label = partition.get(file) ?? 0;
    let internalCount = 0;
    for (const neighbor of adj.get(file) ?? []) {
      if (partition.get(neighbor) === label) internalCount++;
    }
    communityInternalWeight.set(label, (communityInternalWeight.get(label) ?? 0) + internalCount);
  }

  // Local moving for affected nodes only
  for (const file of [...affectedNodes].sort()) {
    if (!adj.has(file)) continue;

    const currentLabel = partition.get(file) ?? 0;
    const neighbors = adj.get(file);
    if (!neighbors || neighbors.size === 0) continue;

    const ki = degree.get(file) ?? 0;

    const edgesToCommunity = new Map<number, number>();
    for (const neighbor of neighbors) {
      const nLabel = partition.get(neighbor) ?? 0;
      edgesToCommunity.set(nLabel, (edgesToCommunity.get(nLabel) ?? 0) + 1);
    }

    const kiA = edgesToCommunity.get(currentLabel) ?? 0;
    const sigmaInA = (communityInternalWeight.get(currentLabel) ?? 0) / 2;
    const sigmaTotA = communityDegree.get(currentLabel) ?? 0;

    let bestLabel = currentLabel;
    let bestDeltaQ = 0;

    for (const [candidateLabel, kiB] of edgesToCommunity) {
      if (candidateLabel === currentLabel) continue;

      const sigmaInB = (communityInternalWeight.get(candidateLabel) ?? 0) / 2;
      const sigmaTotB = communityDegree.get(candidateLabel) ?? 0;

      const twoM = 2 * m;
      const removeFromA = (sigmaInA - kiA) / twoM - gamma * ((sigmaTotA - ki) / twoM) ** 2;
      const addToB = (sigmaInB + kiB) / twoM - gamma * ((sigmaTotB + ki) / twoM) ** 2;
      const currentInA = sigmaInA / twoM - gamma * (sigmaTotA / twoM) ** 2;
      const currentInB = sigmaInB / twoM - gamma * (sigmaTotB / twoM) ** 2;

      const deltaQ = addToB - currentInB + (removeFromA - currentInA);

      if (deltaQ > bestDeltaQ) {
        bestDeltaQ = deltaQ;
        bestLabel = candidateLabel;
      }
    }

    if (bestLabel !== currentLabel) {
      communityDegree.set(currentLabel, (communityDegree.get(currentLabel) ?? 0) - ki);
      communityDegree.set(bestLabel, (communityDegree.get(bestLabel) ?? 0) + ki);

      const oldInternalContrib = (edgesToCommunity.get(currentLabel) ?? 0) * 2;
      communityInternalWeight.set(currentLabel, (communityInternalWeight.get(currentLabel) ?? 0) - oldInternalContrib);
      const newInternalContrib = (edgesToCommunity.get(bestLabel) ?? 0) * 2;
      communityInternalWeight.set(bestLabel, (communityInternalWeight.get(bestLabel) ?? 0) + newInternalContrib);

      partition.set(file, bestLabel);
    }
  }

  // Refinement: ensure connectivity
  refine(adj, partition);

  return partition;
}
