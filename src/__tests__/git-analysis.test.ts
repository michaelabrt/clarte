import { describe, expect, it } from "vitest";
import { computeChangeCoupling, type ParsedCommit } from "../git-analysis.js";

function makeCommit(
  files: string[],
  overrides?: Partial<ParsedCommit>,
): ParsedCommit {
  return {
    hash: Math.random().toString(36).slice(2, 10),
    date: new Date().toISOString(),
    relativeDate: "1 day ago",
    message: overrides?.message ?? "feat: normal commit",
    files,
    ...overrides,
  };
}

describe("computeChangeCoupling", () => {
  it("detects co-changing file pairs", () => {
    const commits = [
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
    ];

    const result = computeChangeCoupling(commits);

    expect(result).toHaveLength(1);
    expect(result[0].fileA).toBe("a.ts");
    expect(result[0].fileB).toBe("b.ts");
    expect(result[0].coChangeCount).toBe(3);
    expect(result[0].confidence).toBe(1.0); // Jaccard: 3/3 = 1.0
  });

  it("discounts lint/format commits", () => {
    const normalCommits = [
      makeCommit(["a.ts", "b.ts"], { message: "feat: add feature" }),
      makeCommit(["a.ts", "b.ts"], { message: "fix: fix bug" }),
    ];
    const lintCommits = [
      makeCommit(["c.ts", "d.ts"], { message: "style: run prettier" }),
      makeCommit(["c.ts", "d.ts"], { message: "chore: lint fixes" }),
    ];

    const result = computeChangeCoupling([...normalCommits, ...lintCommits]);

    // Both pairs should appear, but normal pair should rank higher (weighted score)
    const normalPair = result.find(
      (r) => r.fileA === "a.ts" && r.fileB === "b.ts",
    );
    const lintPair = result.find(
      (r) => r.fileA === "c.ts" && r.fileB === "d.ts",
    );

    expect(normalPair).toBeDefined();
    expect(lintPair).toBeDefined();
    // Normal pair should be first (higher weighted score)
    expect(result[0].fileA).toBe("a.ts");
  });

  it("skips single-file commits", () => {
    const commits = [
      makeCommit(["a.ts"]),
      makeCommit(["a.ts"]),
      makeCommit(["a.ts"]),
    ];

    const result = computeChangeCoupling(commits);
    expect(result).toHaveLength(0);
  });

  it("handles large commits with inverse-size weighting", () => {
    // A 2-file commit should contribute more per-pair than a 10-file commit
    const smallCommits = [
      makeCommit(["x.ts", "y.ts"]),
      makeCommit(["x.ts", "y.ts"]),
    ];
    const largeCommits = [
      makeCommit(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts"]),
      makeCommit(["a.ts", "b.ts", "c.ts", "d.ts", "e.ts", "f.ts", "g.ts", "h.ts", "i.ts", "j.ts"]),
    ];

    const result = computeChangeCoupling([...smallCommits, ...largeCommits]);

    // The x.ts+y.ts pair should rank highest due to higher weight per pair
    const smallPair = result.find(
      (r) => r.fileA === "x.ts" && r.fileB === "y.ts",
    );
    expect(smallPair).toBeDefined();
    expect(result[0].fileA).toBe("x.ts");
  });

  it("computes Jaccard similarity correctly", () => {
    // fileA appears in 4 commits, fileB in 3 commits, they overlap in 2
    const commits = [
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "c.ts"]),
      makeCommit(["a.ts", "c.ts"]),
      makeCommit(["b.ts", "c.ts"]),
    ];

    const result = computeChangeCoupling(commits);

    // a.ts+b.ts: intersection=2, A={0,1,2,3}, B={0,1,4} → union=5 → Jaccard=2/5=0.4
    const abPair = result.find(
      (r) =>
        (r.fileA === "a.ts" && r.fileB === "b.ts") ||
        (r.fileA === "b.ts" && r.fileB === "a.ts"),
    );
    expect(abPair).toBeDefined();
    expect(abPair!.confidence).toBeCloseTo(0.4, 1);
  });
});
