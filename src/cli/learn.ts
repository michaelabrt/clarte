import fs from "node:fs/promises";
import { ClarteError } from "../errors.js";
import { loadPersistedGraph } from "../graph/persist.js";
import { parseSessionLog } from "../analysis/learn-parse.js";
import { buildIdealContextSet } from "../analysis/learn-context.js";
import { detectObservations, extractReadFiles } from "../analysis/learn-observations.js";
import type { LearnResult, Observation, ToolEvent } from "../types/learn.js";

export async function runLearnMode(
  rootDir: string,
  sessionLogPath: string,
  verbose: boolean,
  jsonMode: boolean,
): Promise<LearnResult> {
  // Validate path is a file, not directory
  const stat = await fs.stat(sessionLogPath).catch(() => null);
  if (!stat) {
    throw new ClarteError(`Session log not found: ${sessionLogPath}`);
  }
  if (stat.isDirectory()) {
    throw new ClarteError("Directory mode not supported yet. Provide a single .jsonl file.");
  }

  // Load graph
  const graph = await loadPersistedGraph(rootDir);
  if (!graph) {
    throw new ClarteError("No .clarte/graph.json found. Run `clarte` first to generate the project graph.");
  }

  // Parse session
  const session = await parseSessionLog(sessionLogPath);

  // Extract edited files (Edit or Write)
  const editedFiles = [
    ...new Set(
      session.events
        .filter(
          (e): e is ToolEvent & { relativePath: string } =>
            (e.tool === "Edit" || e.tool === "Write") && !!e.relativePath,
        )
        .map((e) => e.relativePath),
    ),
  ];

  // Early return: no edits
  if (editedFiles.length === 0) {
    const result: LearnResult = {
      version: 1,
      sessionId: session.sessionId,
      slug: session.slug,
      cliVersion: session.cliVersion,
      totalEvents: session.events.length,
      turnCount: session.turnCount,
      editedFiles: [],
      idealContextSize: 0,
      observations: [],
      bySection: {},
      diagnostics: {
        missedIdealFiles: [],
        readFiles: [],
        precision: 0,
        recall: 0,
        skippedLines: session.skippedLines,
      },
    };
    if (!jsonMode) {
      console.log(formatLearnResult(result, verbose));
    }
    return result;
  }

  // Build ideal context set
  const idealSet = buildIdealContextSet(editedFiles, graph);

  // Detect observations
  const observations = detectObservations(session, idealSet, graph);

  // Compute bySection summary
  const bySection: Record<string, { total: number; positive: number; negative: number }> = {};
  for (const obs of observations) {
    if (!bySection[obs.section]) {
      bySection[obs.section] = { total: 0, positive: 0, negative: 0 };
    }
    bySection[obs.section].total++;
    if (obs.positive) {
      bySection[obs.section].positive++;
    } else {
      bySection[obs.section].negative++;
    }
  }

  // Compute diagnostics (use same read logic as observations, including Bash cat/head/tail)
  const readFiles = [...extractReadFiles(session.events)];
  const readFileSet = new Set(readFiles);
  const idealFiles = [...idealSet.keys()];
  const missedIdealFiles = idealFiles.filter((f) => !readFileSet.has(f));
  const idealFileSet = new Set(idealFiles);
  const readsInIdeal = readFiles.filter((f) => idealFileSet.has(f)).length;
  const precision = readFiles.length > 0 ? readsInIdeal / readFiles.length : 0;
  const recall = idealFiles.length > 0 ? (idealFiles.length - missedIdealFiles.length) / idealFiles.length : 0;

  const result: LearnResult = {
    version: 1,
    sessionId: session.sessionId,
    slug: session.slug,
    cliVersion: session.cliVersion,
    totalEvents: session.events.length,
    turnCount: session.turnCount,
    editedFiles,
    idealContextSize: idealSet.size,
    observations,
    bySection,
    diagnostics: {
      missedIdealFiles,
      readFiles,
      precision,
      recall,
      skippedLines: session.skippedLines,
    },
  };

  if (!jsonMode) {
    console.log(formatLearnResult(result, verbose));
  }

  return result;
}

export function formatLearnResult(result: LearnResult, verbose: boolean): string {
  const lines: string[] = [];

  const displayName = result.slug ?? result.sessionId.slice(0, 8);
  lines.push(`Session: ${displayName} (CLI ${result.cliVersion})`);
  lines.push(`Events: ${result.totalEvents} tool calls across ${result.turnCount} turns`);

  if (result.editedFiles.length === 0) {
    lines.push("");
    lines.push("No edits found in session - nothing to analyze.");
    return lines.join("\n");
  }

  lines.push(`Edited: ${result.editedFiles.length} files  |  Ideal context: ${result.idealContextSize} files`);

  if (result.observations.length === 0) {
    lines.push("");
    lines.push("No observations - agent's file access aligned with the project graph.");
    if (verbose) {
      appendDiagnostics(lines, result);
    }
    return lines.join("\n");
  }

  const positiveCount = result.observations.filter((o) => o.positive).length;
  const negativeCount = result.observations.length - positiveCount;
  lines.push("");
  lines.push(`Observations (${negativeCount} findings, ${positiveCount} positive):`);

  // Group by type
  const byType = new Map<string, Observation[]>();
  for (const obs of result.observations) {
    const list = byType.get(obs.type) ?? [];
    list.push(obs);
    byType.set(obs.type, list);
  }

  for (const [type, observations] of byType) {
    const section = observations[0].section;
    const isPositive = observations[0].positive;
    lines.push("");
    lines.push(`  ${type}${isPositive ? " [positive]" : ""} (${section})`);
    for (const obs of observations) {
      lines.push(`    ${obs.detail}`);
    }
  }

  // Section summary
  lines.push("");
  lines.push("By section:");
  for (const [section, counts] of Object.entries(result.bySection)) {
    const parts: string[] = [];
    if (counts.negative > 0) parts.push(`${counts.negative} missed`);
    if (counts.positive > 0) parts.push(`${counts.positive} positive`);
    const detail = parts.length > 0 ? ` (${parts.join(", ")})` : "";
    lines.push(`  ${section.padEnd(20)}${counts.total} observation${counts.total !== 1 ? "s" : ""}${detail}`);
  }

  if (verbose) {
    appendDiagnostics(lines, result);
  }

  return lines.join("\n");
}

function appendDiagnostics(lines: string[], result: LearnResult): void {
  lines.push("");
  lines.push("Diagnostics (ideal set is approximate; precision ignores read frequency):");
  lines.push(`  Precision: ${(result.diagnostics.precision * 100).toFixed(1)}%`);
  lines.push(`  Recall: ${(result.diagnostics.recall * 100).toFixed(1)}%`);
  lines.push(`  Missed ideal files: ${result.diagnostics.missedIdealFiles.length}`);
  lines.push(`  Unique files read: ${result.diagnostics.readFiles.length}`);
  if (result.diagnostics.skippedLines > 0) {
    lines.push(`  Skipped lines: ${result.diagnostics.skippedLines}`);
  }
}
