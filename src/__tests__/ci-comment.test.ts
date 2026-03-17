import { describe, expect, it } from "vitest";
import { formatComment } from "../../action/src/comment";
import type { CIAnalysisResult } from "../core/analysis/ci";

function makeResult(overrides?: Partial<CIAnalysisResult>): CIAnalysisResult {
  return {
    version: 2,
    timestamp: "2026-01-01T00:00:00Z",
    filesAnalyzed: 0,
    missingCoChanges: [],
    chokepoints: [],
    crossCutting: [],
    flowBottlenecks: [],
    tightCouplings: [],
    hasFindings: false,
    ...overrides,
  };
}

describe("formatComment", () => {
  describe("clean PR", () => {
    it("shows check mark and no section headers", () => {
      const output = formatComment(makeResult());

      expect(output).toContain(":white_check_mark: No architectural concerns.");
      expect(output).not.toContain("### Missing Co-changes");
      expect(output).not.toContain("Structural Hotspots");
      expect(output).not.toContain("Tight Coupling");
    });

    it("includes Powered by Clarte footer", () => {
      const output = formatComment(makeResult());

      expect(output).toContain("Powered by");
      expect(output).toContain("Clarté");
    });
  });

  describe("co-change table", () => {
    it("renders a table with correct columns", () => {
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "partner.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: false },
        ],
      });

      const output = formatComment(result);

      expect(output).toContain("### Missing Co-changes");
      expect(output).toContain("| Changed | Usually Changes With | Confidence | Coupling |");
      expect(output).toContain("`a.ts`");
      expect(output).toContain("`partner.ts`");
      expect(output).toContain("50%");
      expect(output).toContain("Structural");
    });

    it("labels hidden coupling correctly", () => {
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "far.ts", confidence: 0.7, coChangeCount: 8, isHiddenCoupling: true },
        ],
      });

      const output = formatComment(result);

      expect(output).toContain("Hidden");
    });

    it("truncates beyond 10 rows", () => {
      const items = Array.from({ length: 12 }, (_, i) => ({
        changed: `file${i}.ts`,
        missing: `partner${i}.ts`,
        confidence: 0.5,
        coChangeCount: 5,
        isHiddenCoupling: false,
      }));

      const result = makeResult({ hasFindings: true, missingCoChanges: items });
      const output = formatComment(result);

      // Should show truncation note
      expect(output).toContain("2 more not shown");
      // Should not render row 11 or 12
      expect(output).not.toContain("`file10.ts`");
      expect(output).not.toContain("`file11.ts`");
    });

    it("preserves input order (hidden before structural from analyzeForCI)", () => {
      // analyzeForCI sorts hidden first; formatComment renders in given order
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "hidden.ts", confidence: 0.3, coChangeCount: 3, isHiddenCoupling: true },
          { changed: "a.ts", missing: "structural.ts", confidence: 0.9, coChangeCount: 10, isHiddenCoupling: false },
        ],
      });

      const output = formatComment(result);
      const hiddenIdx = output.indexOf("hidden.ts");
      const structuralIdx = output.indexOf("structural.ts");

      expect(hiddenIdx).toBeLessThan(structuralIdx);
    });
  });

  describe("structural hotspots", () => {
    it("renders chokepoints, bottlenecks and cross-cutting", () => {
      const result = makeResult({
        hasFindings: true,
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
        flowBottlenecks: [{ file: "hub.ts", betweenness: 0.25, importedBy: 10 }],
        crossCutting: [{ file: "types.ts", layerSpread: 3, layers: ["a", "b", "c"], totalImporters: 20 }],
      });

      const output = formatComment(result);

      expect(output).toContain(":pushpin: `utils.ts` is a chokepoint");
      expect(output).toContain(":repeat: `hub.ts` is a flow bottleneck");
      expect(output).toContain(":globe_with_meridians: `types.ts` spans 3 architectural layers");
    });

    it("is collapsible when co-changes section is present", () => {
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "b.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: false },
        ],
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
      });

      const output = formatComment(result);

      expect(output).toContain("<details>");
      expect(output).toContain("<summary>Structural Hotspots</summary>");
    });

    it("is not collapsible when co-changes section is absent", () => {
      const result = makeResult({
        hasFindings: true,
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
      });

      const output = formatComment(result);

      expect(output).toContain("### Structural Hotspots");
      expect(output).not.toContain("<summary>Structural Hotspots</summary>");
    });
  });

  describe("tight coupling", () => {
    it("renders coupling items", () => {
      const result = makeResult({
        hasFindings: true,
        tightCouplings: [{ from: "cache.ts", to: "types.ts", importedNames: 15 }],
      });

      const output = formatComment(result);

      expect(output).toContain("`cache.ts` imports 15 names from `types.ts`");
    });

    it("is collapsible when co-changes are present", () => {
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "b.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: false },
        ],
        tightCouplings: [{ from: "cache.ts", to: "types.ts", importedNames: 15 }],
      });

      const output = formatComment(result);

      expect(output).toContain("<summary>Tight Coupling</summary>");
    });
  });

  describe("output format", () => {
    it("does not contain em dashes", () => {
      const result = makeResult({
        hasFindings: true,
        missingCoChanges: [
          { changed: "a.ts", missing: "b.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: true },
        ],
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
        tightCouplings: [{ from: "cache.ts", to: "types.ts", importedNames: 15 }],
      });

      const output = formatComment(result);

      expect(output).not.toContain("\u2014"); // em dash
    });

    it("does not render empty sections", () => {
      const result = makeResult({
        hasFindings: true,
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
        // no co-changes, no tight coupling
      });

      const output = formatComment(result);

      expect(output).not.toContain("Missing Co-changes");
      expect(output).not.toContain("Tight Coupling");
      expect(output).toContain("Structural Hotspots");
    });

    it("includes Powered by Clarte footer on findings", () => {
      const result = makeResult({
        hasFindings: true,
        chokepoints: [{ file: "utils.ts", separates: 5, importedBy: 44 }],
      });

      const output = formatComment(result);

      expect(output).toContain("Powered by");
      expect(output).toContain("Clarté");
    });
  });
});
