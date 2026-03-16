/**
 * Incremental graph update pipeline (§5.6-5.8, §5.10).
 *
 * Three levels:
 *   Level 1: Per-file delta updates (§5.6) - update only changed files
 *   Level 2: Warm-start score propagation (§5.7) - partial recomputation
 *   Level 3: Full rebuild triggers (§5.8) - conditions that force a complete rebuild
 *
 * Also includes:
 *   BETWEENNESS_K quantization (§5.9)
 *   Incremental drift detection (§5.10) with community ARI/cohesion (audit F1)
 *   Lightweight edge-only update path (audit Shift 2)
 */

import type { Community, ImportGraph } from "../types";
import { BETWEENNESS_K } from "../config/thresholds";
import { computeARI, computeCohesion, buildUndirectedAdj, getDeepestDir, groupByCommunity } from "./leiden";

// ── BETWEENNESS_K quantization (§5.9) ────────────────────────────────────────

/**
 * Quantize k to the nearest multiple of 10 to prevent spurious cache
 * invalidation when file count changes by 1.
 *
 * Formula: max(50, ceil(sqrt(V) * 2)) → ceil to nearest 10
 *
 * | V       | rawK | effectiveK |
 * |---------|------|------------|
 * | 1-625   | 50   | 50         |
 * | 626-900 | 51-60| 60         |
 * | 901-... | 61+  | 70+        |
 * | 2500    | 100  | 100        |
 * | 10000   | 200  | 200        |
 */
export function quantizeBetweennessK(nodeCount: number): number {
  const rawK = Math.max(BETWEENNESS_K, Math.ceil(Math.sqrt(nodeCount) * 2));
  return Math.ceil(rawK / 10) * 10;
}

// ── Level 3: Full rebuild triggers (§5.8) ────────────────────────────────────

/** Conditions that trigger a full rebuild instead of incremental updates */
export interface RebuildTrigger {
  triggered: boolean;
  reason: string;
}

/**
 * Check if a full rebuild should be triggered (§5.8).
 *
 * Triggers:
 *   1. Schema version change
 *   2. >50% of files changed
 *   3. Explicit user request (--force)
 *   4. Barrel file change
 */
export function checkRebuildTriggers(opts: {
  staleFiles: string[];
  totalFiles: number;
  force?: boolean;
  schemaVersionMismatch?: boolean;
  barrelFileChanged?: boolean;
}): RebuildTrigger {
  if (opts.force) {
    return { triggered: true, reason: "explicit --force flag" };
  }

  if (opts.schemaVersionMismatch) {
    return { triggered: true, reason: "schema version mismatch" };
  }

  if (opts.barrelFileChanged) {
    return { triggered: true, reason: "barrel file changed" };
  }

  const staleRatio = opts.totalFiles > 0 ? opts.staleFiles.length / opts.totalFiles : 0;
  if (staleRatio > 0.5) {
    return {
      triggered: true,
      reason: `${(staleRatio * 100).toFixed(0)}% of files changed (>${50}% threshold)`,
    };
  }

  return { triggered: false, reason: "" };
}

// ── Level 2: Warm-start score propagation helpers (§5.7) ─────────────────────

/**
 * Collect nodes within N hops of a set of changed files (§5.7).
 * Used for betweenness local re-sampling.
 */
export function collectNHopNeighborhood(
  changedFiles: Set<string>,
  adj: Map<string, Set<string>>,
  maxHops: number,
): Set<string> {
  const neighborhood = new Set<string>(changedFiles);
  let frontier = new Set<string>(changedFiles);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const node of frontier) {
      for (const neighbor of adj.get(node) ?? []) {
        if (!neighborhood.has(neighbor)) {
          neighborhood.add(neighbor);
          nextFrontier.add(neighbor);
        }
      }
    }
    frontier = nextFrontier;
    if (frontier.size === 0) break;
  }

  return neighborhood;
}

/**
 * Determine which files need role re-derivation after score changes (§5.7).
 * Only files with score deltas > 0.05 warrant re-derivation.
 */
export function filesNeedingRoleUpdate(
  oldAuthority: Map<string, number>,
  newAuthority: Map<string, number>,
  oldHub: Map<string, number>,
  newHub: Map<string, number>,
  threshold = 0.05,
): Set<string> {
  const needsUpdate = new Set<string>();

  for (const [file, newAuth] of newAuthority) {
    const oldAuth = oldAuthority.get(file) ?? 0;
    const newH = newHub.get(file) ?? 0;
    const oldH = oldHub.get(file) ?? 0;

    if (Math.abs(newAuth - oldAuth) > threshold || Math.abs(newH - oldH) > threshold) {
      needsUpdate.add(file);
    }
  }

  return needsUpdate;
}

