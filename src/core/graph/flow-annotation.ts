/**
 * Community-aware path annotation.
 *
 * Annotates a node path with community membership and boundary crossings.
 * Community transitions represent architectural layer crossings
 * (e.g. [auth] -> [middleware] -> [database]).
 */

// ── Types ────────────────────────────────────────────────────────────────────

export interface CommunityInfo {
  communityId: number;
  label: string | null;
}

export interface AnnotatedStep {
  nodeId: number;
  communityId: number | null;
  communityLabel: string | null;
  /** True when this step crosses into a different community from the previous step */
  isBoundary: boolean;
}

// ── Implementation ───────────────────────────────────────────────────────────

/**
 * Annotate a path with community membership and boundary crossings.
 *
 * A boundary is marked when the community changes between consecutive nodes,
 * including transitions involving null (unknown community).
 */
export function annotateCommunities(
  path: number[],
  getCommunity: (nodeId: number) => CommunityInfo | null,
): AnnotatedStep[] {
  const steps: AnnotatedStep[] = [];
  let prevCommunityId: number | null | undefined; // sentinel: first node is never a boundary

  for (const nodeId of path) {
    const info = getCommunity(nodeId);
    const communityId = info?.communityId ?? null;
    const communityLabel = info?.label ?? null;

    const isBoundary = prevCommunityId !== undefined && communityId !== prevCommunityId;

    steps.push({ nodeId, communityId, communityLabel, isBoundary });
    prevCommunityId = communityId;
  }

  return steps;
}
