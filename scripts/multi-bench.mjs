#!/usr/bin/env node
// Pre-flight mechanism smoke test against the typeorm SQLite enum task.
//
// Usage:
//   node scripts/multi-bench.mjs [source-repo-path]
//
// Runs a single pre-flight condition:
//   - clarte generate installs deny-gate hooks + .claude/agents/clarte-pre-flight.md
//   - Oracle task-context.md is pre-written (bypasses BM25 routing)
//   - Verifies gate fires, subagent spawns, reads files, returns edit instructions
//
// Set MODEL=sonnet (default) or MODEL=haiku.
// Set BUDGET=3.00 (default).

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLARTE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TYPEORM_REPO = "typeorm/typeorm";
const TYPEORM_COMMIT = "65dea3c0f562203fa729d1bed2775c11efa21845";

const TYPEORM_TASK =
  "TypeORM has three related bugs when using a simple-enum column with array: true on SQLite. " +
  "(1) Schema creation generates invalid DDL: the CHECK constraint fails at runtime because " +
  "array-valued enum columns store comma-joined strings like '0,1', not individual values. " +
  "(2) Array default values for simple-enum columns are persisted incorrectly in the schema. " +
  "(3) Values do not round-trip correctly through the ORM: writing an array reads back as a " +
  "plain string, and numeric enum members are not re-parsed on read. " +
  "Find and fix all three bugs. Add tests to cover the fixed behaviour.";

const MODEL = process.env.MODEL ?? "sonnet";
const BUDGET = process.env.BUDGET ?? "3.00";

// Placebo CLAUDE.md used as base for all conditions
const PLACEBO = `# TypeORM
A TypeScript ORM for Node.js. Supports many SQL databases. Tests use mocha.
`;

// Oracle task-context.md: the exact 3 files that contain the 3 bugs.
// Pre-written to isolate delivery mechanism from routing quality.
const ORACLE_CONTEXT = `# Edit targets (clarte)

Based on past fixes to similar issues, these files are most likely to need editing:

- src/driver/sqlite-abstract/AbstractSqliteQueryRunner.ts
- src/driver/sqlite-abstract/AbstractSqliteDriver.ts
- src/util/DateUtils.ts

Matched commit: fix: sqlite simple-enum array serialization, check constraint and default values
`;

const CONDITIONS = ["pre-flight"];

// ── Helpers ───────────────────────────────────────────────────────────────────

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function shq(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

function label(tag, msg) {
  console.log(`[ ${tag.padEnd(10)} ] ${msg}`);
}

// ── Setup: source repo ────────────────────────────────────────────────────────

let sourceDir = process.argv[2] ? resolve(process.argv[2]) : null;

if (!sourceDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  sourceDir = join(tmpdir(), `multi-bench-src-${ts}`);
  label("setup", `Cloning typeorm @ ${TYPEORM_COMMIT.slice(0, 8)} to ${sourceDir}...`);
  sh(`git clone --quiet https://github.com/${TYPEORM_REPO}.git ${sourceDir}`);
  sh(`git -C ${sourceDir} checkout --quiet ${TYPEORM_COMMIT}`);
  label("setup", "Installing deps...");
  try { sh("npm install --silent", { cwd: sourceDir }); } catch { /* best effort */ }
}

label("setup", `Source: ${sourceDir}`);

// Build clarte
label("setup", "Building clarte...");
try { sh("npm run build --silent", { cwd: CLARTE_ROOT, stdio: "pipe" }); } catch { /* already built */ }

// ── Create isolated working dirs ──────────────────────────────────────────────

const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);

const workDirs = {};
for (const name of CONDITIONS) {
  const dir = join(tmpdir(), `multi-bench-${name}-${RUN_TS}`);
  workDirs[name] = dir;
  label("setup", `Creating ${name} workdir: ${dir}`);
  sh(`git clone --quiet --local --no-hardlinks -c advice.detachedHead=false ${sourceDir} ${dir}`);
  if (existsSync(join(sourceDir, "node_modules"))) {
    sh(`ln -s ${join(sourceDir, "node_modules")} ${join(dir, "node_modules")}`);
  }
}

// ── Write CLAUDE.md per condition ─────────────────────────────────────────────

// pre-flight: clarte generate installs the deny-gate hooks and .claude/agents/clarte-pre-flight.md.
// Oracle task-context.md is pre-written (bypasses BM25 routing) to isolate delivery from routing.
// Tests whether the enforced sequential pre-flight agent actually substitutes exploration.
const baseConfig = { ides: ["claude"], projectPurpose: "", keyPatterns: "", gotchas: "",
  generateSnapshot: false, snapshotPaths: [], stackCorrections: "", generatePerPackage: false };