// ── Drift detection (§5.10 + audit F1: community drift) ─────────────────────

/** Score field names that are compared during drift detection */
type ScoreField = "authority" | "hub" | "betweenness" | "instability";

/** Audit F1: Community drift metrics */
export interface CommunityDriftResult {
  /** ARI between incremental and full-rebuild community assignments */
  communityARI: number;
  /** Average cohesion across all communities in the incremental graph */
  avgCohesion: number;
  /** True if ARI drifted above 0.80 (communities mirroring directory structure) */
  communityDrifted: boolean;
}

/**
 * Compare incremental scores against full rebuild scores (§5.10).
 * Returns files with drift > threshold on any score field.
 *
 * Audit F1: Also computes community drift (ARI between incremental and
 * full-rebuild communities). If communityARI > 0.80 (approaching directory
 * structure), triggers a full Leiden rebuild to prevent "fragmented ghosts."
 *
 * Drift threshold: 0.01 per file per score field.
 */
export function detectDrift(
  incrementalGraph: ImportGraph,
  fullGraph: ImportGraph,
  threshold = 0.01,
  /** Audit F1: Incremental community assignments (file -> community ID) */
  incrementalCommunities?: Map<string, number>,
  /** Audit F1: Full-rebuild community assignments */
  fullCommunities?: Map<string, number>,
  /** Audit F1: Community objects with cohesion scores */
  incrementalCommunityList?: Community[],
): {
  drifted: boolean;
  files: string[];
  maxDelta: number;
  communityDrift?: CommunityDriftResult;
} {
  const driftFiles: string[] = [];
  let maxDelta = 0;

  const fields: Array<{ field: ScoreField; incr: Map<string, number>; full: Map<string, number> }> = [
    { field: "authority", incr: incrementalGraph.authority, full: fullGraph.authority },
    { field: "hub", incr: incrementalGraph.hubScores, full: fullGraph.hubScores },
  ];

  if (incrementalGraph.betweennessScores && fullGraph.betweennessScores) {
    fields.push({
      field: "betweenness",
      incr: incrementalGraph.betweennessScores,
      full: fullGraph.betweennessScores,
    });
  }

  const allFiles = new Set<string>([...incrementalGraph.authority.keys(), ...fullGraph.authority.keys()]);

  for (const file of allFiles) {
    let fileDrifted = false;

    for (const { incr, full } of fields) {
      const incrScore = incr.get(file) ?? 0;
      const fullScore = full.get(file) ?? 0;
      const delta = Math.abs(incrScore - fullScore);

      if (delta > maxDelta) maxDelta = delta;
      if (delta > threshold) fileDrifted = true;
    }

    if (fileDrifted) driftFiles.push(file);
  }

  // Audit F1: Community drift detection
  let communityDrift: CommunityDriftResult | undefined;
  if (incrementalCommunities && fullCommunities) {
    communityDrift = detectCommunityDrift(incrementalGraph, incrementalCommunities, incrementalCommunityList);

    // Community drift triggers full rebuild (treat as score drift)
    if (communityDrift.communityDrifted) {
      // Don't add individual files - this is a global rebuild trigger
    }
  }

  const scoreDrifted = driftFiles.length > 0;
  const communityDrifted = communityDrift?.communityDrifted ?? false;

  return {
    drifted: scoreDrifted || communityDrifted,
    files: driftFiles,
    maxDelta,
    communityDrift,
  };
}

/**
 * Audit F1: Detect community drift by comparing current communities
 * against directory structure. If ARI > 0.80, communities have degraded
 * toward directory structure and need a full Leiden rebuild.
 *
 * Also tracks average cohesion as a secondary quality signal.
 */
