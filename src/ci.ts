import type { ContextAnalysis, FileRole, ImportGraph } from "./types.js";
import { computeFileComplexity, type FileComplexityInfo } from "./templates/directives.js";

// ── Types ────────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface FileRiskAssessment {
  path: string;
  riskLevel: RiskLevel;
  riskScore: number;
  reasons: string[];
  role: FileRole | null;
  importedBy: number;
  isChokepoint: boolean;
  separatesComponents: number;
  isCrossCutting: boolean;
  isInCycle: boolean;
  instability: number | null;
  hasTests: boolean;
  testFiles: string[];
  coChangeFiles: CoChangeWarning[];
}

export interface CoChangeWarning {
  file: string;
  confidence: number;
  coChangeCount: number;
  isHiddenCoupling: boolean;
  inDiff: boolean;
}

export interface TestCoverageGap {
  changedFile: string;
  hasTests: boolean;
  testFiles: string[];
}

export interface ArchitecturalImpact {
  layerViolations: string[];
  chokepointModifications: string[];
  crossCuttingChanges: string[];
  tightCouplingRisks: string[];
}

export interface CISummary {
  totalFilesChanged: number;
  highRiskFiles: number;
  criticalRiskFiles: number;
  missingTests: number;
  coChangeWarnings: number;
  overallRisk: RiskLevel;
}

export interface CIAnalysisResult {
  version: number;
  timestamp: string;
  files: FileRiskAssessment[];
  testGaps: TestCoverageGap[];
  architecturalImpact: ArchitecturalImpact;
  summary: CISummary;
}

// ── Risk scoring ────────────────────────────────────────────────────

const WEIGHTS = {
  chokepoint: 3,
  flowBottleneck: 2,
  highImportCount: 2,
  noTests: 2,
  highComplexity: 1,
  hiddenCoupling: 1,
  crossCutting: 1,
  inCycle: 1,
  highInstability: 1,
} as const;

function scoreToLevel(score: number): RiskLevel {
  if (score >= 6) return "critical";
  if (score >= 4) return "high";
  if (score >= 2) return "medium";
  return "low";
}

function computeFileRisk(
  filePath: string,
  analysis: ContextAnalysis,
  graph: ImportGraph,
  changedFilesSet: Set<string>,
  complexityMap: Map<string, FileComplexityInfo>,
): FileRiskAssessment {
  const reasons: string[] = [];
  let score = 0;

  // Hub file lookup
  const hubFile = analysis.hubFiles.find((h) => h.path === filePath);
  const role = hubFile?.role ?? null;
  const importedBy = graph.inDegree.get(filePath) ?? 0;

  // Chokepoint
  const chokepoint = analysis.chokepoints?.find((c) => c.file === filePath);
  const isChokepoint = !!chokepoint;
  const separatesComponents = chokepoint?.separates ?? 0;
  if (isChokepoint) {
    score += WEIGHTS.chokepoint;
    reasons.push(`Chokepoint (separates ${separatesComponents} components)`);
  }

  // Flow bottleneck (high betweenness)
  const betweenness = graph.betweennessScores?.get(filePath) ?? 0;
  if (betweenness > 0.1) {
    score += WEIGHTS.flowBottleneck;
    reasons.push(`Flow bottleneck (betweenness: ${betweenness.toFixed(2)})`);
  }

  // High import count (Foundation file)
  if (importedBy >= 5) {
    score += WEIGHTS.highImportCount;
    reasons.push(`Foundation file (imported by ${importedBy} files)`);
  }

  // Test coverage
  const testFiles = analysis.testMapping?.sourceToTests.get(filePath) ?? [];
  const hasTests = testFiles.length > 0;
  if (!hasTests) {
    const isUntested = analysis.testMapping?.untestedFiles.includes(filePath) ?? false;
    if (isUntested) {
      score += WEIGHTS.noTests;
      reasons.push("No test coverage");
    }
  }

  // Complexity
  const complexity = complexityMap.get(filePath);
  if (complexity && (complexity.exports > 15 || complexity.lines > 300)) {
    score += WEIGHTS.highComplexity;
    reasons.push(`High complexity (${complexity.exports} exports, ${complexity.lines} lines)`);
  }

  // Cross-cutting
  const crossCutting = analysis.crossCuttingFiles?.find((c) => c.file === filePath);
  const isCrossCutting = !!crossCutting;
  if (isCrossCutting) {
    score += WEIGHTS.crossCutting;
    reasons.push(`Cross-cutting (spans ${crossCutting.layerSpread} layers)`);
  }

  // Circular dependency
  const isInCycle = analysis.circularDeps.some((c) => c.chain.includes(filePath));
  if (isInCycle) {
    score += WEIGHTS.inCycle;
    reasons.push("Part of circular dependency");
  }

  // Instability
  const instabilityEntry = analysis.instabilities.find((i) => i.path === filePath);
  const instability = instabilityEntry?.instability ?? null;
  if (instability !== null && instability > 0.8) {
    score += WEIGHTS.highInstability;
    reasons.push(`High instability (${instability.toFixed(2)})`);
  }

  // Co-change warnings
  const coChangeFiles: CoChangeWarning[] = [];
  if (analysis.gitActivity) {
    for (const coupling of analysis.gitActivity.changeCoupling) {
      const partner =
        coupling.fileA === filePath ? coupling.fileB : coupling.fileB === filePath ? coupling.fileA : null;
      if (partner) {
        // Check if this is hidden coupling (no direct import edge)
        const hasImportEdge = graph.edges.some(
          (e) => (e.from === filePath && e.to === partner) || (e.from === partner && e.to === filePath),
        );
        coChangeFiles.push({
          file: partner,
          confidence: coupling.confidence,
          coChangeCount: coupling.coChangeCount,
          isHiddenCoupling: !hasImportEdge,
          inDiff: changedFilesSet.has(partner),
        });
      }
    }
    // Also include structural-temporal mismatches
    if (analysis.structuralMismatches) {
      for (const m of analysis.structuralMismatches) {
        const partner = m.fileA === filePath ? m.fileB : m.fileB === filePath ? m.fileA : null;
        if (partner && !coChangeFiles.some((c) => c.file === partner)) {
          coChangeFiles.push({
            file: partner,
            confidence: m.coChangeConfidence,
            coChangeCount: m.coChangeCount,
            isHiddenCoupling: true,
            inDiff: changedFilesSet.has(partner),
          });
        }
      }
    }
    if (coChangeFiles.some((c) => c.isHiddenCoupling && !c.inDiff)) {
      score += WEIGHTS.hiddenCoupling;
      reasons.push("Has hidden coupling (co-change without import)");
    }
  }

  // Sort co-change files by confidence
  coChangeFiles.sort((a, b) => b.confidence - a.confidence);

  return {
    path: filePath,
    riskLevel: scoreToLevel(score),
    riskScore: score,
    reasons,
    role,
    importedBy,
    isChokepoint,
    separatesComponents,
    isCrossCutting,
    isInCycle,
    instability,
    hasTests,
    testFiles: [...testFiles],
    coChangeFiles,
  };
}

