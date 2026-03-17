/**
 * Ghost edge candidate types and conversion.
 *
 * Ghost edges represent framework-level dependencies (DI injection, event binding,
 * route registration, trait bounds, descriptors) that are invisible to static
 * import analysis. They flow through the existing symbol edge pipeline once converted.
 */

import type { GhostEdgeKind, GhostEdgeEvidence, ExtendedEdgeKind, ResolvedSymbolEdge } from "./symbol-types";
// Re-export from canonical source so existing importers keep working
export { GHOST_CONFIDENCE, GHOST_COMMUNITY_DISCOUNT } from "../config/intent-constants";

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
