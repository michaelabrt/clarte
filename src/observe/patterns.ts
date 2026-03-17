import type { ClassifiedTurn } from "./classify";

/** A detected waste pattern in a session */
export interface WastePattern {
  type: "test-rerun" | "verification-reread" | "exploration-scatter" | "summary-bloat";
  /** Turn indices involved */
  turns: number[];
  /** Estimated wasted cost (dollars) */
  wastedCost: number;
  /** Human-readable description */
  description: string;
}

/** Regex matching common test runner commands */
const TEST_CMD_RE =
  /\b(npm\s+test|npm\s+run\s+test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+(run\s+)?test|npx\s+(vitest|jest|mocha)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test)\b/;

/**
 * Detect test-rerun loops: same base test command run multiple times
 * in the tail phase with no edits in between.
 *
 * Most tail waste comes from test output parsing loops where the agent
 * re-runs tests with different formatters to parse the same result.
 */
export function detectTestReruns(turns: ClassifiedTurn[]): WastePattern[] {
  const patterns: WastePattern[] = [];
  const tailTurns = turns.filter((t) => t.phase === "tail");

  let streak: ClassifiedTurn[] = [];

  for (const turn of tailTurns) {
    const hasTest = turn.tools.some((t) => {
      if (t.name !== "Bash") return false;
      const cmd = (t.input?.command as string) ?? "";
      return TEST_CMD_RE.test(cmd);
    });

    if (hasTest) {
      streak.push(turn);
    } else if (streak.length >= 2) {
      // Streak broken, record if >= 2 consecutive test runs
      const wastedTurns = streak.slice(1); // first run is legitimate
      patterns.push({
        type: "test-rerun",
        turns: wastedTurns.map((t) => t.index),
        wastedCost: wastedTurns.reduce((sum, t) => sum + estimateTurnCost(t), 0),
        description: `${streak.length} consecutive test runs in tail (${wastedTurns.length} wasted)`,
      });
      streak = [];
    } else {
      streak = [];
    }
  }

  // Flush trailing streak
  if (streak.length >= 2) {
    const wastedTurns = streak.slice(1);
    patterns.push({
      type: "test-rerun",
      turns: wastedTurns.map((t) => t.index),
      wastedCost: wastedTurns.reduce((sum, t) => sum + estimateTurnCost(t), 0),
      description: `${streak.length} consecutive test runs in tail (${wastedTurns.length} wasted)`,
    });
  }

  return patterns;
}

/**
 * Detect verification re-reads: files read in the tail phase that were
 * already read earlier and not modified since.
 */
export function detectVerificationRereads(turns: ClassifiedTurn[]): WastePattern[] {
  const patterns: WastePattern[] = [];

  // Track which files were read and edited
  const readFiles = new Set<string>();
  const editedFiles = new Set<string>();

  for (const turn of turns) {
    if (turn.phase === "tail") {
      const rereadPaths = turn.filePaths.filter((p) => readFiles.has(p) && !editedFiles.has(p));
      if (rereadPaths.length > 0) {
        patterns.push({
          type: "verification-reread",
          turns: [turn.index],
          wastedCost: estimateTurnCost(turn),
          description: `Re-read ${rereadPaths.length} unchanged file(s) in tail: ${rereadPaths.slice(0, 3).join(", ")}`,
        });
      }
    }

    // Track reads and edits
    for (const tool of turn.tools) {
      if (tool.name === "Read" || tool.name === "Grep" || tool.name === "Glob") {
        for (const p of turn.filePaths) readFiles.add(p);
      }
      if (tool.name === "Edit" || tool.name === "Write") {
        for (const p of turn.filePaths) editedFiles.add(p);
      }
    }
  }

  return patterns;
}

/**
 * Detect summary bloat: text-only turns at the end with no tool calls.
 * These are often the agent summarizing what it did.
 */
export function detectSummaryBloat(turns: ClassifiedTurn[]): WastePattern[] {
  const tailTurns = turns.filter((t) => t.phase === "tail");
  const summaryTurns = tailTurns.filter((t) => t.tools.length === 0 && t.outputTokens > 0);

  if (summaryTurns.length === 0) return [];

  return [
    {
      type: "summary-bloat",
      turns: summaryTurns.map((t) => t.index),
      wastedCost: summaryTurns.reduce((sum, t) => sum + estimateTurnCost(t), 0),
      description: `${summaryTurns.length} text-only summary turn(s) in tail`,
    },
  ];
}

/** Run all pattern detectors */
export function detectAllPatterns(turns: ClassifiedTurn[]): WastePattern[] {
  return [...detectTestReruns(turns), ...detectVerificationRereads(turns), ...detectSummaryBloat(turns)];
}

/**
 * Estimate the cost of a single turn in dollars.
 * Uses Sonnet 4.6 pricing: $3/M input, $15/M output.
 * Cache reads at $0.30/M (90% discount).
 */
export function estimateTurnCost(turn: ClassifiedTurn): number {
  const inputCost = ((turn.inputTokens + turn.cacheCreationTokens) * 3) / 1_000_000;
  const cacheCost = (turn.cacheReadTokens * 0.3) / 1_000_000;
  const outputCost = (turn.outputTokens * 15) / 1_000_000;
  return inputCost + cacheCost + outputCost;
}
