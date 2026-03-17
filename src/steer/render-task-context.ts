import type { PersistedGraph } from "../core/types/persisted-graph";
import type { SymbolMatch } from "./targets-resolve";
import type { ExecutionFlow } from "../mcp/tools/execution-flow";
import type { FileRole } from "../core/types";
import type { IntentPrediction } from "../core/config/intent-constants";
import type { ContextSelection } from "./context-pruning";

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
 * Supports two modes via discriminated union:
 * - Legacy mode: targets is string[] (file paths)
 * - Intent mode: targets is IntentPrediction[] (full prediction objects)
 *
 * Supports optional execution flows (§4.7), task-scoped rankings (§4.8)
 * and context selection (§4.2 v2).
 */
export function renderTaskContext(
  targets: string[] | IntentPrediction[],
  runnersUp: string[],
  graph: PersistedGraph,
  symbolRanking: Map<string, SymbolMatch[]>,
  lastModified?: Map<string, string>,
  executionFlows?: ExecutionFlow[],
  taskScoped?: TaskScopedInfo,
  contextSelection?: ContextSelection,
): string {
  // Intent mode: discriminate by checking first element type
  if (targets.length > 0 && typeof targets[0] !== "string") {
    return renderIntentMode(targets as IntentPrediction[], runnersUp, graph, contextSelection);
  }

  const stringTargets = targets as string[];
  return renderLegacyMode(stringTargets, runnersUp, graph, symbolRanking, lastModified, executionFlows, taskScoped);
}

// ── Intent mode renderer (v2) ───────────────────────────────────────────────

function renderIntentMode(
  predictions: IntentPrediction[],
  runnersUp: string[],
  graph: PersistedGraph,
  _contextSelection?: ContextSelection,
): string {
  const fileImporters = new Map<string, string[]>();
  const fileImports = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!fileImporters.has(e.to)) fileImporters.set(e.to, []);
    fileImporters.get(e.to)?.push(e.from);
    if (!fileImports.has(e.from)) fileImports.set(e.from, []);
    fileImports.get(e.from)?.push(e.to);
  }

  const targetFiles = new Set(predictions.map((p) => p.file));
  const lines: string[] = [
    "# Edit targets (clarte)",
    "",
    "Based on dependency graph analysis, these files are most likely to need editing.",
    "Key symbols are listed so you can navigate directly without a broad search.",
    "",
  ];

  for (const pred of predictions) {
    const conf = pred.confidence === "high" ? "high confidence" : "medium confidence";
    lines.push(`### ${pred.rank}. ${pred.file} (score: ${pred.score.toFixed(3)}, ${conf})`);
    lines.push("");

    if (pred.confidence === "high") {
      lines.push("Edit this file. Start here.");
    } else {
      lines.push("Likely relevant. Check after primary targets.");
    }
    lines.push("");

    // Key symbols (from context pruning selection or fallback)
    if (pred.symbols.length > 0) {
      lines.push("**Key symbols:**");
      for (const sym of pred.symbols) {
        lines.push(`- \`${sym.name}\` (line ${sym.line})`);
      }
      lines.push("");
    }

    // Theory of Impact
    const hasEvidence =
      pred.theory.lexical_evidence ||
      pred.theory.graph_path ||
      pred.theory.temporal_pair ||
      pred.theory.betweenness_rank !== null;
    if (hasEvidence) {
      lines.push("**Why this file:**");
      if (pred.theory.lexical_evidence) lines.push(`- Lexical: ${pred.theory.lexical_evidence}`);
      if (pred.theory.graph_path) lines.push(`- Graph: ${pred.theory.graph_path}`);
      if (pred.theory.temporal_pair) lines.push(`- Temporal: ${pred.theory.temporal_pair}`);
      if (pred.theory.betweenness_rank !== null)
        lines.push(`- Betweenness: ${(pred.theory.betweenness_rank * 100).toFixed(0)}th percentile`);
      lines.push("");
    }

    // Relationships within target set
    const relatedImporters = (fileImporters.get(pred.file) ?? []).filter((f) => targetFiles.has(f));
    const relatedImports = (fileImports.get(pred.file) ?? []).filter((f) => targetFiles.has(f));
    if (relatedImporters.length || relatedImports.length) {
      lines.push("**Relationships within target set:**");
      if (relatedImporters.length) lines.push(`- Imported by ${relatedImporters.join(", ")}`);
      if (relatedImports.length) lines.push(`- Imports from ${relatedImports.join(", ")}`);
      lines.push("");
    }

    // Test files
    const tests = graph.testMapping[pred.file] ?? [];
    if (tests.length) {
      lines.push(`Tests: ${tests.slice(0, 3).join(", ")}`);
      lines.push("When writing tests, update these existing test files rather than creating new ones.");
      lines.push("");
    }

    // Staleness warning
    if (pred.isStale) {
      lines.push("**Warning:** This file has been modified since the graph was built. Prediction may be stale.");
      lines.push("");
    }
  }

  // Negative guidance
  if (runnersUp.length > 0) {
    const targetBasenames = new Set(predictions.map((p) => p.file.split("/").pop()));
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

// ── Legacy mode renderer ────────────────────────────────────────────────────

function renderLegacyMode(
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
