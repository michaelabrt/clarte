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
 *   Incremental drift detection (§5.10)
 */

import type { ImportGraph } from "../types.js";
import { BETWEENNESS_K } from "../config/thresholds.js";

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

// ── Drift detection (§5.10) ──────────────────────────────────────────────────

/** Score field names that are compared during drift detection */
type ScoreField = "authority" | "hub" | "betweenness" | "instability";

/**
 * Compare incremental scores against full rebuild scores (§5.10).
 * Returns files with drift > threshold on any score field.
 *
 * Drift threshold: 0.01 per file per score field.
 */
export function detectDrift(
  incrementalGraph: ImportGraph,
  fullGraph: ImportGraph,
  threshold = 0.01,
): { drifted: boolean; files: string[]; maxDelta: number } {
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

  return { drifted: driftFiles.length > 0, files: driftFiles, maxDelta };
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
