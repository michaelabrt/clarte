import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Gate B: Compare clarte learn observations between matched condition pairs
//
// Usage:
//   node scripts/gate-b.mjs <results-dir> [--graph-dir=<path>]
//
// Expects paired session logs in results-dir:
//   placebo-1-session.jsonl, clarte-1-session.jsonl
//   placebo-2-session.jsonl, clarte-2-session.jsonl
//   ...
// Or single-run format:
//   placebo-session.jsonl, clarte-session.jsonl
//
// --graph-dir: directory containing .clarte/graph.json (defaults to cwd)

const CLARTE_BIN = path.resolve(import.meta.dirname, "../dist/index.js");

const args = process.argv.slice(2);
const graphDirArg = args.find(a => a.startsWith("--graph-dir="));
const graphDir = graphDirArg ? graphDirArg.split("=")[1] : process.cwd();
const resultsDir = args.find(a => !a.startsWith("--"));
if (!resultsDir) {
  console.error("Usage: node scripts/gate-b.mjs <results-dir> [--graph-dir=<path>]");
  process.exit(1);
}

// Find paired session logs
const files = fs.readdirSync(resultsDir).filter(f => f.endsWith("-session.jsonl"));

// Build pairs: { run: number, placebo: path, clarte: path }
const pairs = [];

// Check numbered format first
for (let i = 1; i <= 50; i++) {
  const placebo = path.join(resultsDir, `placebo-${i}-session.jsonl`);
  const clarte = path.join(resultsDir, `clarte-${i}-session.jsonl`);
  if (fs.existsSync(placebo) && fs.existsSync(clarte)) {
    pairs.push({ run: i, placebo, clarte });
  }
}

// Check single-run format
if (pairs.length === 0) {
  const placebo = path.join(resultsDir, "placebo-session.jsonl");
  const clarte = path.join(resultsDir, "clarte-session.jsonl");
  if (fs.existsSync(placebo) && fs.existsSync(clarte)) {
    pairs.push({ run: 1, placebo, clarte });
  }
}

if (pairs.length === 0) {
  console.error("No matched session log pairs found.");
  console.error("Expected: placebo-N-session.jsonl + clarte-N-session.jsonl");
  console.error(`Files in ${resultsDir}:`, files);
  process.exit(1);
}

console.log(`Found ${pairs.length} matched pair(s)\n`);

function runLearn(logPath) {
  try {
    const out = execSync(
      `node "${CLARTE_BIN}" learn "${logPath}" --format=json 2>/dev/null`,
      { timeout: 15000, encoding: "utf-8", cwd: graphDir }
    );
    return JSON.parse(out);
  } catch {
    return null;
  }
}

const results = [];

for (const pair of pairs) {
  const placeboResult = runLearn(pair.placebo);
  const clarteResult = runLearn(pair.clarte);

  if (!placeboResult || !clarteResult) {
    console.log(`Run ${pair.run}: SKIP (parse failure)`);
    continue;
  }

  const plEdits = placeboResult.editedFiles.length;
  const clEdits = clarteResult.editedFiles.length;
  const plMissed = placeboResult.observations.filter(o => !o.positive && o.type.startsWith("missed-")).length;
  const clMissed = clarteResult.observations.filter(o => !o.positive && o.type.startsWith("missed-")).length;
  const plPositive = placeboResult.observations.filter(o => o.positive).length;
  const clPositive = clarteResult.observations.filter(o => o.positive).length;
  const plTotal = placeboResult.observations.length;
  const clTotal = clarteResult.observations.length;
  const isHeavy = plEdits >= 5 || clEdits >= 5;

  results.push({
    run: pair.run,
    isHeavy,
    placebo: { edits: plEdits, missed: plMissed, positive: plPositive, total: plTotal },
    clarte: { edits: clEdits, missed: clMissed, positive: clPositive, total: clTotal },
  });
}

if (results.length === 0) {
  console.log("No valid pairs to compare.");
  process.exit(1);
}

// Print per-run comparison
console.log("Run  Heavy  | Placebo (edits/missed/pos) | Clarte (edits/missed/pos) | Delta missed");
console.log("-".repeat(90));

for (const r of results) {
  const delta = r.clarte.missed - r.placebo.missed;
  const deltaStr = delta > 0 ? `+${delta}` : `${delta}`;
  console.log(
    `${String(r.run).padStart(3)}  ${r.isHeavy ? "YES  " : "no   "} | ` +
    `${String(r.placebo.edits).padStart(5)}/${String(r.placebo.missed).padStart(6)}/${String(r.placebo.positive).padStart(3)} | ` +
    `${String(r.clarte.edits).padStart(5)}/${String(r.clarte.missed).padStart(6)}/${String(r.clarte.positive).padStart(3)} | ` +
    `${deltaStr.padStart(12)}`
  );
}

// Aggregate: all pairs
const allPlaceboMissed = results.reduce((s, r) => s + r.placebo.missed, 0);
const allClarteMissed = results.reduce((s, r) => s + r.clarte.missed, 0);

// Aggregate: heavy pairs only
const heavy = results.filter(r => r.isHeavy);
const heavyPlaceboMissed = heavy.reduce((s, r) => s + r.placebo.missed, 0);
const heavyClarteMissed = heavy.reduce((s, r) => s + r.clarte.missed, 0);

console.log("\n=== Gate B Summary ===\n");

console.log(`All pairs (${results.length}):`);
console.log(`  Placebo missed: ${allPlaceboMissed}  |  Clarte missed: ${allClarteMissed}`);
if (allPlaceboMissed > 0) {
  const reduction = ((allPlaceboMissed - allClarteMissed) / allPlaceboMissed * 100).toFixed(0);
  console.log(`  Reduction: ${reduction}%`);
}

if (heavy.length > 0) {
  console.log(`\nHeavy pairs only (${heavy.length}, >= 5 edits):`);
  console.log(`  Placebo missed: ${heavyPlaceboMissed}  |  Clarte missed: ${heavyClarteMissed}`);
  if (heavyPlaceboMissed > 0) {
    const reduction = ((heavyPlaceboMissed - heavyClarteMissed) / heavyPlaceboMissed * 100).toFixed(0);
    console.log(`  Reduction: ${reduction}%`);
  }
}

console.log(`\nThreshold: >= 40% reduction in missed-* observations`);
const passAll = allPlaceboMissed > 0 && (allPlaceboMissed - allClarteMissed) / allPlaceboMissed >= 0.4;
const passHeavy = heavyPlaceboMissed > 0 && (heavyPlaceboMissed - heavyClarteMissed) / heavyPlaceboMissed >= 0.4;
console.log(`Result (all): ${passAll ? "PASS" : "FAIL"}`);
if (heavy.length > 0) {
  console.log(`Result (heavy only): ${passHeavy ? "PASS" : "FAIL"}`);
}
