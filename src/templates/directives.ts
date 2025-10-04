import fs from "node:fs/promises";
import path from "node:path";
import type { ContextAnalysis, DetectedContext, HubFile } from "../types.js";

/** Lightweight complexity metrics for a source file */
export interface FileComplexityInfo {
  path: string;
  exports: number;
  lines: number;
  branchPoints: number;
}

/**
 * Compute lightweight complexity indicators for hub files by reading source.
 * Counts exports, lines, and branching keywords (if, else, for, while,
 * switch, case, catch, &&, ||, ternary).
 */
export async function computeFileComplexity(
  rootDir: string,
  hubFiles: HubFile[],
): Promise<FileComplexityInfo[]> {
  const results: FileComplexityInfo[] = [];

  for (const hub of hubFiles) {
    try {
      const content = await fs.readFile(path.join(rootDir, hub.path), "utf-8");
      const lines = content.split("\n").length;
      const exports = (content.match(/\bexport\b/g) ?? []).length;

      // Cyclomatic complexity proxy: count branching keywords
      const branchPatterns = [
        /\bif\b/g,
        /\belse\b/g,
        /\bfor\b/g,
        /\bwhile\b/g,
        /\bswitch\b/g,
        /\bcase\b/g,
        /\bcatch\b/g,
        /&&/g,
        /\|\|/g,
        /\?\s*[^?]/g, // ternary (? not followed by ?)
      ];

      let branchPoints = 0;
      for (const pat of branchPatterns) {
        branchPoints += (content.match(pat) ?? []).length;
      }

      results.push({ path: hub.path, exports, lines, branchPoints });
    } catch {
      // File unreadable; skip
    }
  }

  return results;
}

/**
 * Generate actionable, analysis-derived directives for AI agent workflows.
 * Returns imperative one-liners across 9 categories (max ~20 total).
 *
 * The optional fileComplexity parameter provides pre-computed complexity data
 * for hub files. When omitted, complexity warning directives are skipped.
 */
export function buildDirectives(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  fileComplexity?: FileComplexityInfo[],
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

  // 7. High-churn caution (top 3 by commits, >= 10 commits, max 3)
  if (analysis.gitActivity?.hotFiles) {
    const highChurn = analysis.gitActivity.hotFiles
      .filter((h) => h.commits >= 10)
      .slice(0, 3);
    for (const hot of highChurn) {
      directives.push(
        `\`${hot.path}\` is a high-churn file (${hot.commits} commits in 90 days). Review recent changes before modifying to avoid conflicts.`,
      );
    }
  }

  // 8. Complexity warnings (hub files with Medium or High complexity, max 3)
  if (fileComplexity && analysis.hubFiles) {
    const complexityMap = new Map(fileComplexity.map((fc) => [fc.path, fc]));
    const hubRoleMap = new Map(analysis.hubFiles.map((h) => [h.path, h.role]));
    let complexCount = 0;

    for (const hub of analysis.hubFiles) {
      if (complexCount >= 3) break;
      const fc = complexityMap.get(hub.path);
      if (!fc) continue;

      const band = fc.branchPoints > 50 ? "high" : fc.branchPoints >= 20 ? "medium" : "low";
      if (band === "low") continue;

      const role = hubRoleMap.get(hub.path) ?? "Leaf";
      const lineDesc = fc.lines >= 1000 ? `${Math.floor(fc.lines / 100) * 100}+` : `${fc.lines}`;
      directives.push(
        `\`${hub.path}\` is a ${role} file with ${band} complexity (${fc.exports} exports, ${lineDesc} lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.`,
      );
      complexCount++;
    }
  }

  // 9. Tool integration hints (check for .beads, .beans, .beans.yml)
  const toolHints = buildToolHints(ctx);
  directives.push(...toolHints);

  // 10. Encapsulation violation warnings (max 3)
  if (analysis.monorepoAnalysis?.encapsulationViolations) {
    for (const v of analysis.monorepoAnalysis.encapsulationViolations.slice(0, 3)) {
      directives.push(
        `\`${v.from}\` imports internal file \`${v.to}\` from package ${v.toPackage}. Use the package's public API instead.`,
      );
    }
  }

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
 * Async because it computes file complexity for hub files.
 */
export async function renderDirectivesSection(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
): Promise<string | null> {
  const fileComplexity = analysis.hubFiles.length > 0
    ? await computeFileComplexity(ctx.rootDir, analysis.hubFiles)
    : undefined;

  const directives = buildDirectives(analysis, ctx, fileComplexity);
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
