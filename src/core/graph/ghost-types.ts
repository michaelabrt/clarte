/**
 * RFC-002 Phase 5: Ghost edge candidate types and conversion.
 *
 * Ghost edges represent framework-level dependencies (DI injection, event binding,
 * route registration, trait bounds, descriptors) that are invisible to static
 * import analysis. They flow through the existing symbol edge pipeline once converted.
 */

import type { GhostEdgeKind, GhostEdgeEvidence, ExtendedEdgeKind, ResolvedSymbolEdge } from "./symbol-types";

/** Default confidence for ghost edge candidates (low, gated by noise filter) */
export const GHOST_CONFIDENCE = 0.15;

/** Discount applied when ghost edge endpoints are in the same community */
export const GHOST_COMMUNITY_DISCOUNT = 0.5;

export interface GhostEdgeCandidate {
  fromFile: string;
  fromSymbol: string;
  toFile: string;
  toSymbol: string;
  kind: GhostEdgeKind;
  confidence: number;
  line: number;
  evidence: GhostEdgeEvidence;
}

/** Convert a filtered ghost candidate to a ResolvedSymbolEdge for pipeline integration */
export function ghostCandidateToResolved(c: GhostEdgeCandidate): ResolvedSymbolEdge {
  return {
    fromFile: c.fromFile,
    fromSymbol: c.fromSymbol,
    toFile: c.toFile,
    toSymbol: c.toSymbol,
    kind: c.kind as ExtendedEdgeKind,
    line: c.line,
    confidence: c.confidence,
  };
}
