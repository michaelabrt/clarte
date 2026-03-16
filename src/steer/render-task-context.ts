import type { PersistedGraph } from "../core/types/persisted-graph.js";
import type { SymbolMatch } from "./targets-resolve.js";
import type { ExecutionFlow } from "../mcp/tools/execution-flow.js";
import type { FileRole } from "../core/types.js";

// ── Types for task-scoped data ───────────────────────────────────────────────

export interface TaskScopedInfo {
  /** Task-scoped role per file (only files whose task role differs from global) */
  taskRoles: Map<string, FileRole>;
  /** Task-scoped authority per file */
  taskAuthority: Map<string, number>;
}

// ── Main renderer ────────────────────────────────────────────────────────────

/**
 * Render the task-context.md content from resolved targets and symbol rankings.
 * Pure function: given data, returns the markdown string.
 *
 * Supports optional execution flows (§4.7) and task-scoped rankings (§4.8).
 */
export function renderTaskContext(
  targets: string[],
  runnersUp: string[],
  graph: PersistedGraph,
  symbolRanking: Map<string, SymbolMatch[]>,
  lastModified?: Map<string, string>,
  executionFlows?: ExecutionFlow[],
  taskScoped?: TaskScopedInfo,
): string {
  const fileImporters = new Map<string, string[]>();
  const fileImports = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!fileImporters.has(e.to)) fileImporters.set(e.to, []);
    fileImporters.get(e.to)?.push(e.from);
    if (!fileImports.has(e.from)) fileImports.set(e.from, []);
    fileImports.get(e.from)?.push(e.to);
  }

  const targetSet = new Set(targets);
  const lines: string[] = [
    "# Edit targets (clarte)",
    "",
    "Based on dependency graph analysis, these files are most likely to need editing.",
    "Key symbols are listed so you can navigate directly without a broad search.",
    "",
  ];

  for (let i = 0; i < targets.length; i++) {
    const fp = targets[i];
    const ageSuffix = lastModified?.get(fp) ? `, modified ${lastModified.get(fp)}` : "";
    lines.push(`## ${fp} [rank ${i + 1}${ageSuffix}]`);

    // §4.8: Task-scoped role (only when it differs from global)
    if (taskScoped) {
      const taskRole = taskScoped.taskRoles.get(fp);
      const globalRole = graph.files[fp]?.role;
      if (taskRole && globalRole && taskRole !== globalRole) {
        const taskAuth = taskScoped.taskAuthority.get(fp) ?? 0;
        lines.push(`Global role: ${globalRole} (authority ${(graph.files[fp]?.authority ?? 0).toFixed(2)})`);
        lines.push(`Task role: ${taskRole} (task-authority ${taskAuth.toFixed(2)})`);
      }
    }

    const topSyms = symbolRanking.get(fp) ?? [];
    const intraCalls = graph.files[fp]?.intraFileCalls ?? [];

    // Annotated display with caller/callee chains
    let symParts = topSyms.map((x) => (x.line ? `${x.name} (L${x.line})` : x.name));
    for (const [caller, callee] of intraCalls) {
      const ci = topSyms.findIndex((x) => x.name === caller);
      const di = topSyms.findIndex((x) => x.name === callee);
      if (ci >= 0 && di >= 0) {
        const c = topSyms[ci];
        const d = topSyms[di];
        const chain = `${c.name} (L${c.line}) -> ${d.name} (L${d.line})`;
        const rest = topSyms
          .filter((_, idx) => idx !== ci && idx !== di)
          .map((x) => (x.line ? `${x.name} (L${x.line})` : x.name));
        symParts = [chain, ...rest];
        break;
      }
    }

    if (symParts.length) lines.push(`Key symbols: ${symParts.join(", ")}`);

    // Relationship hints: connections to other target files
    const relatedImporters = (fileImporters.get(fp) ?? []).filter((f) => targetSet.has(f));
    const relatedImports = (fileImports.get(fp) ?? []).filter((f) => targetSet.has(f));
    if (relatedImporters.length) lines.push(`Imported by: ${relatedImporters.join(", ")}`);
    if (relatedImports.length) lines.push(`Imports from: ${relatedImports.join(", ")}`);

    // Test file paths from testMapping
    const tests = graph.testMapping[fp] ?? [];
    if (tests.length) {
      lines.push(`Tests: ${tests.slice(0, 3).join(", ")}`);
      lines.push("When writing tests, update these existing test files rather than creating new ones.");
    }
    lines.push("");
  }

  // §4.7: Execution flows (max 3)
  if (executionFlows && executionFlows.length > 0) {
    for (const flow of executionFlows.slice(0, 3)) {
      const lastStep = flow.steps[flow.steps.length - 1];
      const title = lastStep ? `${flow.entryPoint.symbol} -> ... -> ${lastStep.symbol}` : flow.entryPoint.symbol;
      lines.push(`## Execution flow: ${title}`);

      // Entry point as step 0
      lines.push(`1. ${flow.entryPoint.file}::${flow.entryPoint.symbol} (L${flow.entryPoint.line})`);

      for (let j = 0; j < flow.steps.length; j++) {
        const step = flow.steps[j];
        const editMarker = targetSet.has(step.file) ? "  <- edit target" : "";
        lines.push(`${j + 2}. ${step.file}::${step.symbol} (L${step.line})${editMarker}`);
      }
      lines.push("");
    }
  }

  // Negative guidance: warn about runners-up with same basename as a target (decoys)
  if (runnersUp.length > 0) {
    const targetBasenames = new Set(targets.map((t) => t.split("/").pop()));
    const decoys = runnersUp.filter((r) => targetBasenames.has(r.split("/").pop()));
    if (decoys.length > 0) {
      lines.push("## Do NOT edit these files");
      lines.push("These scored similarly but are in different paths. They are likely not the right target:");
      for (const d of decoys) lines.push(`- ${d}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Render a minimal task-context.md for the git-history fallback path.
 */
export function renderFallbackContext(files: string[], commitMessage: string): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return `# Edit targets (clarte)\n\nBased on past fixes to similar issues, these files are most likely to need editing:\n\n${fileList}\n\nMatched commit: ${commitMessage}\n`;
}
