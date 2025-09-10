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

  // Print main files
  for (const file of mainFiles) {
    const bytes = Buffer.byteLength(file.content, "utf-8");
    const tokens = estimateTokens(file.content);
    totalBytes += bytes;
    totalTokens += tokens;
    alwaysOnTokens += tokens;

    const status = file.existed ? pc.yellow("(updated)") : pc.green("(new)");
    console.log(
      `    ${pc.cyan(file.path.padEnd(28))} ${formatBytes(bytes).padStart(8)}  ${pc.dim(`(~${formatNumber(tokens)} tokens)`)}  ${status}`,
    );
  }

  // Print rule files grouped
  if (ruleFiles.length > 0) {
    console.log(`    ${pc.cyan(".cursor/rules/")}`);

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

      const status = file.existed ? pc.yellow("(updated)") : pc.green("(new)");
      console.log(
        `      ${pc.cyan(filename.padEnd(26))} ${formatBytes(bytes).padStart(8)}  ${pc.dim(`(~${formatNumber(tokens)} tokens)`)}  ${status}`,
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

  console.log(pc.dim("    Before (no context files):"));
  console.log(
    `      Exploration to understand codebase    ${pc.red(`~${formatNumber(explorationTokens)} tokens`)}`,
  );
  console.log("");

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

  console.log(pc.dim("    After:"));
  console.log(
    `      Always loaded    main context + global rule  ${pc.green(`~${formatNumber(alwaysOnTokens)} tokens`)}`,
  );

  if (avgScopedTokens > 0) {
    console.log(
      `      Per-task (avg)   1 scoped rule               ${pc.green(`~${formatNumber(avgScopedTokens)} tokens`)}`,
    );
  }

  console.log(
    `      Exploration      mostly eliminated            ${pc.green(`~${formatNumber(residualExploration)} tokens`)}`,
  );

  console.log(
    `                                            ${pc.bold(`Total: ~${formatNumber(afterTotal)} tokens`)}`,
  );

  console.log("");

  if (savings > 0) {
    console.log(
      pc.green(
        `    Estimated savings: ~${savings}% fewer tokens before real work begins`,
      ),
    );
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
