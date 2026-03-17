/**
 * RFC-002 Phase 5: Four-stage noise gate for ghost edge candidates.
 *
 * Prevents graph bloat by filtering ghost edges through:
 * 1. Frequency gate - kills entire kinds that appear in >10% of files
 * 2. Redundancy gate - drops duplicates of existing edges
 * 3. Community gate - halves confidence for same-community edges
 * 4. Validation gate - per-kind structural checks
 */

import type { GhostEdgeCandidate } from "./ghost-types";
import type { GhostEdgeKind } from "./symbol-types";
import { GHOST_COMMUNITY_DISCOUNT } from "./ghost-types";

/** Maximum fraction of files a ghost kind can touch before being killed */
const FREQUENCY_THRESHOLD = 0.1;

/**
 * Apply four-stage noise gate to ghost edge candidates.
 *
 * @param candidates - raw ghost edge candidates from all detectors
 * @param fileCount - total number of files in the graph
 * @param existingEdges - resolved edges already in the graph (for dedup)
 * @param fileToCommunity - file path -> community ID mapping
 */
export function applyNoiseGate(
  candidates: GhostEdgeCandidate[],
  fileCount: number,
  existingEdges: Array<{ fromFile: string; fromSymbol: string; toFile: string; toSymbol: string }>,
  fileToCommunity: Map<string, number>,
): GhostEdgeCandidate[] {
  if (candidates.length === 0) return [];

  // Stage 1: Frequency gate - kill entire kinds that are too widespread
  const kindFiles = new Map<GhostEdgeKind, Set<string>>();
  for (const c of candidates) {
    let files = kindFiles.get(c.kind);
    if (!files) {
      files = new Set();
      kindFiles.set(c.kind, files);
    }
    files.add(c.fromFile);
  }

  const killedKinds = new Set<GhostEdgeKind>();
  for (const [kind, files] of kindFiles) {
    if (files.size / fileCount > FREQUENCY_THRESHOLD) {
      killedKinds.add(kind);
    }
  }

  let filtered = killedKinds.size > 0 ? candidates.filter((c) => !killedKinds.has(c.kind)) : candidates;

  // Stage 2: Redundancy gate - drop edges that already exist
  const existingSet = new Set<string>();
  for (const e of existingEdges) {
    existingSet.add(`${e.fromFile}:${e.fromSymbol}->${e.toFile}:${e.toSymbol}`);
  }

  filtered = filtered.filter((c) => !existingSet.has(`${c.fromFile}:${c.fromSymbol}->${c.toFile}:${c.toSymbol}`));

  // Stage 3: Community gate - halve confidence for same-community edges
  for (const c of filtered) {
    const fromComm = fileToCommunity.get(c.fromFile);
    const toComm = fileToCommunity.get(c.toFile);
    if (fromComm !== undefined && fromComm === toComm) {
      c.confidence *= GHOST_COMMUNITY_DISCOUNT;
    }
  }

  // Stage 4: Validation gate - per-kind structural checks
  filtered = filtered.filter((c) => validateGhostEdge(c));

  return filtered;
}

/** Per-kind structural validation */
function validateGhostEdge(c: GhostEdgeCandidate): boolean {
  switch (c.kind) {
    case "ghost:di_inject":
      // DI edges must cross files (same-file DI is just a regular call)
      return c.fromFile !== c.toFile || c.fromSymbol !== c.toSymbol;
    case "ghost:trait_bound":
      // Trait bound must have distinct from/to symbols
      return c.fromSymbol !== c.toSymbol;
    case "ghost:event_bind":
      // Event edges must have evidence
      return c.evidence.eventName !== undefined;
    case "ghost:route":
    case "ghost:descriptor":
      return true;
    default:
      return true;
  }
}
