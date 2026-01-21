import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const dir = path.join(os.homedir(), ".claude/projects/-home-micha-developer-projects-clarte");
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
  .filter(f => f.size > 50000)
  .sort((a, b) => b.size - a.size)
  .slice(0, 30);

const results = [];
for (const f of files) {
  try {
    const out = execSync(
      `node dist/index.js learn "${path.join(dir, f.name)}" --format=json 2>/dev/null`,
      { timeout: 10000, encoding: "utf-8" }
    );
    const r = JSON.parse(out);
    if (r.editedFiles.length === 0) continue;

    const missedObs = r.observations.filter(o => !o.positive && o.type.startsWith("missed-"));
    results.push({
      slug: r.slug || r.sessionId.slice(0, 8),
      edits: r.editedFiles.length,
      totalObs: r.observations.length,
      missedCount: missedObs.length,
      missedTypes: [...new Set(missedObs.map(o => o.type))],
      positive: r.observations.filter(o => o.positive).length,
    });
  } catch {
    // skip failures
  }
}

console.log(`Sessions with edits: ${results.length}\n`);
console.log("Session".padEnd(32) + "Edits  Missed  Positive  Total");
console.log("-".repeat(70));
for (const r of results) {
  console.log(
    r.slug.padEnd(32) +
    String(r.edits).padStart(5) +
    String(r.missedCount).padStart(8) +
    String(r.positive).padStart(10) +
    String(r.totalObs).padStart(7) +
    "  " + r.missedTypes.join(", ")
  );
}

const withGaps = results.filter(r => r.missedCount >= 2);
console.log("\n--- Gate A ---");
console.log(`Sessions with >= 2 missed-* observations: ${withGaps.length}/${results.length} (${(withGaps.length / results.length * 100).toFixed(0)}%)`);
console.log(`Threshold: >= 60%`);
console.log(`Result: ${withGaps.length / results.length >= 0.6 ? "PASS" : "FAIL"}`);
