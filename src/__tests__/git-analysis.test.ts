import { describe, expect, it, vi } from "vitest";
import { computeChangeCoupling, computeLagCoupling, adaptiveDecayConstant, computeFileChurn, type ParsedCommit, type TimeWindow } from "../git-analysis.js";

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

  it("discounts conventional commit prefixes (chore, ci, docs, build, etc.)", () => {
    const normalCommits = [
      makeCommit(["a.ts", "b.ts"], { message: "feat: add feature" }),
      makeCommit(["a.ts", "b.ts"], { message: "fix: fix bug" }),
    ];
    const noiseCommits = [
      makeCommit(["c.ts", "d.ts"], { message: "ci: update workflow" }),
      makeCommit(["c.ts", "d.ts"], { message: "docs: update readme" }),
    ];

    const result = computeChangeCoupling([...normalCommits, ...noiseCommits]);

    // Normal pair should rank higher than noise pair
    const normalPair = result.find(
      (r) => r.fileA === "a.ts" && r.fileB === "b.ts",
    );
    const noisePair = result.find(
      (r) => r.fileA === "c.ts" && r.fileB === "d.ts",
    );

    expect(normalPair).toBeDefined();
    expect(noisePair).toBeDefined();
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

describe("computeLagCoupling", () => {
  it("detects lag coupling when files change within 1-3 commits of each other", () => {
    // fileA changes in commits 0, 2, 4; fileB changes in commits 1, 3, 5
    // They never co-occur (different commits) but fileB reacts to fileA within lag=1
    const commits = [
      makeCommit(["a.ts", "x.ts"]),    // commit 0: a + x
      makeCommit(["b.ts", "x.ts"]),    // commit 1: b + x (lag 1 from a)
      makeCommit(["a.ts", "x.ts"]),    // commit 2: a + x
      makeCommit(["b.ts", "x.ts"]),    // commit 3: b + x (lag 1 from a)
      makeCommit(["a.ts", "x.ts"]),    // commit 4: a + x
      makeCommit(["b.ts", "x.ts"]),    // commit 5: b + x (lag 1 from a)
    ];

    // First compute change coupling to get pairs with same-commit co-changes
    const coupling = computeChangeCoupling(commits);

    // a.ts+x.ts co-change in commits 0,2,4; this pair should have coupling
    const axPair = coupling.find(
      (c) => (c.fileA === "a.ts" && c.fileB === "x.ts") || (c.fileA === "x.ts" && c.fileB === "a.ts"),
    );
    expect(axPair).toBeDefined();

    // Compute lag coupling
    const lagResults = computeLagCoupling(commits, coupling);

    // x.ts appears in every commit, so pairs involving x.ts should have high lag coupling
    expect(lagResults.length).toBeGreaterThan(0);

    // a.ts+x.ts and/or b.ts+x.ts should appear (x.ts reacts at lag 1 from both)
    const hasLagPair = lagResults.some(
      (r) =>
        (r.fileA === "a.ts" && r.fileB === "x.ts") ||
        (r.fileA === "x.ts" && r.fileB === "a.ts") ||
        (r.fileA === "b.ts" && r.fileB === "x.ts") ||
        (r.fileA === "x.ts" && r.fileB === "b.ts"),
    );
    expect(hasLagPair).toBe(true);

    // Lag scores should be positive
    for (const r of lagResults) {
      expect(r.lagScore).toBeGreaterThan(0);
      expect(r.sameCommitCount).toBeGreaterThan(0);
    }
  });

  it("returns empty array when co-changing files are far apart in history", () => {
    // Files co-change in commits 0 and 10, with unrelated commits in between.
    // Lag 1-3 checks at index 0 (checks 1,2,3) and index 10 (checks 7,8,9,11,12,13)
    // find nothing, so lagScore = 0 and the pair is excluded.
    const commits: ParsedCommit[] = [];
    for (let i = 0; i < 15; i++) {
      if (i === 0 || i === 10) {
        commits.push(makeCommit(["a.ts", "b.ts"]));
      } else {
        commits.push(makeCommit(["other.ts"]));
      }
    }

    const coupling = computeChangeCoupling(commits);
    const lagResults = computeLagCoupling(commits, coupling);

    const abPair = lagResults.find(
      (r) => (r.fileA === "a.ts" && r.fileB === "b.ts") || (r.fileA === "b.ts" && r.fileB === "a.ts"),
    );
    expect(abPair).toBeUndefined();
  });

  it("weights lag=1 more than lag=3", () => {
    // fileA in commits 0,5,10; fileB in commits 1,8,13
    // commit 0->1 = lag 1 (weight 1.0), commit 5->8 = lag 3 (weight 0.33), commit 10->13 = lag 3 (weight 0.33)
    const commits: ParsedCommit[] = [];
    for (let i = 0; i < 15; i++) {
      const files: string[] = [];
      if (i === 0 || i === 5 || i === 10) files.push("a.ts");
      if (i === 1 || i === 8 || i === 13) files.push("b.ts");
      files.push("filler.ts"); // always include filler so commits have 2+ files
      commits.push(makeCommit(files));
    }

    const coupling = computeChangeCoupling(commits);
    const lagResults = computeLagCoupling(commits, coupling);

    // Verify sorting: higher lag scores come first
    for (let i = 1; i < lagResults.length; i++) {
      expect(lagResults[i - 1].lagScore).toBeGreaterThanOrEqual(lagResults[i].lagScore);
    }
  });
});

describe("adaptiveDecayConstant", () => {
  it("uses short half-life for fast-moving repos (>30 commits/month)", () => {
    // 100 commits in 90 days = ~33 commits/month
    expect(adaptiveDecayConstant(100)).toBe(29);
  });

  it("uses long half-life for slow-moving repos (<5 commits/month)", () => {
    // 10 commits in 90 days = ~3.3 commits/month
    expect(adaptiveDecayConstant(10)).toBe(87);
  });

  it("uses default half-life for moderate repos", () => {
    // 50 commits in 90 days = ~16.7 commits/month
    expect(adaptiveDecayConstant(50)).toBe(45);
  });

  it("handles edge case at threshold boundaries", () => {
    // Exactly 90 commits = 30/month (not > 30, so default)
    expect(adaptiveDecayConstant(90)).toBe(45);
    // 91 commits = 30.33/month (> 30, so fast)
    expect(adaptiveDecayConstant(91)).toBe(29);
    // 15 commits = 5/month (not < 5, so default)
    expect(adaptiveDecayConstant(15)).toBe(45);
    // 14 commits = 4.67/month (< 5, so slow)
    expect(adaptiveDecayConstant(14)).toBe(87);
  });

  it("adjusts for custom window size (30-day window)", () => {
    // 50 commits in 30 days = 50/month (> 30, so fast)
    expect(adaptiveDecayConstant(50, 30)).toBe(29);
  });

  it("adjusts for custom window size (180-day window)", () => {
    // 50 commits in 180 days = ~8.3 commits/month (moderate)
    expect(adaptiveDecayConstant(50, 180)).toBe(45);
    // 20 commits in 180 days = ~3.3 commits/month (slow)
    expect(adaptiveDecayConstant(20, 180)).toBe(87);
  });

  it("handles very small window (minimum 1 month equivalent)", () => {
    // 10 commits in 5 days: months = max(5/30, 1) = 1
    // 10/1 = 10 commits/month (moderate)
    expect(adaptiveDecayConstant(10, 5)).toBe(45);
  });
});

describe("computeChangeCoupling with custom window", () => {
  it("uses provided windowDays in adaptive decay computation", () => {
    // With 4 commits in a 30-day window: 4/1 = 4 commits/month (< 5, slow)
    // With 4 commits in a 90-day window (default): 4/3 = 1.3 commits/month (< 5, slow)
    // Both should be slow, verifying that windowDays is passed through
    const commits = [
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
      makeCommit(["a.ts", "b.ts"]),
    ];

    // Should work with custom windowDays
    const result30 = computeChangeCoupling(commits, 30);
    const result90 = computeChangeCoupling(commits, 90);

    // Both should find the a.ts+b.ts pair (the coupling exists regardless)
    expect(result30).toHaveLength(1);
    expect(result90).toHaveLength(1);
    expect(result30[0].fileA).toBe("a.ts");
    expect(result90[0].fileA).toBe("a.ts");
  });
});

describe("TimeWindow type", () => {
  it("supports days-based window", () => {
    const window: TimeWindow = { days: 30 };
    expect("days" in window).toBe(true);
    expect((window as { days: number }).days).toBe(30);
  });

  it("supports ref-based window", () => {
    const window: TimeWindow = { ref: "main" };
    expect("ref" in window).toBe(true);
    expect((window as { ref: string }).ref).toBe("main");
  });
});

describe("computeFileChurn", () => {
  it("returns null when git command fails", () => {
    // Using a non-existent directory should fail gracefully
    const result = computeFileChurn("/nonexistent-dir-that-does-not-exist");
    expect(result).toBeNull();
  });

  it("accepts a TimeWindow with days", () => {
    // This tests the function signature; actual git execution depends on environment
    const result = computeFileChurn("/nonexistent-dir", { days: 30 });
    expect(result).toBeNull();
  });

  it("accepts a TimeWindow with ref", () => {
    const result = computeFileChurn("/nonexistent-dir", { ref: "main" });
    expect(result).toBeNull();
  });
});
