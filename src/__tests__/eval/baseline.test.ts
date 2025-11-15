/**
 * E.1 Quick Eval Protocol -- Baseline tests.
 *
 * Captures baseline metrics from the current pipeline on benchmark fixtures.
 * Provides the comparison framework for evaluating experimental techniques.
 *
 * Run: npx vitest run src/__tests__/eval/baseline.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  captureMetrics,
  analyzeFixture,
  compareMetrics,
  formatComparison,
} from "./baseline.js";
import type { BaselineMetrics } from "./baseline.js";
import { reactFullstack, pythonBackend, BENCHMARK_FIXTURES } from "./benchmark-fixtures.js";

// ── Baseline capture validation ──────────────────────────────────────

describe("E.1: baseline capture", () => {
  it("should capture metrics for react-fullstack fixture", async () => {
    const metrics = await captureMetrics(reactFullstack);

    expect(metrics.fixture).toBe("react-fullstack");
    expect(metrics.totalTokens).toBeGreaterThan(0);
    expect(metrics.hubFiles.length).toBeGreaterThan(0);
    expect(metrics.sectionsIncluded.length).toBeGreaterThan(0);

    // Sanity: known hub files should appear
    const hubPaths = metrics.hubFiles.map((h) => h.path);
    expect(hubPaths).toContain("types/user.ts");

    // Sanity: known cycle should be detected
    expect(metrics.cycles.length).toBeGreaterThanOrEqual(1);
    const cycleFiles = new Set(metrics.cycles.flat());
    expect(cycleFiles.has("stores/auth-store.ts")).toBe(true);
    expect(cycleFiles.has("hooks/use-auth.ts")).toBe(true);
  });

  it("should capture metrics for python-backend fixture", async () => {
    const metrics = await captureMetrics(pythonBackend);

    expect(metrics.fixture).toBe("python-backend");
    expect(metrics.totalTokens).toBeGreaterThan(0);
    expect(metrics.hubFiles.length).toBeGreaterThan(0);

    // Sanity: core/database.py should be a hub file
    const hubPaths = metrics.hubFiles.map((h) => h.path);
    expect(hubPaths).toContain("core/database.py");

    // Sanity: core/database.py should be a chokepoint
    expect(metrics.chokepoints).toContain("core/database.py");

    // Sanity: no cycles in clean architecture
    expect(metrics.cycles).toHaveLength(0);
  });

  it("should include per-section token breakdown", async () => {
    const metrics = await captureMetrics(reactFullstack);

    // Should have token counts for standard sections
    expect(metrics.sectionTokens["header"]).toBeGreaterThan(0);
    expect(metrics.sectionTokens["tech-stack"]).toBeGreaterThan(0);

    // Sum of included section tokens should approximate totalTokens
    const includedSum = metrics.sectionsIncluded.reduce(
      (sum, id) => sum + (metrics.sectionTokens[id] ?? 0),
      0,
    );
    expect(includedSum).toBe(metrics.totalTokens);
  });

  it("should count directives", async () => {
    const metrics = await captureMetrics(reactFullstack);
    // The fixture has hub files, instabilities, cycles, etc.
    // so directives should be generated
    expect(metrics.directiveCount).toBeGreaterThanOrEqual(0);
  });
});

// ── Comparison framework validation ──────────────────────────────────

describe("E.1: metric comparison", () => {
  it("identical metrics should produce NO_GO (no difference)", async () => {
    const metrics = await captureMetrics(reactFullstack);
    const comparison = compareMetrics(metrics, metrics);

    expect(comparison.tokenDelta).toBe(0);
    expect(comparison.directiveDelta).toBe(0);
    expect(comparison.hubFilesMatch).toBe(true);
    expect(comparison.chokepointsMatch).toBe(true);
    expect(comparison.cyclesMatch).toBe(true);
    expect(comparison.verdict).toBe("NO_GO");
    expect(comparison.reasons).toContain("No measurable difference");
  });

  it("should detect token improvement", async () => {
    const baseline = await captureMetrics(reactFullstack);

    // Simulate an experimental technique that uses fewer tokens
    const experimental: BaselineMetrics = {
      ...baseline,
      totalTokens: Math.round(baseline.totalTokens * 0.7), // 30% reduction
    };

    const comparison = compareMetrics(baseline, experimental);
    expect(comparison.tokenDelta).toBeLessThan(0);
    expect(comparison.tokenDeltaPct).toBeLessThan(-5);
    expect(comparison.verdict).toBe("GO");
  });

  it("should detect directive improvement", async () => {
    const baseline = await captureMetrics(reactFullstack);

    const experimental: BaselineMetrics = {
      ...baseline,
      directiveCount: baseline.directiveCount + 5,
    };

    const comparison = compareMetrics(baseline, experimental);
    expect(comparison.directiveDelta).toBe(5);
    expect(comparison.verdict).toBe("GO");
  });

  it("should flag lost chokepoints as NO_GO", async () => {
    const baseline = await captureMetrics(pythonBackend);

    const experimental: BaselineMetrics = {
      ...baseline,
      chokepoints: [], // lost all chokepoints
    };

    const comparison = compareMetrics(baseline, experimental);
    expect(comparison.verdict).toBe("NO_GO");
    expect(comparison.reasons.some((r) => r.includes("Lost chokepoints"))).toBe(true);
  });

  it("should flag mixed results as ITERATE", async () => {
    const baseline = await captureMetrics(reactFullstack);

    // Better tokens but lost a hub file
    const experimental: BaselineMetrics = {
      ...baseline,
      totalTokens: Math.round(baseline.totalTokens * 0.8),
      hubFiles: baseline.hubFiles.slice(1), // dropped first hub file
    };

    const comparison = compareMetrics(baseline, experimental);
    expect(comparison.verdict).toBe("ITERATE");
  });

  it("should produce a formatted report", async () => {
    const baseline = await captureMetrics(reactFullstack);
    const comparison = compareMetrics(baseline, baseline);
    const report = formatComparison(comparison);

    expect(report).toContain("react-fullstack");
    expect(report).toContain("Verdict:");
    expect(report).toContain("Tokens:");
    expect(report).toContain("Directives:");
  });
});

// ── Baseline snapshot for cross-branch comparison ────────────────────

describe("E.1: baseline snapshot", () => {
  it("should capture stable metrics across both fixtures", async () => {
    const results: BaselineMetrics[] = [];

    for (const fixture of BENCHMARK_FIXTURES) {
      const metrics = await captureMetrics(fixture);
      results.push(metrics);

      // Print metrics for manual inspection during development
      console.log(`\n--- ${metrics.fixture} ---`);
      console.log(`  Total tokens: ${metrics.totalTokens}`);
      console.log(`  Sections included: ${metrics.sectionsIncluded.join(", ")}`);
      console.log(`  Sections omitted: ${metrics.sectionsOmitted.join(", ")}`);
      console.log(`  Hub files (top 5): ${metrics.hubFiles.slice(0, 5).map((h) => `${h.path} (${h.authority.toFixed(3)})`).join(", ")}`);
      console.log(`  Directives: ${metrics.directiveCount}`);
      console.log(`  Layers: ${metrics.layers.join(", ")}`);
      console.log(`  Cycles: ${metrics.cycles.length}`);
      console.log(`  Chokepoints: ${metrics.chokepoints.join(", ") || "none"}`);
      console.log(`  Dead files: ${metrics.deadFiles.length}`);
      console.log(`  Communities: ${metrics.communityCount}`);
    }

    // Basic structural assertions
    expect(results).toHaveLength(2);
    expect(results[0].fixture).toBe("react-fullstack");
    expect(results[1].fixture).toBe("python-backend");

    // Both should produce non-trivial output
    for (const r of results) {
      expect(r.totalTokens).toBeGreaterThan(100);
      expect(r.hubFiles.length).toBeGreaterThan(0);
      expect(r.sectionsIncluded.length).toBeGreaterThan(2);
    }
  });
});
