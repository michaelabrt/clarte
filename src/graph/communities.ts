import type { Community, ImportGraph } from "../types.js";

/** Community detection parameters */
const COMMUNITY = {
  /** Minimum community size; smaller groups get merged into neighbors */
  MIN_SIZE: 3,
  /** Maximum merge rounds to attempt */
  MAX_MERGE_ROUNDS: 3,
  /** ARI threshold above which communities just mirror directory structure (no novel insight) */
  ARI_NOVELTY_THRESHOLD: 0.85,
} as const;

/**
 * Detect communities of tightly-connected files using directory-seeded
 * modularity optimization. Deterministic (no random shuffling).
 *
 * Phase 1: Seed communities from directory structure.
 * Phase 2: Merge tiny communities (< 3 files) into their best neighbor.
 * Phase 3: Reassign files with majority cross-community imports.
 * Phase 4: Validate novelty (skip if communities just mirror directories).
 */
export function detectCommunities(graph: ImportGraph): Community[] {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const files = [...allFiles];
  if (files.length === 0) return [];

  // Phase 1: Seed from directory structure (deepest meaningful directory)
  const dirLabels = new Map<string, number>();
  const fileToCommunity = new Map<string, number>();
  let nextLabel = 0;

  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirLabels.has(dir)) {
      dirLabels.set(dir, nextLabel++);
    }
    fileToCommunity.set(file, dirLabels.get(dir)!);
  }

  // Phase 2: Merge tiny communities (< 3 files) into best neighbor
  for (let round = 0; round < COMMUNITY.MAX_MERGE_ROUNDS; round++) {
    const groups = groupByCommunity(fileToCommunity);
    let merged = false;

    for (const [label, members] of groups) {
      if (members.length >= COMMUNITY.MIN_SIZE) continue;

      // Find neighboring community with most edges
      const neighborCounts = new Map<number, number>();
      for (const file of members) {
        for (const neighbor of adj.get(file) ?? []) {
          const nLabel = fileToCommunity.get(neighbor);
          if (nLabel != null && nLabel !== label) {
            neighborCounts.set(nLabel, (neighborCounts.get(nLabel) ?? 0) + 1);
          }
        }
      }

      if (neighborCounts.size === 0) continue;

      // Merge into most-connected neighbor
      let bestNeighbor = label;
      let bestCount = 0;
      for (const [nLabel, count] of neighborCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestNeighbor = nLabel;
        }
      }

      if (bestNeighbor !== label) {
        for (const file of members) {
          fileToCommunity.set(file, bestNeighbor);
        }
        merged = true;
      }
    }

    if (!merged) break;
  }

  // Phase 3: Reassign files with >50% cross-community imports
  for (let round = 0; round < COMMUNITY.MAX_MERGE_ROUNDS; round++) {
    let changed = false;
    // Process in deterministic sorted order
    for (const file of files.sort()) {
      const currentLabel = fileToCommunity.get(file)!;
      const neighbors = adj.get(file);
      if (!neighbors || neighbors.size === 0) continue;

      // Count which communities neighbors belong to
      const communityEdges = new Map<number, number>();
      for (const neighbor of neighbors) {
        const nLabel = fileToCommunity.get(neighbor);
        if (nLabel != null) {
          communityEdges.set(nLabel, (communityEdges.get(nLabel) ?? 0) + 1);
        }
      }

      // If majority of edges go to a different community, reassign
      let bestCommunity = currentLabel;
      let bestEdges = communityEdges.get(currentLabel) ?? 0;
      for (const [cLabel, count] of communityEdges) {
        if (count > bestEdges) {
          bestEdges = count;
          bestCommunity = cLabel;
        }
      }

      if (bestCommunity !== currentLabel && bestEdges > neighbors.size / 2) {
        fileToCommunity.set(file, bestCommunity);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Build final communities
  const finalGroups = groupByCommunity(fileToCommunity);
  const communities: Community[] = [];
  let id = 0;

  for (const memberFiles of finalGroups.values()) {
    if (memberFiles.length < COMMUNITY.MIN_SIZE) continue;
    const label = deriveLabel(memberFiles);
    communities.push({ id: id++, files: memberFiles.sort(), label });
  }

  // Phase 4: Validate novelty using Adjusted Rand Index
  // If communities closely mirror directory structure, return empty
  const dirOnlyCommunities = new Map<string, number>();
  let dirNextLabel = 0;
  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirOnlyCommunities.has(dir)) dirOnlyCommunities.set(dir, dirNextLabel++);
  }
  const ari = computeARI(files, fileToCommunity, file => dirOnlyCommunities.get(getDeepestDir(file))!);
  if (ari > COMMUNITY.ARI_NOVELTY_THRESHOLD) {
    // Communities just restate directory tree; no novel insight
    return [];
  }

  // Sort by size descending, alphabetical tiebreaker on first file
  communities.sort((a, b) => b.files.length - a.files.length || (a.files[0] ?? "").localeCompare(b.files[0] ?? ""));
  return communities;
}

/**
 * Get the deepest meaningful directory for a file path.
 * e.g. "src/components/Button.tsx" -> "src/components"
 */
function getDeepestDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/**
 * Group files by their community label.
 */
function groupByCommunity(fileToCommunity: Map<string, number>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const [file, label] of fileToCommunity) {
    const group = groups.get(label) ?? [];
    group.push(file);
    groups.set(label, group);
  }
  return groups;
}

/**
 * Compute Adjusted Rand Index between two clusterings of the same files.
 * Returns a value between -1 and 1, where 1 means identical clusterings.
 */
function computeARI(
  files: string[],
  labelingA: Map<string, number>,
  getLabelB: (file: string) => number,
): number {
  const n = files.length;
  if (n < 2) return 1;

  // Build contingency table
  const contingency = new Map<string, number>();
  const aCounts = new Map<number, number>();
  const bCounts = new Map<number, number>();

  for (const file of files) {
    const a = labelingA.get(file)!;
    const b = getLabelB(file);
    const key = `${a}|${b}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }

  // Choose-2 helper
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

  // Find common prefix
  const first = dirs[0];
  let prefixLen = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < prefixLen && i < dir.length && first[i] === dir[i]) i++;
    prefixLen = i;
  }

  let common = first.slice(0, prefixLen);
  // Trim to last full directory segment
  if (common.includes("/")) {
    common = common.slice(0, common.lastIndexOf("/") + 1);
  }
  common = common.replace(/\/$/, "");

  return common || files[0].split("/")[0] || "root";
}
