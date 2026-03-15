import type { SessionMetrics } from "./metrics.js";
import type { AggregateMetrics } from "./aggregate.js";

/**
 * Format a single session report for terminal output.
 */
export function formatSessionReport(metrics: SessionMetrics, sessionId: string): string {
  const lines: string[] = [];

  lines.push(`Session: ${sessionId}`);
  lines.push(`Duration: ${formatDuration(metrics.durationSeconds)}`);
  lines.push("");

  // Phase breakdown
  lines.push("Phase Breakdown");
  lines.push(
    `  Explore:  ${metrics.exploreTurns} turns (${metrics.explorePercent}%)  $${metrics.exploreCost.toFixed(2)}`,
  );
  lines.push(`  Edit:     ${metrics.editTurns} turns (${metrics.editPercent}%)  $${metrics.editCost.toFixed(2)}`);
  lines.push(`  Tail:     ${metrics.tailTurns} turns (${metrics.tailPercent}%)  $${metrics.tailCost.toFixed(2)}`);
  lines.push(`  Total:    ${metrics.totalTurns} turns        $${metrics.totalCost.toFixed(2)}`);
  lines.push("");

  // Key indicators
  lines.push("Key Indicators");
  if (metrics.firstEditTurn !== null) {
    lines.push(`  First edit at turn ${metrics.firstEditTurn}`);
  } else {
    lines.push("  No edits made");
  }
  lines.push(`  Files: ${metrics.filesRead} read, ${metrics.filesEdited} edited (${metrics.readEditRatio}x ratio)`);
  lines.push("");

  // Waste patterns
  if (metrics.patterns.length > 0) {
    lines.push("Waste Patterns");
    for (const p of metrics.patterns) {
      lines.push(`  - ${p.description} ($${p.wastedCost.toFixed(2)})`);
    }
    lines.push(
      `  Total waste: $${metrics.totalWaste.toFixed(2)} (${metrics.totalCost > 0 ? Math.round((metrics.totalWaste / metrics.totalCost) * 100) : 0}% of session cost)`,
    );
  } else {
    lines.push("No waste patterns detected");
  }

  return lines.join("\n");
}

/**
 * Format an aggregate report across multiple sessions.
 */
export function formatAggregateReport(agg: AggregateMetrics): string {
  const lines: string[] = [];

  lines.push(`${agg.sessionCount} sessions analyzed`);
  lines.push("");

  // Averages
  lines.push("Averages (per session)");
  lines.push(`  Turns:        ${agg.avgTurns}`);
  lines.push(`  Cost:         $${agg.avgCost.toFixed(2)}`);
  lines.push(`  First edit:   ${agg.avgFirstEditTurn !== null ? `turn ${agg.avgFirstEditTurn}` : "n/a"}`);
  lines.push(`  Read/edit:    ${agg.avgReadEditRatio}x`);
  lines.push("");

  // Phase distribution
  lines.push("Phase Distribution");
  lines.push(`  Explore:  ${agg.avgExplorePercent}%`);
  lines.push(`  Edit:     ${agg.avgEditPercent}%`);
  lines.push(`  Tail:     ${agg.avgTailPercent}%`);
  lines.push("");

  // Waste summary
  lines.push("Waste");
  lines.push(`  Total:    $${agg.totalWaste.toFixed(2)} of $${agg.totalCost.toFixed(2)} (${agg.wastePercent}%)`);
  lines.push(`  Per session: $${agg.avgWaste.toFixed(2)}`);
  lines.push("");

  // Pattern frequency
  if (Object.keys(agg.patternFrequency).length > 0) {
    lines.push("Pattern Frequency");
    for (const [type, count] of Object.entries(agg.patternFrequency).sort((a, b) => b[1] - a[1])) {
      const pct = Math.round((count / agg.sessionCount) * 100);
      lines.push(`  ${type}: ${count}/${agg.sessionCount} sessions (${pct}%)`);
    }
  }

  return lines.join("\n");
}

/**
 * Format metrics as JSON for machine consumption.
 */
export function formatJson(data: SessionMetrics | AggregateMetrics): string {
  return JSON.stringify(data, null, 2);
}

function formatDuration(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}m ${secs}s`;
}
