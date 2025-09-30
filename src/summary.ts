import { theme as t, gradient, getGradientBarColors } from "./theme.js";
import type { CodeSnapshot, ContextAnalysis, DetectedContext, GeneratedFile } from "./types.js";
import { estimateTokens, formatBytes } from "./utils.js";

/**
 * Print a summary of generated files with token estimates.
 */
export function printSummary(
  files: GeneratedFile[],
  ctx: DetectedContext,
  snapshot?: CodeSnapshot | null,
  analysis?: ContextAnalysis,
): void {
  if (files.length === 0) return;

  console.log("");
  console.log(t.brandBold("  Files created:"));
  console.log("");

  // Track totals
  let totalBytes = 0;
  let totalTokens = 0;
  let alwaysOnTokens = 0;
  let scopedRuleTokens: number[] = [];

  // Group files: main context vs scoped rules
  const mainFiles = files.filter((f) => !f.path.includes(".cursor/rules/"));
  const ruleFiles = files.filter((f) => f.path.includes(".cursor/rules/"));

  // Pre-compute row data for aligned output
  const fileRows: Array<{
    indent: string;
    name: string;
    size: string;
    tokens: string;
    isUpdated: boolean;
    isHeader: boolean;
  }> = [];

  for (const file of mainFiles) {
    const bytes = Buffer.byteLength(file.content, "utf-8");
    const tokens = estimateTokens(file.content);
    totalBytes += bytes;
    totalTokens += tokens;
    alwaysOnTokens += tokens;

    fileRows.push({
      indent: "    ",
      name: file.path,
      size: formatBytes(bytes),
      tokens: `(~${formatNumber(tokens)} tokens)`,
      isUpdated: !!file.existed,
      isHeader: false,
    });
  }

  if (ruleFiles.length > 0) {
    fileRows.push({
      indent: "    ",
      name: ".cursor/rules/",
      size: "",
      tokens: "",
      isUpdated: false,
      isHeader: true,
    });

    // global.md is always-on, others are scoped
    for (const file of ruleFiles) {
      const bytes = Buffer.byteLength(file.content, "utf-8");
      const tokens = estimateTokens(file.content);
      totalBytes += bytes;
      totalTokens += tokens;

      const filename = file.path.split("/").pop() ?? file.path;
      const isGlobal = filename === "global.md";

      if (isGlobal) {
        alwaysOnTokens += tokens;
      } else {
        scopedRuleTokens.push(tokens);
      }

      fileRows.push({
        indent: "      ",
        name: filename,
        size: formatBytes(bytes),
        tokens: `(~${formatNumber(tokens)} tokens)`,
        isUpdated: !!file.existed,
        isHeader: false,
      });
    }
  }

  // Derive column widths from row data
  const dataFileRows = fileRows.filter((r) => !r.isHeader);
  const maxNameCol = Math.max(...fileRows.map((r) => r.indent.length + r.name.length));
  const maxSizeWidth = Math.max(...dataFileRows.map((r) => r.size.length));
  const maxTokenWidth = Math.max(...dataFileRows.map((r) => r.tokens.length));

  // Print aligned rows
  for (const row of fileRows) {
    if (row.isHeader) {
      console.log(`${row.indent}${t.accent(row.name)}`);
    } else {
      const status = row.isUpdated ? t.muted("(updated)") : t.success("(new)");
      const paddedName = row.name.padEnd(maxNameCol - row.indent.length);
      console.log(
        `${row.indent}${t.accent(paddedName)}  ${row.size.padStart(maxSizeWidth)}  ${t.muted(row.tokens.padEnd(maxTokenWidth))}  ${status}`,
      );
    }
  }

  console.log("");
  console.log(
    t.muted(
      `    Total: ${formatBytes(totalBytes)}, ~${formatNumber(totalTokens)} tokens`,
    ),
  );

  if (snapshot?.budgetExcluded && snapshot.budgetExcluded > 0) {
    console.log(
      t.muted(
        `    (${snapshot.budgetExcluded} snapshot entries excluded by token budget)`,
      ),
    );
  }

  // Analysis summary
  if (analysis) {
    const parts: string[] = [];
    if (analysis.hubFiles.length > 0) parts.push(`${analysis.hubFiles.length} key files`);
    if (analysis.layers.length > 0) parts.push(`${analysis.layers.length} architecture layers`);
    if (analysis.circularDeps.length > 0) parts.push(`${analysis.circularDeps.length} circular deps`);
    if (analysis.communities.length > 0) parts.push(`${analysis.communities.length} module clusters`);
    if (analysis.gitActivity) parts.push(`${analysis.gitActivity.hotFiles.length} recently active files`);
    if (parts.length > 0) {
      console.log(
        t.muted(`    Includes: ${parts.join(", ")}`),
      );
    }
  }

  // -- Token estimate comparison (bar chart) --
  console.log("");
  console.log(t.brandBold("  Estimated context cost per conversation:"));
  console.log("");

  // Before: estimate exploration cost from source file count + size
  const explorationTokens = estimateExplorationCost(ctx);

  // After
  const avgScopedTokens =
    scopedRuleTokens.length > 0
      ? Math.round(
          scopedRuleTokens.reduce((a, b) => a + b, 0) /
            scopedRuleTokens.length,
        )
      : 0;

  const residualExploration = Math.round(explorationTokens * 0.05);
  const afterTotal = alwaysOnTokens + avgScopedTokens + residualExploration;
  const savings = Math.round(
    ((explorationTokens - afterTotal) / explorationTokens) * 100,
  );

  // Bar chart: gradient bars with depth, max 40 chars wide
  const BAR_MAX = 40;
  const maxVal = Math.max(explorationTokens, afterTotal);
  const beforeBarLen = Math.max(1, Math.round((explorationTokens / maxVal) * BAR_MAX));
  const afterBarLen = Math.max(1, Math.round((afterTotal / maxVal) * BAR_MAX));
  const savedLen = Math.max(0, beforeBarLen - afterBarLen);

  // Palette-derived gradient colors
  const barColors = getGradientBarColors();
  const beforeBar = gradient(
    "\u2588".repeat(beforeBarLen),
    barColors.from,
    barColors.to,
    t.brand,
  );
  const afterBar = gradient(
    "\u2588".repeat(afterBarLen),
    barColors.from,
    barColors.to,
    t.accent,
  );
  const savedBar = t.muted("\u2591".repeat(savedLen));

  console.log(`    ${t.text("Before")}  ${beforeBar}  ${t.muted(`~${formatNumber(explorationTokens)} tokens`)}`);
  console.log(`    ${t.text("After")}   ${afterBar}${savedBar}  ${t.muted(`~${formatNumber(afterTotal)} tokens`)}`);

  console.log("");

  if (savings > 0) {
    console.log(
      t.success(
        `    Estimated savings: ~${savings}% fewer tokens`,
      ),
    );
  }

  // "What we analyzed" recap
  if (analysis) {
    console.log("");
    console.log(t.brandBold("  What we analyzed:"));

    const recapRows: Array<{ label: string; result: string }> = [];

    if (analysis.hubFiles.length > 0) {
      recapRows.push({ label: "HITS analysis", result: `found ${analysis.hubFiles.length} key architectural files` });
    }

    recapRows.push({
      label: "Tarjan cycle detection",
      result: analysis.circularDeps.length === 0
        ? "no circular dependencies found"
        : `${analysis.circularDeps.length} circular dep${analysis.circularDeps.length === 1 ? "" : "s"} found`,
    });

    if (analysis.layers.length > 0) {
      const tierNames = analysis.layers.map((l) => l.name).join(" → ");
      recapRows.push({ label: "Layer analysis", result: `${analysis.layers.length} tiers: ${tierNames}` });
    }

    if (analysis.gitActivity) {
      const coupledPairs = analysis.gitActivity.changeCoupling.length;
      recapRows.push({
        label: "Git history (90 days)",
        result: `${analysis.gitActivity.hotFiles.length} hot files, ${coupledPairs} change-coupled pair${coupledPairs === 1 ? "" : "s"}`,
      });
    }

    const ec = analysis.exportCoverage;
    if (ec && ec.length > 0) {
      const totalExports = ec.reduce((sum, e) => sum + e.totalExports, 0);
      const totalUsed = ec.reduce((sum, e) => sum + e.usedExports, 0);
      const coveragePct = totalExports > 0 ? Math.round((totalUsed / totalExports) * 100) : 100;
      const unused = totalExports - totalUsed;
      recapRows.push({ label: "Export coverage", result: `${coveragePct}% (${unused} unused export${unused === 1 ? "" : "s"})` });
    }

    if (analysis.communities.length > 0) {
      recapRows.push({ label: "Community detection", result: `${analysis.communities.length} module cluster${analysis.communities.length === 1 ? "" : "s"}` });
    }

    if (analysis.crossCuttingFiles && analysis.crossCuttingFiles.length > 0) {
      recapRows.push({ label: "Cross-cutting", result: `${analysis.crossCuttingFiles.length} file${analysis.crossCuttingFiles.length === 1 ? "" : "s"} span 3+ layers` });
    }

    if (analysis.layerConsistency) {
      const pct = (analysis.layerConsistency.consistency * 100).toFixed(0);
      const vCount = analysis.layerConsistency.violations.length;
      recapRows.push({
        label: "Layer consistency",
        result: vCount === 0
          ? `${pct}% consistent (no violations)`
          : `${pct}% consistent, ${vCount} violation${vCount === 1 ? "" : "s"}`,
      });
    }

    if (analysis.chokepoints && analysis.chokepoints.length > 0) {
      recapRows.push({ label: "Chokepoints", result: `${analysis.chokepoints.length} articulation point${analysis.chokepoints.length === 1 ? "" : "s"}` });
    }

    const maxRecapLabel = Math.max(...recapRows.map((r) => r.label.length));
    for (const row of recapRows) {
      console.log(
        t.muted(`    ${row.label.padEnd(maxRecapLabel)} → ${row.result}`),
      );
    }
  }

  // Findings summary: actionable issues worth fixing
  if (analysis) {
    const findings: string[] = [];

    // Circular dependencies (always a finding)
    if (analysis.circularDeps.length > 0) {
      for (const c of analysis.circularDeps.slice(0, 3)) {
        const names = c.chain.map((f) => f.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? f);
        findings.push(`${analysis.circularDeps.length > 1 ? "" : ""}1 circular dependency chain (${names.slice(0, 2).join(" \u2194 ")})`);
      }
      if (analysis.circularDeps.length > 1) {
        findings[0] = `${analysis.circularDeps.length} circular dependency chain${analysis.circularDeps.length === 1 ? "" : "s"}`;
      }
    }

    // High-instability files (instability > 0.8)
    const highInstabilityFiles = analysis.instabilities.filter((f) => f.instability > 0.8);
    if (highInstabilityFiles.length > 0) {
      findings.push(`${highInstabilityFiles.length} high-instability file${highInstabilityFiles.length === 1 ? "" : "s"}`);
    }

    // Layer violations
    if (analysis.layerConsistency && analysis.layerConsistency.violations.length > 0) {
      findings.push(`${analysis.layerConsistency.violations.length} layer dependency violation${analysis.layerConsistency.violations.length === 1 ? "" : "s"}`);
    }

    // Unused exports
    const ec = analysis.exportCoverage;
    if (ec && ec.length > 0) {
      const totalExports = ec.reduce((sum, e) => sum + e.totalExports, 0);
      const totalUsed = ec.reduce((sum, e) => sum + e.usedExports, 0);
      const unusedExports = totalExports - totalUsed;
      const filesWithUnused = ec.filter((e) => e.usedExports < e.totalExports).length;
      if (unusedExports > 0) {
        findings.push(`${unusedExports} unused export${unusedExports === 1 ? "" : "s"} in ${filesWithUnused} file${filesWithUnused === 1 ? "" : "s"}`);
      }
    }

    console.log("");
    if (findings.length > 0) {
      const findingsHeader = `  \u26A0  ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
      console.log(t.warn(findingsHeader));
      for (const f of findings) {
        console.log(t.muted(`     \u25CF ${f}`));
      }
    } else {
      console.log(t.success(`  \u2713  No structural issues detected`));
    }
  }

  console.log("");
}

/**
 * Estimate how many tokens an AI agent would spend exploring a codebase
 * without any context files.
 *
 * Heuristic: agents typically read 30-50% of source files to understand
 * architecture, plus overhead from search/grep operations.
 */
function estimateExplorationCost(ctx: DetectedContext): number {
  if (ctx.totalSourceBytes === 0 || ctx.sourceFileCount === 0) {
    // Fallback for projects where we couldn't count
    return 15000;
  }

  // Agents typically read ~40% of source files to understand a project
  const bytesRead = ctx.totalSourceBytes * 0.4;
  // Convert to tokens. Source code is typically symbol-heavy (~3.2 chars/token)
  const readTokens = Math.ceil(bytesRead / 3.2);

  // Add overhead for search commands, tool calls, etc (~30% overhead)
  const overhead = Math.ceil(readTokens * 0.3);

  // Minimum floor
  return Math.max(5000, readTokens + overhead);
}

function formatNumber(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