writeFileSync(join(workDirs["pre-flight"], ".clarte.json"), JSON.stringify(baseConfig, null, 2));
label("setup", "Running clarte generate for pre-flight...");
try {
  sh(`node ${join(CLARTE_ROOT, "dist/index.js")} ${workDirs["pre-flight"]} --yes < /dev/null`);
} catch (e) {
  label("WARN", `clarte generate failed for pre-flight: ${e.message}`);
}
// Write oracle task-context.md (exact correct files - bypasses hook routing)
mkdirSync(join(workDirs["pre-flight"], ".clarte"), { recursive: true });
writeFileSync(join(workDirs["pre-flight"], ".clarte/task-context.md"), ORACLE_CONTEXT);
label("setup", "pre-flight: oracle task-context.md written, deny-gate hooks active.");

label("setup", "Setup complete. Starting baseline vs pre-flight...\n");

// ── Run sessions in parallel via async spawn ──────────────────────────────────

function runSession(workDir, extraArgs, tag) {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_ENTRYPOINT;

    label(tag, `Starting claude -p (model: ${MODEL}, budget: $${BUDGET})...`);
    const start = Date.now();

    const stdoutChunks = [];
    const stderrChunks = [];

    const proc = spawn(
      "claude",
      ["-p", TYPEORM_TASK, "--output-format", "json", "--model", MODEL,
       "--max-budget-usd", BUDGET, "--dangerously-skip-permissions", ...extraArgs],
      { cwd: workDir, env, stdio: ["ignore", "pipe", "pipe"] },
    );

    proc.stdout.on("data", d => stdoutChunks.push(d));
    proc.stderr.on("data", d => stderrChunks.push(d));

    let timedOut = false;
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGTERM");
      label("WARN", `${tag}: timed out after 20 minutes`);
    }, 1_200_000);

    proc.on("close", () => {
      clearTimeout(timeoutHandle);
      const durationMs = Date.now() - start;
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");

      if (stderr) {
        if (timedOut) {
          console.log(`\n[${tag} stderr (timeout dump)]`);
          stderr.trim().split("\n").slice(-40).forEach(l => console.log(" ", l));
        } else {
          const notable = stderr.split("\n").filter(
            l => l.includes("mcp") || l.includes("MCP") || l.includes("clarte") ||
                 l.includes("error") || l.includes("Error"),
          );
          if (notable.length > 0) {
            console.log(`\n[${tag} stderr]`);
            notable.slice(0, 10).forEach(l => console.log(" ", l));
          }
        }
      }

      if (!stdout.trim()) {
        label("ERROR", `${tag}: no output from claude -p`);
        if (stderr && !timedOut) console.error(stderr.slice(0, 500));
        resolve({ result: null, durationMs, error: "no output" });
        return;
      }

      let result;
      try { result = JSON.parse(stdout); }
      catch {
        label("ERROR", `${tag}: failed to parse JSON output`);
        resolve({ result: null, durationMs, error: "json parse failed" });
        return;
      }

      if (result.num_turns == null) {
        label("DEBUG", `${tag}: unexpected JSON keys: ${Object.keys(result).join(", ")}`);
        label("DEBUG", `${tag}: raw stdout (first 300): ${stdout.slice(0, 300)}`);
      }
      label(tag, `Done. Turns: ${result.num_turns}, cost: $${result.total_cost_usd?.toFixed(4) ?? "?"}`);
      resolve({ result, durationMs, error: null });
    });

    proc.on("error", (err) => {
      clearTimeout(timeoutHandle);
      label("ERROR", `${tag}: spawn error - ${err.message}`);
      resolve({ result: null, durationMs: Date.now() - start, error: err.message });
    });
  });
}

label("bench", "pre-flight...");
const routeRun = await runSession(workDirs["pre-flight"], [], "pre-flight");

// ── Parse session logs ────────────────────────────────────────────────────────

