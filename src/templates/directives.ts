import fs from "node:fs/promises";
import path from "node:path";
import type { ContextAnalysis, DetectedContext } from "../types.js";

/**
 * Generate actionable, analysis-derived directives for AI agent workflows.
 * Returns imperative one-liners across 7 categories (max ~15 total).
 */
export function buildDirectives(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
): string[] {
  const directives: string[] = [];

  // 1. Foundation file guards (hub files with role === "Foundation", max 3)
  if (analysis.hubFiles) {
    const foundations = analysis.hubFiles
      .filter((h) => h.role === "Foundation")
      .slice(0, 3);
    for (const hub of foundations) {
      directives.push(
        `When modifying \`${hub.path}\` (Foundation, imported by ${hub.importedBy} files), check dependents for breaking changes.`,
      );
    }
  }

  // 2. Circular dep guidance (max 3)
  if (analysis.circularDeps) {
    for (const dep of analysis.circularDeps.slice(0, 3)) {
      if (dep.breakHint) {
        directives.push(dep.breakHint);
      } else {
        const shortChain = dep.chain.map((f) => `\`${f}\``).join(" -> ");
        directives.push(`Break circular dependency: ${shortChain}.`);
      }
    }
  }

  // 3. Co-change hints (confidence >= 0.6, max 5)
  if (analysis.gitActivity?.changeCoupling) {
    const highConfidence = analysis.gitActivity.changeCoupling
      .filter((c) => c.confidence >= 0.6)
      .slice(0, 5);
    for (const pair of highConfidence) {
      const pct = Math.round(pair.confidence * 100);
      directives.push(
        `When modifying \`${pair.fileA}\`, also check \`${pair.fileB}\` (${pct}% co-change confidence).`,
      );
    }
  }

  // 4. Chokepoint caution (max 3)
  if (analysis.chokepoints) {
    for (const cp of analysis.chokepoints.slice(0, 3)) {
      directives.push(
        `\`${cp.file}\` is a structural chokepoint (separates ${cp.separates} components). Refactor with extreme care.`,
      );
    }
  }

  // 5. Test reminders (untested hub files with importedBy >= 2, max 3)
  if (analysis.testMapping?.untestedFiles && analysis.hubFiles) {
    const untestedSet = new Set(analysis.testMapping.untestedFiles);
    const untestedHubs = analysis.hubFiles
      .filter((h) => h.importedBy >= 2 && untestedSet.has(h.path))
      .slice(0, 3);
    for (const hub of untestedHubs) {
      directives.push(
        `\`${hub.path}\` (imported by ${hub.importedBy} files) has no tests. Add test coverage before modifying.`,
      );
    }
  }

  // 6. Layer violation warnings (grouped by layer pair, max 2)
  if (analysis.layerConsistency?.violations) {
    const pairCounts = new Map<string, number>();
    for (const v of analysis.layerConsistency.violations) {
      const key = `${v.fromLayer} -> ${v.toLayer}`;
      pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    }
    const pairs = [...pairCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2);
    for (const [pair, count] of pairs) {
      directives.push(
        `Layer violation: ${count} import${count === 1 ? "" : "s"} flow ${pair}. Do not add more upward dependencies.`,
      );
    }
  }

  // 7. Tool integration hints (check for .beads, .beans, .beans.yml)
  const toolHints = buildToolHints(ctx);
  directives.push(...toolHints);

  return directives;
}

/**
 * Check for co-located tool config files and generate integration hints.
 */
function buildToolHints(ctx: DetectedContext): string[] {
  const hints: string[] = [];
  const dirs = new Set(ctx.directories);

  if (dirs.has(".beads")) {
    hints.push(
      "Beads is configured in this project. Check `.beads/` for session context before starting work.",
    );
  }
  if (dirs.has(".beans")) {
    hints.push(
      "Beans is configured in this project. Check `.beans/` for memory context.",
    );
  }

  return hints;
}

/**
 * Render a "Working Guidelines" markdown section from analysis-derived directives.
 * Returns null if no directives are generated.
 */
export function renderDirectivesSection(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
): string | null {
  const directives = buildDirectives(analysis, ctx);
  if (directives.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Working Guidelines");
  lines.push("");
  lines.push(
    "> Analysis-derived guidelines. Follow these when making changes.",
  );
  lines.push("");
  for (const d of directives) {
    lines.push(`- ${d}`);
  }

  return lines.join("\n");
}
