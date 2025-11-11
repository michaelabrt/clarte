import { theme as t } from "./theme.js";
import type { CodeSnapshot, ContextAnalysis, GeneratedFile } from "./types.js";
import { estimateTokens, formatBytes } from "./utils.js";
import { INSTABILITY_THRESHOLD } from "./graph.js";

/**
 * Print a summary of generated files with token estimates.
 */
export function printSummary(
  files: GeneratedFile[],
  snapshot?: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  firstRun?: boolean,
): void {
  if (files.length === 0) return;

  console.log("");
  console.log(t.brandBold("  Files created:"));
  console.log("");

  // Track totals
  let totalBytes = 0;
  let totalTokens = 0;

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

  // Print aligned rows (muted -- this is a receipt, not the main event)
  for (const row of fileRows) {
    if (row.isHeader) {
      console.log(`${row.indent}${t.muted(row.name)}`);
    } else {
      const status = row.isUpdated ? t.muted("(updated)") : t.success("(new)");
      const paddedName = row.name.padEnd(maxNameCol - row.indent.length);
      console.log(
        `${row.indent}${t.muted(paddedName)}  ${row.size.padStart(maxSizeWidth)}  ${t.muted(row.tokens.padEnd(maxTokenWidth))}  ${status}`,
      );
    }
  }

  console.log("");
  console.log(
    `    ${t.muted("Total:")} ${t.textBold(formatBytes(totalBytes))}${t.muted(",")} ${t.textBold(`~${formatNumber(totalTokens)}`)} ${t.muted("tokens")}`,
  );

  if (snapshot?.budgetExcluded && snapshot.budgetExcluded > 0) {
    console.log(
      t.muted(
        `    (${snapshot.budgetExcluded} snapshot entries excluded by token budget)`,
      ),
    );
  }

  // Findings summary: actionable issues worth fixing
  if (analysis) {
    const findings: string[] = [];

    // Circular dependencies (always a finding)
    if (analysis.circularDeps.length > 0) {
      for (const c of analysis.circularDeps.slice(0, 3)) {
        const names = c.chain.map((f) => f.split("/").pop()?.replace(/\.[jt]sx?$/, "") ?? f);
        findings.push(`${analysis.circularDeps.length > 1 ? "" : ""}${t.textBold("1")} circular dependency chain (${names.slice(0, 2).join(" \u2194 ")})`);
      }
      if (analysis.circularDeps.length > 1) {
        findings[0] = `${t.textBold(String(analysis.circularDeps.length))} circular dependency chain${analysis.circularDeps.length === 1 ? "" : "s"}`;
      }
    }

    // High-instability files
    const highInstabilityFiles = analysis.instabilities.filter((f) => f.instability > INSTABILITY_THRESHOLD);
    if (highInstabilityFiles.length > 0) {
      highInstabilityFiles.sort((a, b) => b.instability - a.instability);
      const cap = 10;
      const shown = highInstabilityFiles.slice(0, cap);
      const subLines = shown.map((f) => `       ${f.path.split("/").pop() ?? f.path} I=${t.textBold(f.instability.toFixed(2))}`);
      if (highInstabilityFiles.length > cap) {
        subLines.push(`       ... and ${highInstabilityFiles.length - cap} more`);
      }
      findings.push(`${t.textBold(String(highInstabilityFiles.length))} high-instability file${highInstabilityFiles.length === 1 ? "" : "s"}\n${subLines.join("\n")}`);
    }

    // Layer violations
    if (analysis.layerConsistency && analysis.layerConsistency.violations.length > 0) {
      findings.push(`${t.textBold(String(analysis.layerConsistency.violations.length))} layer dependency violation${analysis.layerConsistency.violations.length === 1 ? "" : "s"}`);
    }

    console.log("");
    if (findings.length > 0) {
      const findingsHeader = `  \u26A0  ${findings.length} finding${findings.length === 1 ? "" : "s"}`;
      console.log(t.warn(findingsHeader));
      for (const f of findings) {
        console.log(t.text(`     \u25CF ${f}`));
      }
    } else {
      console.log(t.success(`  \u2713  No structural issues detected`));
    }
  }

  if (firstRun) {
    console.log("");
    console.log(
      t.muted(
        ` In benchmarks, Clart\u00e9 reduced agent input tokens by 60% and cost by 58%.\n https://github.com/michaelabrt/clarte-benchmark`,
      ),
    );
  }

  console.log("");
}


function formatNumber(n: number): string {
  if (n >= 1000) {
    return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(n);
}
