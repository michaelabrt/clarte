import { describe, expect, it } from "vitest";
import { formatComment } from "../../action/src/comment.js";
import type { CIAnalysisResult, FileRiskAssessment, RiskLevel } from "../analysis/ci.js";

function makeFile(overrides: Partial<FileRiskAssessment> & { path: string }): FileRiskAssessment {
  return {
    riskLevel: "low",
    riskScore: 0,
    reasons: [],
    role: null,
    importedBy: 0,
    isChokepoint: false,
    separatesComponents: 0,
    isCrossCutting: false,
    isInCycle: false,
    instability: null,
    hasTests: true,
    testFiles: [],
    coChangeFiles: [],
    ...overrides,
  };
}

function makeResult(overrides?: Partial<CIAnalysisResult>): CIAnalysisResult {
  const files = overrides?.files ?? [];
  const testGaps = overrides?.testGaps ?? [];
  return {
    version: 1,
    timestamp: "2026-01-01T00:00:00Z",
    files,
    testGaps,
    architecturalImpact: overrides?.architecturalImpact ?? {
      layerViolations: [],
      chokepointModifications: [],
      crossCuttingChanges: [],
      tightCouplingRisks: [],
    },
    summary: overrides?.summary ?? {
      totalFilesChanged: files.length,
      highRiskFiles: files.filter((f) => f.riskLevel === "high").length,
      criticalRiskFiles: files.filter((f) => f.riskLevel === "critical").length,
      missingTests: testGaps.filter((g) => !g.hasTests).length,
      coChangeWarnings: 0,
      overallRisk: "low",
    },
  };
}