function parseLog(workDir, apiResult) {
  if (!apiResult) return null;

  const sessionId = apiResult.session_id ?? "";
  const projectKey = workDir.replace(/\//g, "-");
  const logPath = join(homedir(), ".claude", "projects", projectKey, `${sessionId}.jsonl`);

  const stats = {
    logFound: existsSync(logPath),
    logPath,
    toolCalls: {},
    mcpCalls: {},
    firstEditTurn: null,
    totalToolTurns: 0,
    editTurns: 0,
    readTurns: 0,
    bashTurns: 0,
    inputTokens: 0,
    outputTokens: 0,
  };

  if (!stats.logFound) return stats;

  const lines = readFileSync(logPath, "utf-8").trim().split("\n");
  for (const line of lines) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const msg = entry.message ?? entry;

    if (entry.type === "assistant" || msg.role === "assistant") {
      const blocks = msg.content ?? [];
      const toolBlocks = blocks.filter(b => b.type === "tool_use");
      if (toolBlocks.length > 0) stats.totalToolTurns++;

      const names = toolBlocks.map(b => b.name ?? "");
      if (names.some(n => ["Edit", "Write", "str_replace_editor"].includes(n))) stats.editTurns++;
      if (names.some(n => n === "Read")) stats.readTurns++;
      if (names.some(n => n === "Bash")) stats.bashTurns++;

      for (const block of toolBlocks) {
        const name = block.name ?? "";
        if (name.startsWith("mcp__clarte__")) {
          const short = name.replace("mcp__clarte__clarte_", "").replace("mcp__clarte__", "");
          stats.mcpCalls[short] = (stats.mcpCalls[short] ?? 0) + 1;
        } else {
          stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
        }
        if (["Edit", "Write", "str_replace_editor"].includes(name) && stats.firstEditTurn === null) {
          stats.firstEditTurn = stats.totalToolTurns;
        }
      }

      const usage = msg.usage ?? entry.usage;
      if (usage) {
        stats.inputTokens += usage.input_tokens ?? 0;
        stats.outputTokens += usage.output_tokens ?? 0;
      }
    }
  }

  return stats;
}

function patchStats(workDir) {
  try {
    const diff = shq("git diff HEAD", { cwd: workDir });
    const statOut = shq("git diff HEAD --stat", { cwd: workDir });
    const files = shq("git diff HEAD --name-only", { cwd: workDir }).split("\n").filter(Boolean);
    const m = statOut.match(/(\d+) insertion[s]?.*?(\d+) deletion/s);
    return { diff, files, insertions: m ? parseInt(m[1]) : 0, deletions: m ? parseInt(m[2]) : 0 };
  } catch {
    return { diff: "", files: [], insertions: 0, deletions: 0 };
  }
}

// Collect run data
const runs = {
  "pre-flight": { run: routeRun, workDir: workDirs["pre-flight"] },
};

for (const cond of CONDITIONS) {
  const r = runs[cond];
  r.stats = parseLog(r.workDir, r.run.result);
  r.patch = patchStats(r.workDir);
}

// ── Condition-specific checks ─────────────────────────────────────────────────

function logContains(stats, needle) {
  if (!stats?.logFound) return false;
  try { return readFileSync(stats.logPath, "utf-8").includes(needle); }
  catch { return false; }
}

const checks = [];

// ── Build report ──────────────────────────────────────────────────────────────

const outLines = [];
function out(...args) { outLines.push(args.map(String).join(" ")); }

function fmtCost(usd) { return usd != null ? `$${usd.toFixed(4)}` : "n/a"; }
function fmtN(v)      { return v != null ? String(v) : "n/a"; }
function fmtPct(v)    { return v != null ? `${Math.round(v)}%` : "n/a"; }

function deltaPct(base, val) {
  if (base == null || val == null || base === 0) return "—";
  const pct = Math.round(((val - base) / base) * 100);
  return pct === 0 ? "=0%" : pct > 0 ? `+${pct}%` : `${pct}%`;
}

function explorationRatio(stats) {
  if (!stats || stats.firstEditTurn == null || stats.totalToolTurns === 0) return null;
  return Math.round(((stats.firstEditTurn - 1) / stats.totalToolTurns) * 100);
}

out("");
out("══════════════════════════════════════════════════════════════════════");
out(`  Pre-flight smoke test  Model: ${MODEL}  Budget: $${BUDGET}`);
out(`  Date: ${new Date().toISOString().slice(0, 10)}  Task: opaque SQLite enum`);
out("══════════════════════════════════════════════════════════════════════");

// Main table
const COL_W = [17, 8, 10, 12, 11, 12];
function tableRow(...cells) {
  out("  " + cells.map((c, i) => String(c).padStart(COL_W[i] ?? 10)).join("  "));
}

