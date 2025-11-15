/**
 * E.1 Evaluation: R.2 Cartographic Typification
 *
 * Compares the typified pipeline output against the baseline (pre-typification)
 * for GO/NO GO decision.
 *
 * Run: npx vitest run src/__tests__/eval/typification-eval.test.ts
 */

import { describe, expect, it } from "vitest";
import {
  captureMetrics,
  analyzeFixture,
  compareMetrics,
  formatComparison,
} from "./baseline.js";
import { reactFullstack, pythonBackend, BENCHMARK_FIXTURES } from "./benchmark-fixtures.js";
import { typifyFiles, estimateTypificationSavings } from "../../typification.js";

describe("R.2 evaluation: typification on benchmark fixtures", () => {
  it("should identify groups in react-fullstack fixture", () => {
    const analysis = analyzeFixture(reactFullstack);
    const result = typifyFiles(analysis.hubFiles, []);

    console.log("\n--- react-fullstack typification ---");
    console.log(`  Hub files: ${analysis.hubFiles.length}`);
    console.log(`  Groups found: ${result.groups.length}`);
    for (const g of result.groups) {
      console.log(`    ${g.label}: ${g.members.map((m) => m.path).join(", ")}`);
      if (g.exceptions.length > 0) {
        console.log(`    Exceptions: ${g.exceptions.map((m) => m.path).join(", ")}`);
      }
    }
    console.log(`  Ungrouped: ${result.ungrouped.length} files`);
    for (const u of result.ungrouped) {
      console.log(`    ${u.path} (${u.role}, authority=${u.authority.toFixed(3)})`);
    }

    const savings = estimateTypificationSavings(result, new Map());
    console.log(`  Token estimate: ${savings.traditionalTokens} -> ${savings.typifiedTokens} (${savings.savedPct.toFixed(1)}% saved)`);

    // We expect some grouping given the fixture structure
    // (pages, routes, hooks, components, etc. share directory+role)
    expect(analysis.hubFiles.length).toBeGreaterThan(5);
  });

  it("should identify groups in python-backend fixture", () => {
    const analysis = analyzeFixture(pythonBackend);
    const result = typifyFiles(analysis.hubFiles, []);

    console.log("\n--- python-backend typification ---");
    console.log(`  Hub files: ${analysis.hubFiles.length}`);
    console.log(`  Groups found: ${result.groups.length}`);
    for (const g of result.groups) {
      console.log(`    ${g.label}: ${g.members.map((m) => m.path).join(", ")}`);
      if (g.exceptions.length > 0) {
        console.log(`    Exceptions: ${g.exceptions.map((m) => m.path).join(", ")}`);
      }
    }
    console.log(`  Ungrouped: ${result.ungrouped.length} files`);
    for (const u of result.ungrouped) {
      console.log(`    ${u.path} (${u.role}, authority=${u.authority.toFixed(3)})`);
    }

    const savings = estimateTypificationSavings(result, new Map());
    console.log(`  Token estimate: ${savings.traditionalTokens} -> ${savings.typifiedTokens} (${savings.savedPct.toFixed(1)}% saved)`);

    expect(analysis.hubFiles.length).toBeGreaterThan(5);
  });

  it("should produce GO/NO GO comparison for react-fullstack", async () => {
    // Capture metrics with the typification integration active
    const metrics = await captureMetrics(reactFullstack);

    // Build a "pre-typification" baseline by manually constructing
    // what the old rendering would have produced
    const analysis = analyzeFixture(reactFullstack);
    const traditionalKeyFilesTokens = analysis.hubFiles.length * 28; // ~28 tokens per table row
    const typResult = typifyFiles(analysis.hubFiles, []);
    const savings = estimateTypificationSavings(typResult, new Map());

    console.log("\n--- react-fullstack E.1 comparison ---");
    console.log(`  Current total tokens: ${metrics.totalTokens}`);
    console.log(`  Key files section tokens: ${metrics.sectionTokens["key-files"] ?? "N/A"}`);
    console.log(`  Traditional estimate: ${traditionalKeyFilesTokens} tokens for ${analysis.hubFiles.length} files`);
    console.log(`  Typified estimate: ${savings.typifiedTokens} tokens`);
    console.log(`  Groups: ${typResult.groups.length}, Ungrouped: ${typResult.ungrouped.length}`);
    console.log(`  Sections: ${metrics.sectionsIncluded.join(", ")}`);
    console.log(`  Directives: ${metrics.directiveCount}`);

    // The comparison should not lose any information
    expect(metrics.sectionsIncluded).toContain("key-files");
    expect(metrics.totalTokens).toBeGreaterThan(0);
  });

  it("should produce GO/NO GO comparison for python-backend", async () => {
    const metrics = await captureMetrics(pythonBackend);

    const analysis = analyzeFixture(pythonBackend);
    const typResult = typifyFiles(analysis.hubFiles, []);
    const savings = estimateTypificationSavings(typResult, new Map());

    console.log("\n--- python-backend E.1 comparison ---");
    console.log(`  Current total tokens: ${metrics.totalTokens}`);
    console.log(`  Key files section tokens: ${metrics.sectionTokens["key-files"] ?? "N/A"}`);
    console.log(`  Typified estimate savings: ${savings.savedPct.toFixed(1)}%`);
    console.log(`  Groups: ${typResult.groups.length}, Ungrouped: ${typResult.ungrouped.length}`);
    console.log(`  Chokepoints preserved: ${metrics.chokepoints.join(", ") || "none"}`);
    console.log(`  Cycles preserved: ${metrics.cycles.length}`);
    console.log(`  Directives: ${metrics.directiveCount}`);

    expect(metrics.sectionsIncluded).toContain("key-files");
    expect(metrics.chokepoints).toContain("core/database.py");
  });

  it("full pipeline comparison across both fixtures", async () => {
    console.log("\n========================================");
    console.log("  R.2 TYPIFICATION EVALUATION SUMMARY");
    console.log("========================================\n");

    for (const fixture of BENCHMARK_FIXTURES) {
      const analysis = analyzeFixture(fixture);
      const typResult = typifyFiles(analysis.hubFiles, []);
      const savings = estimateTypificationSavings(typResult, new Map());
      const metrics = await captureMetrics(fixture, analysis);

      console.log(`--- ${fixture.name} ---`);
      console.log(`  Total tokens: ${metrics.totalTokens}`);
      console.log(`  Groups: ${typResult.groups.length} (${typResult.groups.reduce((s, g) => s + g.members.length, 0)} files grouped)`);
      console.log(`  Ungrouped: ${typResult.ungrouped.length} files`);
      console.log(`  Key files section: ${metrics.sectionTokens["key-files"] ?? 0} tokens`);
      console.log(`  Estimated savings: ${savings.savedPct.toFixed(1)}%`);
      console.log(`  Directives: ${metrics.directiveCount}`);
      console.log(`  Chokepoints: ${metrics.chokepoints.join(", ") || "none"}`);
      console.log(`  Cycles: ${metrics.cycles.length}`);
      console.log("");
    }
  });
});