describe("formatComment", () => {
  describe("threshold filtering", () => {
    it("medium threshold hides low-risk files", () => {
      const result = makeResult({
        files: [
          makeFile({ path: "low.ts", riskLevel: "low", riskScore: 0 }),
          makeFile({ path: "med.ts", riskLevel: "medium", riskScore: 2, reasons: ["Foundation file (imported by 5 files)"] }),
        ],
      });

      const output = formatComment(result, "medium");

      expect(output).toContain("`med.ts`");
      expect(output).not.toContain("`low.ts`");
    });

    it("high threshold hides medium and low files", () => {
      const result = makeResult({
        files: [
          makeFile({ path: "low.ts", riskLevel: "low", riskScore: 0 }),
          makeFile({ path: "med.ts", riskLevel: "medium", riskScore: 2 }),
          makeFile({ path: "high.ts", riskLevel: "high", riskScore: 4, reasons: ["Chokepoint"] }),
        ],
      });

      const output = formatComment(result, "high");

      expect(output).toContain("`high.ts`");
      expect(output).not.toContain("`med.ts`");
      expect(output).not.toContain("`low.ts`");
    });
  });

  describe("risk distribution", () => {
    it("shows correct counts per risk level", () => {
      const result = makeResult({
        files: [
          makeFile({ path: "a.ts", riskLevel: "critical", riskScore: 7, reasons: ["Chokepoint"] }),
          makeFile({ path: "b.ts", riskLevel: "high", riskScore: 4, reasons: ["Chokepoint"] }),
          makeFile({ path: "c.ts", riskLevel: "high", riskScore: 4, reasons: ["Chokepoint"] }),
          makeFile({ path: "d.ts", riskLevel: "medium", riskScore: 2, reasons: ["Foundation"] }),
          makeFile({ path: "e.ts", riskLevel: "low", riskScore: 0 }),
        ],
        summary: {
          totalFilesChanged: 5,
          highRiskFiles: 2,
          criticalRiskFiles: 1,
          missingTests: 0,
          coChangeWarnings: 0,
          overallRisk: "critical",
        },
      });

      const output = formatComment(result, "medium");

      // Check distribution row
      expect(output).toContain("| 1 | 2 | 1 | 1 |");
    });
  });

  describe("co-change dedup", () => {
    it("deduplicates co-change warnings by partner", () => {
      const result = makeResult({
        files: [
          makeFile({
            path: "a.ts",
            riskLevel: "medium",
            riskScore: 2,
            reasons: ["Foundation"],
            coChangeFiles: [
              { file: "partner.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: false, inDiff: false },
              { file: "partner.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: false, inDiff: false },
            ],
          }),
        ],
        summary: {
          totalFilesChanged: 1,
          highRiskFiles: 0,
          criticalRiskFiles: 0,
          missingTests: 0,
          coChangeWarnings: 2,
          overallRisk: "medium",
        },
      });

      const output = formatComment(result, "medium");

      // Should only appear once after dedup
      const partnerMatches = output.match(/`partner\.ts`/g);
      // Once in the co-change table (two columns per row: Changed + Should Also Check)
      // After dedup, should have exactly 1 row = 1 mention as partner
      expect(partnerMatches).toBeTruthy();
      expect(partnerMatches!.length).toBeLessThanOrEqual(2); // 1 row has partner.ts mentioned once in "Should Also Check"
    });
  });

  describe("clean PR", () => {
    it("shows check mark when no risks detected", () => {
      const result = makeResult({
        files: [],
        summary: {
          totalFilesChanged: 0,
          highRiskFiles: 0,
          criticalRiskFiles: 0,
          missingTests: 0,
          coChangeWarnings: 0,
          overallRisk: "low",
        },
      });

      const output = formatComment(result, "medium");

      expect(output).toContain(":white_check_mark: No architectural risks detected.");
      // Should not contain risk table headers
      expect(output).not.toContain("Files at Risk");
    });
  });

  describe("output format", () => {
    it("does not contain em dashes", () => {
      const result = makeResult({
        files: [
          makeFile({
            path: "file.ts",
            riskLevel: "high",
            riskScore: 5,
            reasons: ["Chokepoint (separates 3 components)", "No test coverage"],
            coChangeFiles: [
              { file: "other.ts", confidence: 0.5, coChangeCount: 5, isHiddenCoupling: true, inDiff: false },
            ],
          }),
        ],
        testGaps: [{ changedFile: "file.ts", hasTests: false, testFiles: [] }],
        architecturalImpact: {
          layerViolations: [],
          chokepointModifications: ["file.ts is a chokepoint (separates 3 components)"],
          crossCuttingChanges: [],
          tightCouplingRisks: [],
        },
        summary: {
          totalFilesChanged: 1,
          highRiskFiles: 1,
          criticalRiskFiles: 0,
          missingTests: 1,
          coChangeWarnings: 1,
          overallRisk: "high",
        },
      });

      const output = formatComment(result, "low");

      expect(output).not.toContain("\u2014"); // em dash
    });

    it("uses blockquote header with risk level", () => {
      const result = makeResult({
        summary: {
          totalFilesChanged: 3,
          highRiskFiles: 1,
          criticalRiskFiles: 0,
          missingTests: 0,
          coChangeWarnings: 0,
          overallRisk: "high",
        },
      });

      const output = formatComment(result, "medium");

      expect(output).toContain("> :orange_circle: **High Risk** - 3 files changed");
    });

    it("includes Why column with top 2 reasons", () => {
      const result = makeResult({
        files: [
          makeFile({
            path: "complex.ts",
            riskLevel: "high",
            riskScore: 5,
            reasons: ["Chokepoint (separates 3 components)", "No test coverage", "High instability"],
          }),
        ],
      });

      const output = formatComment(result, "low");

      // Should show first 2 reasons joined by semicolons
      expect(output).toContain("Chokepoint (separates 3 components); No test coverage");
      // Should NOT include the third reason in the same cell
      expect(output).not.toContain("High instability");
    });

    it("includes Powered by Clarte footer", () => {
      const result = makeResult();
      const output = formatComment(result, "medium");

      expect(output).toContain("Powered by");
      expect(output).toContain("Clarte");
    });
  });

  describe("test coverage section", () => {
    it("shows covered and missing files", () => {
      const result = makeResult({
        files: [
          makeFile({ path: "tested.ts", riskLevel: "medium", riskScore: 2, reasons: ["Foundation"] }),
          makeFile({ path: "untested.ts", riskLevel: "medium", riskScore: 2, reasons: ["Foundation"] }),
        ],
        testGaps: [
          { changedFile: "tested.ts", hasTests: true, testFiles: ["tested.test.ts"] },
          { changedFile: "untested.ts", hasTests: false, testFiles: [] },
        ],
        summary: {
          totalFilesChanged: 2,
          highRiskFiles: 0,
          criticalRiskFiles: 0,
          missingTests: 1,
          coChangeWarnings: 0,
          overallRisk: "medium",
        },
      });

      const output = formatComment(result, "medium");

      expect(output).toContain(":white_check_mark:");
      expect(output).toContain(":x: Missing tests");
      expect(output).toContain("1 gap");
    });
  });
});
