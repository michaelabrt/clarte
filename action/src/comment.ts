import type { CIAnalysisResult, FileRiskAssessment, RiskLevel } from "../../src/analysis/ci.js";

const RISK_ICONS: Record<RiskLevel, string> = {
  critical: ":red_circle:",
  high: ":orange_circle:",
  medium: ":yellow_circle:",
  low: ":green_circle:",
};

const RISK_ORDER: RiskLevel[] = ["low", "medium", "high", "critical"];

function riskIcon(level: RiskLevel): string {
  return RISK_ICONS[level];
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function riskIndex(level: RiskLevel): number {
  return RISK_ORDER.indexOf(level);
}

// ── Risk Distribution Dashboard ─────────────────────────────────────

function formatRiskDistribution(files: FileRiskAssessment[]): string {
  const counts: Record<RiskLevel, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of files) counts[f.riskLevel]++;

  return [
    "| :red_circle: Critical | :orange_circle: High | :yellow_circle: Medium | :green_circle: Low |",
    "|:---:|:---:|:---:|:---:|",
    `| ${counts.critical} | ${counts.high} | ${counts.medium} | ${counts.low} |`,
  ].join("\n");
}

// ── Files at Risk Table ─────────────────────────────────────────────

const MAX_RISK_FILES = 15;

function formatRiskTable(files: FileRiskAssessment[], threshold: RiskLevel): string {
  const minIdx = riskIndex(threshold);
  const filtered = files.filter((f) => riskIndex(f.riskLevel) >= minIdx);

  if (filtered.length === 0) return "";

  const display = filtered.slice(0, MAX_RISK_FILES);
  const truncated = filtered.length > MAX_RISK_FILES;

  const rows = display.map((f) => {
    const why = f.reasons.slice(0, 2).join("; ") || "-";
    return `| \`${f.path}\` | ${riskIcon(f.riskLevel)} ${capitalize(f.riskLevel)} | ${why} |`;
  });

  const header = truncated
    ? `### Files at Risk (showing ${MAX_RISK_FILES} of ${filtered.length})`
    : "### Files at Risk";

  return [header, "", "| File | Risk | Why |", "|------|------|-----|", ...rows].join("\n");
}

// ── Co-change Warnings ──────────────────────────────────────────────

const MAX_COCHANGE_ROWS = 10;

function formatCoChangeWarnings(result: CIAnalysisResult): string {
  const warnings: Array<{ changedFile: string; partner: string; confidence: number; type: string }> = [];

  for (const file of result.files) {
    for (const cc of file.coChangeFiles) {
      if (!cc.inDiff) {
        warnings.push({
          changedFile: file.path,
          partner: cc.file,
          confidence: cc.confidence,
          type: cc.isHiddenCoupling ? "Hidden" : "Structural",
        });
      }
    }
  }

  if (warnings.length === 0) return "";

  // Deduplicate by changedFile:partner pair
  const seen = new Set<string>();
  const unique = warnings.filter((w) => {
    const key = `${w.changedFile}:${w.partner}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // Sort by confidence descending
  unique.sort((a, b) => b.confidence - a.confidence);
  const display = unique.slice(0, MAX_COCHANGE_ROWS);
  const truncated = unique.length > MAX_COCHANGE_ROWS;

  const rows = display.map(
    (w) => `| \`${w.changedFile}\` | \`${w.partner}\` | ${(w.confidence * 100).toFixed(0)}% | ${w.type} |`,
  );

  const countLabel = truncated
    ? `${unique.length} files not in this PR, showing ${MAX_COCHANGE_ROWS}`
    : `${unique.length} file${unique.length === 1 ? "" : "s"} not in this PR`;

  return [
    "<details>",
    `<summary>:link: Co-change Warnings (${countLabel})</summary>`,
    "",
    "> These files frequently change together with files in this PR. Check if they need updates too.",
    "",
    "| Changed | Should Also Check | Confidence | Type |",
    "|---------|-------------------|------------|------|",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

// ── Test Coverage ───────────────────────────────────────────────────

function formatTestGaps(result: CIAnalysisResult): string {
  const gaps = result.testGaps.filter((g) => !g.hasTests);
  const covered = result.testGaps.filter((g) => g.hasTests);

  if (gaps.length === 0 && covered.length === 0) return "";

  const rows: string[] = [];
  for (const g of covered) {
    rows.push(`| \`${g.changedFile}\` | :white_check_mark: \`${g.testFiles[0]}\`${g.testFiles.length > 1 ? ` (+${g.testFiles.length - 1})` : ""} |`);
  }
  for (const g of gaps) {
    rows.push(`| \`${g.changedFile}\` | :x: Missing tests |`);
  }

  const gapCount = gaps.length;
  const label = gapCount > 0 ? `${gapCount} gap${gapCount === 1 ? "" : "s"}` : "all covered";

  return [
    "<details>",
    `<summary>:test_tube: Test Coverage (${label})</summary>`,
    "",
    "| File | Status |",
    "|------|--------|",
    ...rows,
    "",
    "</details>",
  ].join("\n");
}

// ── Architectural Impact ────────────────────────────────────────────

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
  for (const c of chokepointModifications) {
    lines.push(`- :pushpin: **Chokepoint modified**: ${c}`);
  }
  if (crossCuttingChanges.length > 0) {
    lines.push(
      `- :globe_with_meridians: **Cross-cutting**: ${crossCuttingChanges.map((f) => `\`${f}\``).join(", ")} span${crossCuttingChanges.length === 1 ? "s" : ""} multiple layers`,
    );
  }
  for (const v of layerViolations.slice(0, 5)) {
    lines.push(`- :warning: **Layer violation**: ${v}`);
  }
  for (const t of tightCouplingRisks.slice(0, 5)) {
    lines.push(`- :chains: **Tight coupling**: ${t}`);
  }

  return [
    "<details>",
    "<summary>:classical_building: Architectural Impact</summary>",
    "",
    ...lines,
    "",
    "</details>",
  ].join("\n");
}

// ── Main Formatter ──────────────────────────────────────────────────

export function formatComment(result: CIAnalysisResult, threshold: RiskLevel): string {
  const { summary } = result;
  const icon = riskIcon(summary.overallRisk);

  const sections: string[] = [
    "## Clarte Architecture Review",
    "",
    `> ${icon} **${capitalize(summary.overallRisk)} Risk** - ${summary.totalFilesChanged} files changed`,
  ];

  const riskTable = formatRiskTable(result.files, threshold);
  const coChange = formatCoChangeWarnings(result);
  const testGaps = formatTestGaps(result);
  const archImpact = formatArchitecturalImpact(result);

  if (!riskTable && !coChange && !testGaps && !archImpact) {
    sections.push("", ":white_check_mark: No architectural risks detected.");
  } else {
    // Risk distribution dashboard
    sections.push("", formatRiskDistribution(result.files));

    if (riskTable) sections.push("", riskTable);
    if (coChange) sections.push("", coChange);
    if (testGaps) sections.push("", testGaps);
    if (archImpact) sections.push("", archImpact);
  }

  sections.push(
    "",
    "---",
    `<sub>Powered by <a href="https://github.com/michaelabrt/clarte">Clarte</a></sub>`,
  );

  return sections.join("\n");
}
