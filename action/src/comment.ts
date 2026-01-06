import type {
  CIAnalysisResult,
  MissingCoChange,
  ChokepointAlert,
  CrossCuttingAlert,
  FlowBottleneckAlert,
  TightCouplingAlert,
} from "../../src/analysis/ci.js";

// ── Co-change Table ──────────────────────────────────────────────────

const MAX_COCHANGE_ROWS = 10;

function formatCoChangeTable(items: MissingCoChange[]): string {
  if (items.length === 0) return "";

  const display = items.slice(0, MAX_COCHANGE_ROWS);
  const truncated = items.length > MAX_COCHANGE_ROWS;

  const rows = display.map((w) => {
    const label = w.isHiddenCoupling ? "Hidden" : "Structural";
    return `| \`${w.changed}\` | \`${w.missing}\` | ${(w.confidence * 100).toFixed(0)}% | ${label} |`;
  });

  const lines: string[] = [
    "### Missing Co-changes",
    "",
    "> These files frequently change together with files in this PR but were not included.",
    "",
    "| Changed | Usually Changes With | Confidence | Coupling |",
    "|---------|----------------------|------------|----------|",
    ...rows,
  ];

  if (truncated) {
    lines.push("", `*${items.length - MAX_COCHANGE_ROWS} more not shown.*`);
  }

  return lines.join("\n");
}

// ── Structural Hotspots ──────────────────────────────────────────────

const MAX_HOTSPOT_ITEMS = 10;

function formatStructuralHotspots(
  chokepoints: ChokepointAlert[],
  flowBottlenecks: FlowBottleneckAlert[],
  crossCutting: CrossCuttingAlert[],
  collapsible: boolean,
): string {
  const lines: string[] = [];

  for (const cp of chokepoints) {
    lines.push(
      `- :pushpin: \`${cp.file}\` is a chokepoint (separates ${cp.separates} components, imported by ${cp.importedBy} files)`,
    );
  }
  for (const fb of flowBottlenecks) {
    lines.push(
      `- :repeat: \`${fb.file}\` is a flow bottleneck (betweenness ${fb.betweenness.toFixed(2)}, imported by ${fb.importedBy} files)`,
    );
  }
  for (const cc of crossCutting) {
    lines.push(
      `- :globe_with_meridians: \`${cc.file}\` spans ${cc.layerSpread} architectural layers (${cc.layers.join(", ")})`,
    );
  }

  if (lines.length === 0) return "";

  const display = lines.slice(0, MAX_HOTSPOT_ITEMS);

  if (collapsible) {
    return [
      "<details>",
      "<summary>Structural Hotspots</summary>",
      "",
      ...display,
      "",
      "</details>",
    ].join("\n");
  }

  return ["### Structural Hotspots", "", ...display].join("\n");
}

// ── Tight Coupling ───────────────────────────────────────────────────

const MAX_COUPLING_ITEMS = 5;

function formatTightCoupling(items: TightCouplingAlert[], collapsible: boolean): string {
  if (items.length === 0) return "";

  const display = items.slice(0, MAX_COUPLING_ITEMS);
  const lines = display.map(
    (tc) => `- \`${tc.from}\` imports ${tc.importedNames} names from \`${tc.to}\``,
  );

  if (collapsible) {
    return [
      "<details>",
      "<summary>Tight Coupling</summary>",
      "",
      ...lines,
      "",
      "</details>",
    ].join("\n");
  }

  return ["### Tight Coupling", "", ...lines].join("\n");
}

// ── Main Formatter ──────────────────────────────────────────────────

export function formatComment(result: CIAnalysisResult): string {
  if (!result.hasFindings) {
    return [
      "## Clarte Architecture Review",
      "",
      ":white_check_mark: No architectural concerns.",
      "",
      "---",
      `<sub>Powered by <a href="https://github.com/michaelabrt/clarte">Clarte</a></sub>`,
    ].join("\n");
  }

  const sections: string[] = ["## Clarte Architecture Review"];

  const coChangeTable = formatCoChangeTable(result.missingCoChanges);
  const hasCoChanges = coChangeTable.length > 0;

  const hotspots = formatStructuralHotspots(
    result.chokepoints,
    result.flowBottlenecks,
    result.crossCutting,
    hasCoChanges,
  );

  const coupling = formatTightCoupling(result.tightCouplings, hasCoChanges);

  if (coChangeTable) sections.push("", coChangeTable);
  if (hotspots) sections.push("", hotspots);
  if (coupling) sections.push("", coupling);

  sections.push(
    "",
    "---",
    `<sub>Powered by <a href="https://github.com/michaelabrt/clarte">Clarte</a></sub>`,
  );

  return sections.join("\n");
}
