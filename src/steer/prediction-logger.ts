/**
 * PredictionTrace logger.
 *
 * Writes structured prediction traces to .clarte/prediction-log.jsonl.
 * Supports log rotation at 1MB and feedback append (precision/recall/MRR).
 *
 * When DEBUG_INTENT=1, outputs a human-readable 4-phase execution
 * breakdown to stderr for debugging missed symbols.
 */

import { appendFileSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { mkdirSync } from "node:fs";
import type { PredictionTrace } from "../core/config/intent-constants";
import type { IntentPredictResult } from "./intent-predict";

const LOG_FILE = "prediction-log.jsonl";
const MAX_LOG_SIZE = 1_000_000; // 1MB

// ── Query hash ───────────────────────────────────────────────────────────────

function hashQuery(query: string): string {
  const normalized = query.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

// ── Main logger ──────────────────────────────────────────────────────────────

/**
 * Write a structured prediction trace to .clarte/prediction-log.jsonl.
 * Creates the directory and file if they don't exist.
 * Rotates the log when it exceeds 1MB.
 */
export function logPredictionTrace(
  rootDir: string,
  result: IntentPredictResult,
  query: string,
  graphCommit: string,
): void {
  const dir = join(rootDir, ".clarte");
  const logPath = join(dir, LOG_FILE);

  const trace: PredictionTrace = {
    timestamp: new Date().toISOString(),
    query_hash: hashQuery(query),
    graph_commit: graphCommit,
    timing_ms: result.timing,
    seeds: result.seeds,
    predictions: result.predictions,
    suppressed: result.suppressed,
    context: {
      budget_tokens: result.contextSelection.tokenBudgetUsed + (1500 - result.contextSelection.tokenBudgetUsed),
      used_tokens: result.contextSelection.tokenBudgetUsed,
      symbols_selected: result.contextSelection.selectedSymbols.length,
      symbols_available: 0, // filled by caller if needed
      marginal_gain_at_stop: result.contextSelection.marginalGainAtStop,
    },
  };

  try {
    mkdirSync(dir, { recursive: true });

    // Rotate if over 1MB
    try {
      const stats = statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        renameSync(logPath, logPath.replace(".jsonl", ".jsonl.1"));
      }
    } catch {
      // File doesn't exist yet, that's fine
    }

    appendFileSync(logPath, JSON.stringify(trace) + "\n");
  } catch {
    // Logging is best-effort; never crash the pipeline
  }
}

// ── Feedback append ──────────────────────────────────────────────────────────

/**
 * Append precision/recall/MRR feedback to the most recent matching trace entry.
 * Reads the last line, checks query_hash, computes metrics, rewrites the line.
 */
export function appendFeedback(rootDir: string, queryHash: string, editedFiles: string[]): void {
  const logPath = join(rootDir, ".clarte", LOG_FILE);

  try {
    const content = readFileSync(logPath, "utf-8");
    const lines = content.trimEnd().split("\n");
    if (lines.length === 0) return;

    const lastLine = lines[lines.length - 1];
    const trace = JSON.parse(lastLine) as PredictionTrace;
    if (trace.query_hash !== queryHash) return;

    const predicted = trace.predictions.map((p) => p.file);
    const editedSet = new Set(editedFiles);
    const predictedSet = new Set(predicted);

    const hits = predicted.filter((f) => editedSet.has(f));
    const precision = predictedSet.size > 0 ? hits.length / predictedSet.size : 0;
    const recall = editedSet.size > 0 ? hits.length / editedSet.size : 0;

    // MRR: 1 / (rank of first correct prediction)
    let mrr = 0;
    for (let i = 0; i < predicted.length; i++) {
      if (editedSet.has(predicted[i])) {
        mrr = 1 / (i + 1);
        break;
      }
    }

    trace.feedback = {
      precision: Math.round(precision * 1000) / 1000,
      recall: Math.round(recall * 1000) / 1000,
      mrr: Math.round(mrr * 1000) / 1000,
      edited_files: editedFiles,
    };

    lines[lines.length - 1] = JSON.stringify(trace);
    writeFileSync(logPath, lines.join("\n") + "\n");
  } catch {
    // Best-effort
  }
}

// ── DEBUG_INTENT stderr output ───────────────────────────────────────────────

const DEBUG = !!process.env.DEBUG_INTENT;

export function debugIntent(msg: string): void {
  if (DEBUG) process.stderr.write(`[intent] ${msg}\n`);
}
