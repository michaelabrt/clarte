import type { ClassifiedTurn } from "./classify";
import type { WastePattern } from "./patterns";
import { estimateTurnCost } from "./patterns";

/** Metrics for a single session */
export interface SessionMetrics {
  /** Total number of turns */
  totalTurns: number;
  /** Turns per phase */
  exploreTurns: number;
  editTurns: number;
  tailTurns: number;
  /** Phase percentages */
  explorePercent: number;
  editPercent: number;
  tailPercent: number;
  /** First edit turn index (the R18 predictor) */
  firstEditTurn: number | null;
  /** Total cost estimate (dollars) */
  totalCost: number;
  /** Cost per phase */
  exploreCost: number;
  editCost: number;
  tailCost: number;
  /** Files read vs files edited */
  filesRead: number;
  filesEdited: number;
  readEditRatio: number;
  /** Unique tool usage counts */
  toolCounts: Record<string, number>;
  /** Detected waste patterns */
  patterns: WastePattern[];
  /** Total estimated waste (dollars) */
  totalWaste: number;
  /** Session duration in seconds */
  durationSeconds: number;
}

/**
 * Compute metrics from classified turns and detected patterns.
 */
export function computeMetrics(
  turns: ClassifiedTurn[],
  patterns: WastePattern[],
  startedAt: string,
  endedAt: string,
): SessionMetrics {
  const exploreTurns = turns.filter((t) => t.phase === "explore");
  const editTurns = turns.filter((t) => t.phase === "edit");
  const tailTurns = turns.filter((t) => t.phase === "tail");

  const total = turns.length || 1; // avoid division by zero

  const firstEditTurn = turns.find((t) => t.phase === "edit")?.index ?? null;

  const phaseCost = (phaseTurns: ClassifiedTurn[]) => phaseTurns.reduce((sum, t) => sum + estimateTurnCost(t), 0);

  // Track unique files read and edited
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();
  const toolCounts: Record<string, number> = {};

  for (const turn of turns) {
    for (const tool of turn.tools) {
      toolCounts[tool.name] = (toolCounts[tool.name] ?? 0) + 1;
      if (tool.name === "Read" || tool.name === "Grep" || tool.name === "Glob") {
        for (const p of turn.filePaths) readFiles.add(p);
      }
      if (tool.name === "Edit" || tool.name === "Write") {
        for (const p of turn.filePaths) editedFiles.add(p);
      }
    }
  }

  const exploreCost = phaseCost(exploreTurns);
  const editCost = phaseCost(editTurns);
  const tailCost = phaseCost(tailTurns);
  const totalCost = exploreCost + editCost + tailCost;
  const totalWaste = patterns.reduce((sum, p) => sum + p.wastedCost, 0);

  let durationSeconds = 0;
  if (startedAt && endedAt) {
    durationSeconds = (new Date(endedAt).getTime() - new Date(startedAt).getTime()) / 1000;
  }

  return {
    totalTurns: turns.length,
    exploreTurns: exploreTurns.length,
    editTurns: editTurns.length,
    tailTurns: tailTurns.length,
    explorePercent: Math.round((exploreTurns.length / total) * 100),
    editPercent: Math.round((editTurns.length / total) * 100),
    tailPercent: Math.round((tailTurns.length / total) * 100),
    firstEditTurn,
    totalCost,
    exploreCost,
    editCost,
    tailCost,
    filesRead: readFiles.size,
    filesEdited: editedFiles.size,
    readEditRatio: editedFiles.size > 0 ? Math.round((readFiles.size / editedFiles.size) * 10) / 10 : 0,
    toolCounts,
    patterns,
    totalWaste,
    durationSeconds,
  };
}
