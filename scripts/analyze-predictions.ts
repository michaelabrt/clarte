/**
 * Analyze prediction feedback data from .clarte/hooks/.state/prediction-log.jsonl.
 * Computes aggregate precision/recall and correlates with session turn counts.
 *
 * Usage: npx tsx scripts/analyze-predictions.ts [path-to-project]
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

const projectDir = process.argv[2] || ".";
const logPath = resolve(projectDir, ".clarte/hooks/.state/prediction-log.jsonl");

if (!existsSync(logPath)) {
  console.error(`No prediction log found at ${logPath}`);
  process.exit(1);
}

interface PredictionEntry {
  timestamp: string;
  query: string;
  predicted: string[];
  edited: string[];
  hits: string[];
  precision: number;
  recall: number;
}

const entries: PredictionEntry[] = readFileSync(logPath, "utf-8")
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

if (entries.length === 0) {
  console.log("No prediction entries found.");
  process.exit(0);
}

// Aggregate metrics
const avgPrecision = entries.reduce((s, e) => s + e.precision, 0) / entries.length;
const avgRecall = entries.reduce((s, e) => s + e.recall, 0) / entries.length;
const hitRate = entries.filter((e) => e.hits.length > 0).length / entries.length;

console.log(`Prediction Analysis (${entries.length} sessions)`);
console.log(`  Avg Precision@5: ${(avgPrecision * 100).toFixed(1)}%`);
console.log(`  Avg Recall@5:    ${(avgRecall * 100).toFixed(1)}%`);
console.log(`  Hit rate:        ${(hitRate * 100).toFixed(1)}% (at least one correct target)`);
console.log();

// Per-month trend
const byMonth = new Map<string, PredictionEntry[]>();
for (const e of entries) {
  const month = e.timestamp.slice(0, 7);
  if (!byMonth.has(month)) byMonth.set(month, []);
  byMonth.get(month)!.push(e);
}

console.log("Monthly trend:");
for (const [month, monthEntries] of [...byMonth.entries()].sort()) {
  const p = monthEntries.reduce((s, e) => s + e.precision, 0) / monthEntries.length;
  const r = monthEntries.reduce((s, e) => s + e.recall, 0) / monthEntries.length;
  console.log(`  ${month}: P=${(p * 100).toFixed(0)}% R=${(r * 100).toFixed(0)}% (n=${monthEntries.length})`);
}
