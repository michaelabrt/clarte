import type { CIAnalysisResult, FileRiskAssessment, RiskLevel } from "../../src/ci.js";

const RISK_ICONS: Record<RiskLevel, string> = {
  critical: ":red_circle:",
  high: ":orange_circle:",
  medium: ":yellow_circle:",
  low: ":green_circle:",
};

function riskIcon(level: RiskLevel): string {
  return RISK_ICONS[level];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function formatRiskTable(files: FileRiskAssessment[], threshold: RiskLevel): string {
  const thresholdOrder: RiskLevel[] = ["low", "medium", "high", "critical"];
  const minIdx = thresholdOrder.indexOf(threshold);
  const filtered = files.filter((f) => thresholdOrder.indexOf(f.riskLevel) >= minIdx);

  if (filtered.length === 0) return "";

  const rows = filtered.map((f) => {
    const reason = f.reasons[0] ?? "—";
    const role = f.role ?? "—";
    return `| \`${f.path}\` | ${riskIcon(f.riskLevel)} ${capitalize(f.riskLevel)} | ${role} | ${f.importedBy} | ${reason} |`;
  });

  return [
    "### Risk Assessment",
    "",
    "| File | Risk | Role | Imported By | Top Reason |",
    "|------|------|------|-------------|------------|",
    ...rows,
  ].join("\n");
}

function formatCoChangeWarnings(result: CIAnalysisResult): string {
  const warnings: Array<{ changedFile: string; partner: string; confidence: number; type: string }> = [];

  for (const file of result.files) {
    for (const cc of file.coChangeFiles) {
      if (!cc.inDiff) {
        warnings.push({
          changedFile: file.path,
          partner: cc.file,
          confidence: cc.confidence,
          type: cc.isHiddenCoupling ? "Hidden (no import)" : "Structural",
        });
      }
    }
  }

  if (warnings.length === 0) return "";

  // Deduplicate by partner file
  const seen = new Set<string>();
  const unique = warnings.filter((w) => {
    const key = `${w.changedFile}:${w.partner}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by confidence descending, limit to 10
  unique.sort((a, b) => b.confidence - a.confidence);
  const top = unique.slice(0, 10);

  const rows = top.map(
    (w) =>
      `| \`${w.changedFile}\` | \`${w.partner}\` | ${(w.confidence * 100).toFixed(0)}% | ${w.type} |`,
  );

  return [
    "<details>",
    `<summary>Co-change Warnings (${unique.length})</summary>`,
    "",
    "Files that frequently change together with files in this PR. Consider whether they need updates too.",
    "",
    "| Changed File | Should Check | Confidence | Type |",
    "|---|---|---|---|",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

function formatTestGaps(result: CIAnalysisResult): string {
  const gaps = result.testGaps.filter((g) => !g.hasTests);
  const covered = result.testGaps.filter((g) => g.hasTests);

  if (gaps.length === 0 && covered.length === 0) return "";

  const rows: string[] = [];
  for (const g of covered) {
    rows.push(`| \`${g.changedFile}\` | :white_check_mark: Has tests | ${g.testFiles.map((t) => `\`${t}\``).join(", ")} |`);
  }
  for (const g of gaps) {
    rows.push(`| \`${g.changedFile}\` | :x: No tests | — |`);
  }

  return [
    "<details>",
    `<summary>Test Coverage (${gaps.length} gap${gaps.length === 1 ? "" : "s"})</summary>`,
    "",
    "| Changed File | Status | Tests |",
    "|---|---|---|",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

function formatArchitecturalImpact(result: CIAnalysisResult): string {
  const { layerViolations, chokepointModifications, crossCuttingChanges, tightCouplingRisks } =
    result.architecturalImpact;

  const hasContent =
    layerViolations.length > 0 ||
    chokepointModifications.length > 0 ||
    crossCuttingChanges.length > 0 ||
    tightCouplingRisks.length > 0;

  if (!hasContent) return "";

  const lines: string[] = [];
  if (chokepointModifications.length > 0) {
    for (const c of chokepointModifications) lines.push(`- **Chokepoint modified**: ${c}`);
  }
  if (crossCuttingChanges.length > 0) {
    lines.push(
      `- **Cross-cutting changes**: ${crossCuttingChanges.map((f) => `\`${f}\``).join(", ")} span multiple layers`,
    );
  }
  if (layerViolations.length > 0) {
    for (const v of layerViolations.slice(0, 5)) lines.push(`- **Layer violation**: ${v}`);
  }
  if (tightCouplingRisks.length > 0) {
    for (const t of tightCouplingRisks.slice(0, 5)) lines.push(`- **Tight coupling**: ${t}`);
  }

  return [
    "<details>",
    "<summary>Architectural Impact</summary>",
    "",
    ...lines,
    "",
    "</details>",
  ].join("\n");
}

export function formatComment(result: CIAnalysisResult, threshold: RiskLevel): string {
  const { summary } = result;
  const icon = riskIcon(summary.overallRisk);

  const headerParts = [
    `**Overall Risk: ${icon} ${capitalize(summary.overallRisk)}**`,
    `${summary.totalFilesChanged} files changed`,
  ];
  if (summary.highRiskFiles + summary.criticalRiskFiles > 0) {
    headerParts.push(`${summary.highRiskFiles + summary.criticalRiskFiles} high-risk`);
  }
  if (summary.missingTests > 0) {
    headerParts.push(`${summary.missingTests} test gaps`);
  }
  if (summary.coChangeWarnings > 0) {
    headerParts.push(`${summary.coChangeWarnings} co-change warnings`);
  }

  const sections: string[] = [
    "## Clarte Architecture Review",
    "",
    headerParts.join(" | "),
  ];

  const riskTable = formatRiskTable(result.files, threshold);
  if (riskTable) {
    sections.push("", riskTable);
  }

  const coChange = formatCoChangeWarnings(result);
  if (coChange) {
    sections.push("", coChange);
  }

  const testGaps = formatTestGaps(result);
  if (testGaps) {
    sections.push("", testGaps);
  }

  const archImpact = formatArchitecturalImpact(result);
  if (archImpact) {
    sections.push("", archImpact);
  }

  if (!riskTable && !coChange && !testGaps && !archImpact) {
    sections.push("", ":white_check_mark: No architectural risks detected in this PR.");
  }

  sections.push(
    "",
    "---",
    `<sub>Powered by <a href="https://github.com/michaelabrt/clarte">Clarte</a></sub>`,
  );

  return sections.join("\n");
}
