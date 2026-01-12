import fs from "node:fs/promises";
import path from "node:path";
import type { ContextAnalysis, DetectedContext, HubFile, ImportGraph } from "../types.js";

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
export async function computeFileComplexity(rootDir: string, hubFiles: HubFile[]): Promise<FileComplexityInfo[]> {
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
 * Returns imperative one-liners across multiple categories (max ~20 total).
 *
 * The optional fileComplexity parameter provides pre-computed complexity data
 * for hub files. When omitted, complexity warning directives are skipped.
 *
 * The optional graph parameter provides the import graph with betweenness
 * scores for flow bottleneck detection.
 */
export function buildDirectives(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  fileComplexity?: FileComplexityInfo[],
  graph?: ImportGraph,
): string[] {
  const directives: string[] = [];

  // 1. Foundation file guards (hub files with role === "Foundation", max 3)
  if (analysis.hubFiles) {
    const foundations = analysis.hubFiles.filter((h) => h.role === "Foundation").slice(0, 3);
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
  // Uses directional probabilities when available for more precise guidance
  if (analysis.gitActivity?.changeCoupling) {
    const highConfidence = analysis.gitActivity.changeCoupling.filter((c) => c.confidence >= 0.6).slice(0, 5);
    for (const pair of highConfidence) {
      const ab = pair.confidenceAB ?? pair.confidence;
      const ba = pair.confidenceBA ?? pair.confidence;
      // Render the stronger direction first; if asymmetric, render both as separate hints
      if (ab >= 0.6 && ba >= 0.6) {
        // Both directions are strong: use the higher one as primary
        if (ab >= ba) {
          directives.push(
            `When modifying \`${pair.fileA}\`, also check \`${pair.fileB}\` (${Math.round(ab * 100)}% of the time).`,
          );
        } else {
          directives.push(
            `When modifying \`${pair.fileB}\`, also check \`${pair.fileA}\` (${Math.round(ba * 100)}% of the time).`,
          );
        }
      } else if (ab >= 0.6) {
        directives.push(
          `When modifying \`${pair.fileA}\`, also check \`${pair.fileB}\` (${Math.round(ab * 100)}% of the time).`,
        );
      } else if (ba >= 0.6) {
        directives.push(
          `When modifying \`${pair.fileB}\`, also check \`${pair.fileA}\` (${Math.round(ba * 100)}% of the time).`,
        );
      } else {
        // Fallback to symmetric
        directives.push(
          `When modifying \`${pair.fileA}\`, also check \`${pair.fileB}\` (${Math.round(pair.confidence * 100)}% co-change confidence).`,
        );
      }
    }
  }

  // 4. Chokepoint caution (max 3)
  if (analysis.chokepoints) {
    for (const cp of analysis.chokepoints.slice(0, 3)) {
      const count = cp.upstreamCount ?? cp.separates;
      directives.push(
        `When modifying \`${cp.file}\`, note that ${count} files transitively depend on it -- API changes will cascade to all upstream dependents.`,
      );
    }
  }

  // 5. Test reminders (untested hub files with importedBy >= 2, max 3)
  if (analysis.testMapping?.untestedFiles && analysis.hubFiles) {
    const untestedSet = new Set(analysis.testMapping.untestedFiles);
    const untestedHubs = analysis.hubFiles.filter((h) => h.importedBy >= 2 && untestedSet.has(h.path)).slice(0, 3);
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
    const pairs = [...pairCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 2);
    for (const [pair, count] of pairs) {
      directives.push(
        `Layer violation: ${count} import${count === 1 ? "" : "s"} flow ${pair}. Do not add more upward dependencies.`,
      );
    }
  }

  // 7. High-churn caution (top 3 by commits, >= 10 commits, max 3)
  if (analysis.gitActivity?.hotFiles) {
    const highChurn = analysis.gitActivity.hotFiles.filter((h) => h.commits >= 10).slice(0, 3);
    for (const hot of highChurn) {
      const days = analysis.analysisDays ?? 90;
      directives.push(
        `\`${hot.path}\` is a high-churn file (${hot.commits} commits in ${days} days). Review recent changes before modifying to avoid conflicts.`,
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
        `\`${hub.path}\` is ${"aeiouAEIOU".includes(role[0]) ? "an" : "a"} ${role} file with ${band} complexity (${fc.exports} exports, ${lineDesc} lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.`,
      );
      complexCount++;
    }
  }

  // 9. Tool integration hints (check for .beads, .beans, .beans.yml)
  const toolHints = buildToolHints(ctx);
  directives.push(...toolHints);

  // 10. Technical debt flags (files with 2+ risk factors, max 5)
  {
    const riskFactors = new Map<string, string[]>();

    // Risk factor: high churn (>= 10 commits)
    if (analysis.gitActivity?.hotFiles) {
      for (const hot of analysis.gitActivity.hotFiles) {
        if (hot.commits >= 10) {
          const factors = riskFactors.get(hot.path) ?? [];
          factors.push("high churn");
          riskFactors.set(hot.path, factors);
        }
      }
    }

    // Risk factor: no tests
    if (analysis.testMapping?.untestedFiles) {
      for (const file of analysis.testMapping.untestedFiles) {
        const factors = riskFactors.get(file) ?? [];
        factors.push("no tests");
        riskFactors.set(file, factors);
      }
    }

    // Risk factor: circular dependency
    if (analysis.circularDeps) {
      for (const dep of analysis.circularDeps) {
        for (const file of dep.chain) {
          const factors = riskFactors.get(file) ?? [];
          if (!factors.includes("circular dep")) {
            factors.push("circular dep");
            riskFactors.set(file, factors);
          }
        }
      }
    }

    // Risk factor: high instability (>= 0.8 AND fanIn >= 3)
    if (analysis.instabilities) {
      for (const inst of analysis.instabilities) {
        if (inst.instability >= 0.8 && inst.fanIn >= 3) {
          const factors = riskFactors.get(inst.path) ?? [];
          factors.push("high instability");
          riskFactors.set(inst.path, factors);
        }
      }
    }

    // Risk factor: tightly coupled
    if (analysis.tightCouplings) {
      for (const tc of analysis.tightCouplings) {
        const factors = riskFactors.get(tc.from) ?? [];
        if (!factors.includes("tightly coupled")) {
          factors.push("tightly coupled");
          riskFactors.set(tc.from, factors);
        }
      }
    }

    // Get churn counts for tiebreaking
    const churnCounts = analysis.gitActivity?.commitCounts ?? new Map<string, number>();

    // Filter to files with 2+ risk factors, sort by count then churn
    const flagged = [...riskFactors.entries()]
      .filter(([, factors]) => factors.length >= 2)
      .sort((a, b) => {
        const countDiff = b[1].length - a[1].length;
        if (countDiff !== 0) return countDiff;
        const churnDiff = (churnCounts.get(b[0]) ?? 0) - (churnCounts.get(a[0]) ?? 0);
        if (churnDiff !== 0) return churnDiff;
        return a[0].localeCompare(b[0]);
      })
      .slice(0, 5);

    for (const [file, factors] of flagged) {
      const factorList = factors.join(", ");
      const advice: string[] = [];
      if (factors.includes("no tests")) advice.push("Add tests");
      if (factors.includes("circular dep")) advice.push("break the cycle");
      if (factors.includes("tightly coupled")) advice.push("Consider extracting an interface");
      if (factors.includes("high instability")) advice.push("Stabilize the API");
      if (factors.includes("high churn")) advice.push("before making large changes");

      directives.push(`\`${file}\` has multiple risk factors (${factorList}). ${advice.join(" and ")}.`);
    }
  }

  // 11. Encapsulation violation warnings (max 3)
  if (analysis.monorepoAnalysis?.encapsulationViolations) {
    for (const v of analysis.monorepoAnalysis.encapsulationViolations.slice(0, 3)) {
      directives.push(
        `\`${v.from}\` imports internal file \`${v.to}\` from package ${v.toPackage}. Use the package's public API instead.`,
      );
    }
  }

  // 12. Lag coupling hints (reactive co-change within 1-3 commits, max 3)
  if (analysis.gitActivity?.lagCouplings) {
    for (const lc of analysis.gitActivity.lagCouplings.slice(0, 3)) {
      directives.push(
        `When you modify \`${lc.fileA}\`, you'll likely need to also update \`${lc.fileB}\` within the next 1-2 commits (lagged co-change pattern).`,
      );
    }
  }

  // 13. Change impact predictions (one per hub file with predictions, max 5)
  if (analysis.changeImpact) {
    let impactCount = 0;
    for (const [hubFile, predictions] of analysis.changeImpact) {
      if (impactCount >= 5) break;
      if (predictions.length === 0) continue;
      const targets = predictions
        .slice(0, 4)
        .map((p) => `\`${p.file}\``)
        .join(", ");
      directives.push(`When modifying \`${hubFile}\`, also check: ${targets}.`);
      impactCount++;
    }
  }

  // 14. Flow bottleneck directives (high betweenness, NOT articulation points, max 3)
  if (graph?.betweennessScores) {
    const chokepointFiles = new Set((analysis.chokepoints ?? []).map((cp) => cp.file));
    const bottlenecks = [...graph.betweennessScores.entries()]
      .filter(([file, score]) => score > 0.5 && !chokepointFiles.has(file))
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 3);

    for (const [file] of bottlenecks) {
      directives.push(
        `\`${file}\` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.`,
      );
    }
  }

  // 15. Architectural fitness violations (grouped by rule, max 5)
  if (analysis.archViolations && analysis.archViolations.length > 0) {
    const byRule = new Map<string, typeof analysis.archViolations>();
    for (const v of analysis.archViolations) {
      const list = byRule.get(v.rule) ?? [];
      list.push(v);
      byRule.set(v.rule, list);
    }

    let fitnessCount = 0;

    // Test isolation: group summary
    const testIsolation = byRule.get("test-isolation");
    if (testIsolation && testIsolation.length > 0 && fitnessCount < 5) {
      if (testIsolation.length === 1) {
        directives.push(testIsolation[0].message);
      } else {
        directives.push(
          `${testIsolation.length} test files import other test files directly. Extract shared setup to test-utils/ to maintain test isolation.`,
        );
      }
      fitnessCount++;
    }

    // Layer skip: emit specific file directives (max 2)
    const layerSkips = byRule.get("layer-skip");
    if (layerSkips && layerSkips.length > 0) {
      for (const v of layerSkips.slice(0, 2)) {
        if (fitnessCount >= 5) break;
        directives.push(v.message);
        fitnessCount++;
      }
    }

    // Upward dependencies: group summary
    const upwardDeps = byRule.get("no-upward-dep");
    if (upwardDeps && upwardDeps.length > 0 && fitnessCount < 5) {
      if (upwardDeps.length === 1) {
        directives.push(upwardDeps[0].message);
      } else {
        // Group by (fromLayer, toLayer) pair and show worst
        const pairCounts = new Map<string, number>();
        for (const v of upwardDeps) {
          const fromLayer = v.message.match(/\((\w+) layer\)/)?.[1] ?? "";
          const toLayer = v.message.match(/\((\w+) layer\).*$/)?.[1] ?? "";
          const key = `${fromLayer} -> ${toLayer}`;
          pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
        }
        const topPair = [...pairCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0];
        if (topPair) {
          directives.push(
            `${upwardDeps.length} upward dependency violation${upwardDeps.length === 1 ? "" : "s"} detected. Most common: ${topPair[0]} (${topPair[1]} occurrence${topPair[1] === 1 ? "" : "s"}). Do not add more upward imports.`,
          );
        }
      }
      fitnessCount++;
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
    hints.push("Beads is configured in this project. Check `.beads/` for session context before starting work.");
  }
  if (dirs.has(".beans")) {
    hints.push("Beans is configured in this project. Check `.beans/` for memory context.");
  }

  return hints;
}

/**
 * Render a "Working Guidelines" markdown section from analysis-derived directives.
 * Returns null if no directives are generated.
 * Async because it computes file complexity for hub files.
 *
 * The optional graph parameter enables flow bottleneck detection via betweenness scores.
 */
export async function renderDirectivesSection(
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  graph?: ImportGraph,
): Promise<string | null> {
  const fileComplexity =
    analysis.hubFiles.length > 0 ? await computeFileComplexity(ctx.rootDir, analysis.hubFiles) : undefined;

  const directives = buildDirectives(analysis, ctx, fileComplexity, graph);
  if (directives.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Working Guidelines");
  lines.push("");
  lines.push("> Analysis-derived guidelines. Follow these when making changes.");
  lines.push("");
  for (const d of directives) {
    lines.push(`- ${d}`);
  }

  return lines.join("\n");
}
