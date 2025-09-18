import pc from "picocolors";
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
  console.log(pc.bold("  Files created:"));
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
      console.log(`${row.indent}${pc.cyan(row.name)}`);
    } else {
      const status = row.isUpdated ? pc.yellow("(updated)") : pc.green("(new)");
      const paddedName = row.name.padEnd(maxNameCol - row.indent.length);
      console.log(
        `${row.indent}${pc.cyan(paddedName)}  ${row.size.padStart(maxSizeWidth)}  ${pc.dim(row.tokens.padEnd(maxTokenWidth))}  ${status}`,
      );
    }
  }

  console.log("");
  console.log(
    pc.dim(
      `    Total: ${formatBytes(totalBytes)}, ~${formatNumber(totalTokens)} tokens`,
    ),
  );

  if (snapshot?.budgetExcluded && snapshot.budgetExcluded > 0) {
    console.log(
      pc.dim(
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
        pc.dim(`    Includes: ${parts.join(", ")}`),
      );
    }
  }

  // -- Token estimate comparison --
  console.log("");
  console.log(pc.bold("  Estimated context cost per conversation:"));
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

  // Build cost rows for dynamic alignment
  const costRows: Array<{ label: string; desc: string; value: string }> = [
    { label: "Always loaded", desc: "main context + global rule", value: `~${formatNumber(alwaysOnTokens)} tokens` },
  ];

  if (avgScopedTokens > 0) {
    costRows.push({ label: "Per-task (avg)", desc: "1 scoped rule", value: `~${formatNumber(avgScopedTokens)} tokens` });
  }

  costRows.push({ label: "Exploration", desc: "mostly eliminated", value: `~${formatNumber(residualExploration)} tokens` });

  const maxCostLabel = Math.max(...costRows.map((r) => r.label.length));
  const maxCostDesc = Math.max(...costRows.map((r) => r.desc.length));
  const maxCostValue = Math.max(...costRows.map((r) => r.value.length));
  const afterContentWidth = maxCostLabel + 3 + maxCostDesc + 2 + maxCostValue;

  // "Before" section — right-align value with After's value column
  const beforeValue = `~${formatNumber(explorationTokens)} tokens`;
  const beforeLabel = "Exploration to understand codebase";
  const beforeGap = afterContentWidth - beforeLabel.length - beforeValue.length;

  console.log(pc.dim("    Before (no context files):"));
  if (beforeGap >= 2) {
    console.log(
      `      ${beforeLabel}${" ".repeat(beforeGap)}${pc.red(beforeValue)}`,
    );
  } else {
    console.log(
      `      ${beforeLabel}  ${pc.red(beforeValue)}`,
    );
  }
  console.log("");

  // "After" section
  console.log(pc.dim("    After:"));
  for (const row of costRows) {
    console.log(
      `      ${row.label.padEnd(maxCostLabel)}   ${row.desc.padEnd(maxCostDesc)}  ${pc.green(row.value.padStart(maxCostValue))}`,
    );
  }

  const totalText = `Total: ~${formatNumber(afterTotal)} tokens`;
  const totalPad = afterContentWidth > totalText.length
    ? " ".repeat(afterContentWidth - totalText.length)
    : "";
  console.log(
    `      ${totalPad}${pc.bold(totalText)}`,
  );

  console.log("");

  if (savings > 0) {
    console.log(
      pc.green(
        `    Estimated savings: ~${savings}% fewer tokens before real work begins`,
      ),
    );
  }

  // "What we analyzed" recap
  if (analysis) {
    console.log("");
    console.log(pc.bold("  What we analyzed:"));

    const recapRows: Array<{ label: string; result: string }> = [];

    if (analysis.hubFiles.length > 0) {
      recapRows.push({ label: "PageRank hub detection", result: `found ${analysis.hubFiles.length} key architectural files` });
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

    const maxRecapLabel = Math.max(...recapRows.map((r) => r.label.length));
    for (const row of recapRows) {
      console.log(
        pc.dim(`    ${row.label.padEnd(maxRecapLabel)} → ${row.result}`),
      );
    }
  }

  // Export coverage summary
  const exportCoverage = analysis?.exportCoverage;
  if (exportCoverage && exportCoverage.length > 0) {
    const totalExports = exportCoverage.reduce((sum, e) => sum + e.totalExports, 0);
    const totalUsed = exportCoverage.reduce((sum, e) => sum + e.usedExports, 0);
    const unusedExports = totalExports - totalUsed;
    const coveragePct = totalExports > 0 ? Math.round((totalUsed / totalExports) * 100) : 100;
    const filesWithUnused = exportCoverage.filter((e) => e.usedExports < e.totalExports).length;

    if (unusedExports > 0) {
      console.log("");
      console.log(
        pc.dim(
          `    Export coverage: ${coveragePct}% of exports are used (${unusedExports} unused exports in ${filesWithUnused} file${filesWithUnused === 1 ? "" : "s"})`,
        ),
      );
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
  // Convert to tokens — source code is typically symbol-heavy (~3.2 chars/token)
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
