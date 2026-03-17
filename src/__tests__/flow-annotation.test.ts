import { describe, it, expect } from "vitest";
import { annotateCommunities } from "../core/graph/flow-annotation";
import type { CommunityInfo } from "../core/graph/flow-annotation";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeLookup(mapping: Map<number, CommunityInfo | null>): (nodeId: number) => CommunityInfo | null {
  return (nodeId) => mapping.get(nodeId) ?? null;
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("annotateCommunities", () => {
  it("1.4.1 marks boundary when community changes", () => {
    // A, B in community 0; C in community 1
    const lookup = makeLookup(
      new Map([
        [1, { communityId: 0, label: "auth" }],
        [2, { communityId: 0, label: "auth" }],
        [3, { communityId: 1, label: "database" }],
      ]),
    );

    const steps = annotateCommunities([1, 2, 3], lookup);

    expect(steps[0].isBoundary).toBe(false);
    expect(steps[1].isBoundary).toBe(false); // same community as prev
    expect(steps[2].isBoundary).toBe(true); // community changed
    expect(steps[2].communityLabel).toBe("database");
  });

  it("1.4.2 single node: no boundary", () => {
    const lookup = makeLookup(new Map([[1, { communityId: 0, label: "core" }]]));

    const steps = annotateCommunities([1], lookup);

    expect(steps.length).toBe(1);
    expect(steps[0].isBoundary).toBe(false);
  });

  it("1.4.3 null community: boundary on transition", () => {
    const lookup = makeLookup(
      new Map<number, CommunityInfo | null>([
        [1, { communityId: 0, label: "auth" }],
        [2, null], // unknown community
        [3, { communityId: 0, label: "auth" }],
      ]),
    );

    const steps = annotateCommunities([1, 2, 3], lookup);

    expect(steps[0].isBoundary).toBe(false);
    expect(steps[1].isBoundary).toBe(true); // 0 -> null
    expect(steps[1].communityId).toBeNull();
    expect(steps[2].isBoundary).toBe(true); // null -> 0
  });

  it("1.4.4 all same community: no boundaries", () => {
    const lookup = makeLookup(
      new Map([
        [1, { communityId: 0, label: "core" }],
        [2, { communityId: 0, label: "core" }],
        [3, { communityId: 0, label: "core" }],
      ]),
    );

    const steps = annotateCommunities([1, 2, 3], lookup);

    expect(steps.every((s) => !s.isBoundary)).toBe(true);
  });

  it("1.4.5 empty path: returns empty", () => {
    const steps = annotateCommunities([], () => null);
    expect(steps).toEqual([]);
  });

  it("1.4.6 multiple transitions: each crossing marked", () => {
    const lookup = makeLookup(
      new Map([
        [1, { communityId: 0, label: "api" }],
        [2, { communityId: 1, label: "service" }],
        [3, { communityId: 2, label: "database" }],
      ]),
    );

    const steps = annotateCommunities([1, 2, 3], lookup);

    expect(steps[0].isBoundary).toBe(false);
    expect(steps[1].isBoundary).toBe(true);
    expect(steps[2].isBoundary).toBe(true);
  });
});