export function detectCommunityDrift(
  graph: ImportGraph,
  communityAssignments: Map<string, number>,
  communityList?: Community[],
): CommunityDriftResult {
  const files = [...communityAssignments.keys()];

  if (files.length < 2) {
    return { communityARI: 0, avgCohesion: 1.0, communityDrifted: false };
  }

  // Compute ARI between current communities and directory structure
  const dirLabels = new Map<string, number>();
  let nextLabel = 0;
  const getDirLabel = (file: string): number => {
    const dir = getDeepestDir(file);
    let label = dirLabels.get(dir);
    if (label === undefined) {
      label = nextLabel++;
      dirLabels.set(dir, label);
    }
    return label;
  };

  const communityARI = computeARI(files, communityAssignments, getDirLabel);

  // Compute average cohesion across communities
  let avgCohesion = 1.0;
  if (communityList && communityList.length > 0) {
    let totalCohesion = 0;
    let count = 0;
    for (const c of communityList) {
      if (c.cohesion !== undefined) {
        totalCohesion += c.cohesion;
        count++;
      }
    }
    avgCohesion = count > 0 ? totalCohesion / count : 1.0;
  } else if (communityAssignments.size > 0) {
    // Recompute cohesion from the graph if community objects not available
    const { adj } = buildUndirectedAdj(graph);
    const groups = groupByCommunity(communityAssignments);
    let totalCohesion = 0;
    let count = 0;
    for (const members of groups.values()) {
      if (members.length < 2) continue;
      totalCohesion += computeCohesion(members, adj);
      count++;
    }
    avgCohesion = count > 0 ? totalCohesion / count : 1.0;
  }

  // Audit F1: Trigger at 0.80 (below the 0.85 novelty gate) to catch
  // the trend before communities fully collapse to directory structure.
  const communityDrifted = communityARI > 0.8;

  return { communityARI, avgCohesion, communityDrifted };
}

/**
 * Check whether drift detection should run (§5.10).
 * Triggers: every 100 incremental updates OR weekly (whichever comes first).
 */
export function shouldRunDriftDetection(buildCount: number, lastFullRebuildTimestamp: string | undefined): boolean {
  if (buildCount >= 100) return true;

  if (lastFullRebuildTimestamp) {
    const lastRebuild = new Date(lastFullRebuildTimestamp).getTime();
    const oneWeek = 7 * 24 * 60 * 60 * 1000;
    if (Date.now() - lastRebuild > oneWeek) return true;
  }

  return false;
}

// ── Lightweight edge-only update path (audit Shift 2) ────────────────────────

/**
 * Result of a lightweight edge-only update.
 * When only imports/exports change (no algorithmic impact), we can update
 * edges and FTS5 immediately without waiting for HITS/Leiden convergence.
 */
export interface LightweightUpdateResult {
  /** Files whose edges were updated */
  updatedFiles: string[];
  /** Whether a heavy recomputation should be deferred */
  deferHeavyRecompute: boolean;
  /** Reason for deferring (or "none" if not deferred) */
  deferReason: string;
}

/**
 * Audit Shift 2: Lightweight edge path for structural-only changes.
 *
 * When a file change only affects imports/exports (not function bodies or
 * call sites), this function updates file_edges and FTS5 immediately without
 * triggering the heavy HITS/betweenness/Leiden pipeline.
 *
 * Criteria for lightweight update (all must be true):
 * - No symbol bodies changed (only import statements)
 * - No call sites changed
 * - No heritage/decorator/type-usage changes
 * - File is not a barrel (barrel changes affect authority globally)
 *
 * Returns whether heavy recomputation should be deferred.
 */
export function classifyUpdateWeight(opts: {
  changedFiles: string[];
  barrelFiles: Set<string>;
  /** True if any changed file has modified symbol bodies (not just imports) */
  hasBodyChanges: boolean;
  /** True if call sites changed in any file */
  hasCallSiteChanges: boolean;
  /** True if heritage/decorator/type-usage edges changed */
  hasStructuralChanges: boolean;
}): LightweightUpdateResult {
  // Any barrel change requires full rebuild (existing §5.8 trigger)
  const barrelChanged = opts.changedFiles.some((f) => opts.barrelFiles.has(f));
  if (barrelChanged) {
    return {
      updatedFiles: opts.changedFiles,
      deferHeavyRecompute: false,
      deferReason: "barrel file changed, full rebuild required",
    };
  }

  // If only imports changed (no body/callsite/structural changes),
  // we can do a lightweight edge-only update.
  if (!opts.hasBodyChanges && !opts.hasCallSiteChanges && !opts.hasStructuralChanges) {
    return {
      updatedFiles: opts.changedFiles,
      deferHeavyRecompute: true,
      deferReason: "import-only changes, HITS/Leiden deferred",
    };
  }

  // Body, call site, or structural changes need full score recomputation
  return {
    updatedFiles: opts.changedFiles,
    deferHeavyRecompute: false,
    deferReason: "none",
  };
}
