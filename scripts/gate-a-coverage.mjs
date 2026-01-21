import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

// Load rendered test-map files
const renderedFiles = new Set(
  fs.readFileSync("/tmp/rendered-test-map-files.txt", "utf-8")
    .trim().split("\n").filter(Boolean)
);

// Load graph test mapping
const graph = JSON.parse(
  fs.readFileSync(".clarte/graph.json", "utf-8")
);
const graphTestMapFiles = new Set(Object.keys(graph.testMapping));

const dir = path.join(os.homedir(), ".claude/projects/-home-micha-developer-projects-clarte");
const files = fs.readdirSync(dir)
  .filter(f => f.endsWith(".jsonl"))
  .map(f => ({ name: f, size: fs.statSync(path.join(dir, f)).size }))
  .filter(f => f.size > 50000)
  .sort((a, b) => b.size - a.size)
  .slice(0, 30);

let totalMissedTest = 0;
let inRenderedOutput = 0;
let inGraphButNotRendered = 0;
let notInGraph = 0;
const editedFilesWithMissedTest = new Set();
const heavySessions = [];
const lightSessions = [];

for (const f of files) {
  try {
    const out = execSync(
      `node dist/index.js learn "${path.join(dir, f.name)}" --format=json 2>/dev/null`,
      { timeout: 10000, encoding: "utf-8" }
    );
    const r = JSON.parse(out);
    if (r.editedFiles.length === 0) continue;

    const missedTests = r.observations.filter(o => o.type === "missed-test");
    const missedCount = r.observations.filter(o => !o.positive && o.type.startsWith("missed-")).length;

    const bucket = r.editedFiles.length >= 5 ? heavySessions : lightSessions;
    bucket.push({ edits: r.editedFiles.length, missed: missedCount });

    for (const obs of missedTests) {
      totalMissedTest++;
      editedFilesWithMissedTest.add(obs.file);
      if (renderedFiles.has(obs.file)) {
        inRenderedOutput++;
      } else if (graphTestMapFiles.has(obs.file)) {
        inGraphButNotRendered++;
      } else {
        notInGraph++;
      }
    }
  } catch {
    // skip
  }
}

console.log("=== missed-test coverage analysis ===\n");
console.log(`Total missed-test observations: ${totalMissedTest}`);
console.log(`Unique edited files with missed-test: ${editedFilesWithMissedTest.size}\n`);
console.log(`In rendered CLAUDE.md test-mapping:   ${inRenderedOutput} (${(inRenderedOutput/totalMissedTest*100).toFixed(0)}%)`);
console.log(`In graph but NOT in rendered output:   ${inGraphButNotRendered} (${(inGraphButNotRendered/totalMissedTest*100).toFixed(0)}%)`);
console.log(`Not in graph at all:                   ${notInGraph} (${(notInGraph/totalMissedTest*100).toFixed(0)}%)\n`);

console.log("Which files trigger missed-test:");
for (const f of editedFilesWithMissedTest) {
  const inRendered = renderedFiles.has(f) ? "RENDERED" : "NOT RENDERED";
  const inGraph = graphTestMapFiles.has(f) ? "in-graph" : "NOT-IN-GRAPH";
  console.log(`  ${f} [${inRendered}] [${inGraph}]`);
}

console.log("\n=== Bimodal breakdown ===\n");
const heavyWithGaps = heavySessions.filter(s => s.missed >= 2);
const lightWithGaps = lightSessions.filter(s => s.missed >= 2);
console.log(`Heavy sessions (>= 5 edits): ${heavySessions.length} total, ${heavyWithGaps.length} with >= 2 missed (${(heavyWithGaps.length/heavySessions.length*100).toFixed(0)}%)`);
console.log(`Light sessions (< 5 edits):  ${lightSessions.length} total, ${lightWithGaps.length} with >= 2 missed (${(lightWithGaps.length/lightSessions.length*100).toFixed(0)}%)`);