// ── Public API ──────────────────────────────────────────────────────

export async function analyzeForCI(
  rootDir: string,
  changedFiles: string[],
  analysis: ContextAnalysis,
  graph: ImportGraph,
): Promise<CIAnalysisResult> {
  const changedFilesSet = new Set(changedFiles);

  // Pre-compute complexity for all hub files that are in the changed set
  const hubsToCheck = analysis.hubFiles.filter((h) => changedFilesSet.has(h.path));
  const complexityList = await computeFileComplexity(rootDir, hubsToCheck);
  const complexityMap = new Map<string, FileComplexityInfo>();
  for (const c of complexityList) complexityMap.set(c.path, c);

  // Score each changed file
  const files = changedFiles.map((f) => computeFileRisk(f, analysis, graph, changedFilesSet, complexityMap));

  // Sort by risk score descending
  files.sort((a, b) => b.riskScore - a.riskScore);

  // Test coverage gaps
  const testGaps: TestCoverageGap[] = changedFiles.map((f) => {
    const testFiles = analysis.testMapping?.sourceToTests.get(f) ?? [];
    return { changedFile: f, hasTests: testFiles.length > 0, testFiles: [...testFiles] };
  });

  // Architectural impact
  const layerViolations: string[] = [];
  if (analysis.layerConsistency) {
    for (const v of analysis.layerConsistency.violations) {
      if (changedFilesSet.has(v.from) || changedFilesSet.has(v.to)) {
        layerViolations.push(`${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`);
      }
    }
  }

  const chokepointModifications: string[] = [];
  for (const f of files) {
    if (f.isChokepoint) {
      chokepointModifications.push(`${f.path} is a chokepoint (separates ${f.separatesComponents} components)`);
    }
  }

  const crossCuttingChanges: string[] = [];
  for (const f of files) {
    if (f.isCrossCutting) {
      crossCuttingChanges.push(f.path);
    }
  }

  const tightCouplingRisks: string[] = [];
  if (analysis.tightCouplings) {
    for (const tc of analysis.tightCouplings) {
      if (changedFilesSet.has(tc.from) || changedFilesSet.has(tc.to)) {
        tightCouplingRisks.push(`${tc.from} imports ${tc.importedNames} names from ${tc.to}`);
      }
    }
  }

  const architecturalImpact: ArchitecturalImpact = {
    layerViolations,
    chokepointModifications,
    crossCuttingChanges,
    tightCouplingRisks,
  };

  // Summary
  const highRiskFiles = files.filter((f) => f.riskLevel === "high").length;
  const criticalRiskFiles = files.filter((f) => f.riskLevel === "critical").length;
  const missingTests = testGaps.filter((g) => !g.hasTests).length;
  const coChangeWarnings = files.reduce((sum, f) => sum + f.coChangeFiles.filter((c) => !c.inDiff).length, 0);

  const maxRisk = files[0]?.riskLevel ?? "low";
  const overallRisk: RiskLevel = criticalRiskFiles > 0 ? "critical" : highRiskFiles > 0 ? "high" : maxRisk;

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    files,
    testGaps,
    architecturalImpact,
    summary: {
      totalFilesChanged: changedFiles.length,
      highRiskFiles,
      criticalRiskFiles,
      missingTests,
      coChangeWarnings,
      overallRisk,
    },
  };
}