out("");
tableRow("Condition", "Turns", "Cost", "First-edit", "Explore%");
out("  " + "─".repeat(COL_W.slice(0, 5).reduce((a, b) => a + b, 0) + 5 * 2));

for (const cond of CONDITIONS) {
  const r = runs[cond];
  const res = r.run.result;
  const stats = r.stats;
  tableRow(
    cond,
    fmtN(res?.num_turns),
    fmtCost(res?.total_cost_usd),
    fmtN(stats?.firstEditTurn),
    fmtPct(explorationRatio(stats)),
  );
}

// Cost delta

// Condition checks
out("");
out("  Condition checks:");
for (const [desc, pass] of checks) {
  out(`    ${pass ? "PASS" : "FAIL"}  ${desc}`);
}

// Tool breakdown
out("");
out("  Tool calls by condition:");

const allToolKeys = new Set();
for (const cond of CONDITIONS) {
  const s = runs[cond].stats;
  if (!s) continue;
  for (const k of Object.keys(s.toolCalls)) allToolKeys.add(k);
  for (const k of Object.keys(s.mcpCalls)) allToolKeys.add(`mcp:${k}`);
}
const toolOrder = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "str_replace_editor"];
const orderedTools = [
  ...toolOrder.filter(k => allToolKeys.has(k)),
  ...[...allToolKeys].filter(k => !toolOrder.includes(k) && !k.startsWith("mcp:")).sort(),
  ...[...allToolKeys].filter(k => k.startsWith("mcp:")).sort(),
];

const TC = 24;
const CCOL = 11;
out("    " + "".padEnd(TC) + CONDITIONS.map(c => c.slice(0, CCOL - 1).padStart(CCOL)).join(""));
for (const tool of orderedTools) {
  const vals = CONDITIONS.map(cond => {
    const s = runs[cond].stats;
    if (!s) return "-";
    if (tool.startsWith("mcp:")) return String(s.mcpCalls[tool.slice(4)] ?? "-");
    return String(s.toolCalls[tool] ?? "-");
  });
  if (vals.every(v => v === "-")) continue;
  out("    " + tool.padEnd(TC) + vals.map(v => v.padStart(CCOL)).join(""));
}

// Patch stats
out("");
out("  Patch stats:");
out("    " + "Condition".padEnd(16) + ["Files", "Add", "Del", "Net"].map(h => h.padStart(7)).join(""));
for (const cond of CONDITIONS) {
  const p = runs[cond].patch;
  out("    " + cond.padEnd(16) +
    [p.files.length, p.insertions, p.deletions, p.insertions - p.deletions]
      .map(v => String(v).padStart(7)).join(""));
}

// Files changed
out("");
out("  Files changed per condition:");
for (const cond of CONDITIONS) {
  const files = runs[cond].patch.files;
  if (files.length === 0) {
    out(`    ${cond}: (none)`);
  } else {
    out(`    ${cond}:`);
    for (const f of files) out(`      ${f}`);
  }
}

// Failures
const failed = CONDITIONS.filter(c => runs[c].run.result === null);
if (failed.length > 0) {
  out("");
  out(`  FAILED conditions: ${failed.join(", ")}`);
}

out("");
out("══════════════════════════════════════════════════════════════════════");
out("");

// Full patches
for (const cond of CONDITIONS) {
  out("══════════════════════════════════════════════════════════════════════");
  out(`  Patch: ${cond}`);
  out("══════════════════════════════════════════════════════════════════════");
  out(runs[cond].patch.diff.trim() || "(no changes)");
  out("");
}

// ── Write report + print terminal summary ─────────────────────────────────────

const reportFile = join(tmpdir(), `multi-bench-${RUN_TS}.txt`);
writeFileSync(reportFile, outLines.join("\n") + "\n");

console.log("\n" + "═".repeat(70));
console.log(`  Results written to: ${reportFile}`);
console.log("");
console.log("  Summary:");
for (const cond of CONDITIONS) {
  const res = runs[cond].run.result;
  const stats = runs[cond].stats;
  console.log(
    `    ${cond.padEnd(14)}  turns=${fmtN(res?.num_turns)}  cost=${fmtCost(res?.total_cost_usd)}` +
    `  first-edit=${fmtN(stats?.firstEditTurn)}`,
  );
}
console.log("");
const checksPass = checks.filter(([, p]) => p).length;
console.log(`  Checks: ${checksPass}/${checks.length} passed`);
console.log("═".repeat(70));

process.exit(failed.length > 0 ? 1 : 0);
