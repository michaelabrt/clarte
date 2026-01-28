#!/usr/bin/env node
// A/B smoke test: baseline (clarte context, no MCP tools) vs MCP-enabled session.
//
// Usage:
//   node scripts/mcp-smoke.mjs [source-repo-path]
//
// If source-repo-path is omitted, clones typeorm to /tmp.
// Both runs get clarte-generated CLAUDE.md. Only the MCP run gets tools (no enforcement hooks).
// Set MODEL=sonnet (default) or MODEL=haiku.

import { execSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const CLARTE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const TYPEORM_REPO = "typeorm/typeorm";
const TYPEORM_COMMIT = "65dea3c0f562203fa729d1bed2775c11efa21845";
const TYPEORM_TASK_SPECIFIC =
  "TypeORM's SQLite driver has three bugs with simple-enum columns when array: true. " +
  "(1) In AbstractSqliteQueryRunner.buildCreateColumnSql(), the generated CHECK constraint " +
  "validates against individual enum values, but stored values are comma-joined strings like " +
  "'0,1' - skip CHECK generation when column.isArray is true. " +
  "(2) In AbstractSqliteDriver.normalizeDefault(), array default values are not quoted - when " +
  "the default is an array and type is simple-enum, join and wrap in quotes. " +
  "(3) In DateUtils.simpleEnumToString() and DateUtils.stringToSimpleEnum(), arrays are not " +
  "serialized/deserialized - join arrays with commas on write, split comma-separated strings " +
  "and parse numeric values on read. Fix the bugs and add tests.";

// Same three bugs, no file or function names given. Agent must locate them.
const TYPEORM_TASK_OPAQUE =
  "TypeORM has three related bugs when using a simple-enum column with array: true on SQLite. " +
  "(1) Schema creation generates invalid DDL: the CHECK constraint fails at runtime because " +
  "array-valued enum columns store comma-joined strings like '0,1', not individual values. " +
  "(2) Array default values for simple-enum columns are persisted incorrectly in the schema. " +
  "(3) Values do not round-trip correctly through the ORM: writing an array reads back as a " +
  "plain string, and numeric enum members are not re-parsed on read. " +
  "Find and fix all three bugs. Add tests to cover the fixed behaviour.";

const TYPEORM_TASK = process.env.OPAQUE === "1" ? TYPEORM_TASK_OPAQUE : TYPEORM_TASK_SPECIFIC;

const MODEL = process.env.MODEL ?? "sonnet";
const BUDGET = process.env.BUDGET ?? "1.50";

function sh(cmd, opts = {}) {
  return execSync(cmd, { stdio: "inherit", ...opts });
}

function shq(cmd, opts = {}) {
  return execSync(cmd, { encoding: "utf-8", stdio: "pipe", ...opts }).trim();
}

function label(tag, msg) {
  console.log(`[ ${tag.padEnd(6)} ] ${msg}`);
}

// All report output is buffered to a file; only the file path + final verdict
// are printed to the terminal.
const outLines = [];
function out(...args) { outLines.push(args.map(String).join(" ")); }

// ── Setup: source repo ─────────────────────────────────────────────────────────

let sourceDir = process.argv[2] ? resolve(process.argv[2]) : null;

if (!sourceDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  sourceDir = join(tmpdir(), `mcp-smoke-src-${ts}`);
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

// ── Create two isolated working dirs via local git clone ───────────────────────
// git clone --local copies only tracked files (no node_modules).
// We symlink node_modules from source to avoid duplicating gigabytes.

const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const baselineDir = join(tmpdir(), `mcp-smoke-baseline-${ts}`);
const mcpDir = join(tmpdir(), `mcp-smoke-mcp-${ts}`);

for (const [name, dir] of [["baseline", baselineDir], ["mcp", mcpDir]]) {
  label("setup", `Creating ${name} workdir: ${dir}`);
  sh(`git clone --quiet --local --no-hardlinks -c advice.detachedHead=false ${sourceDir} ${dir}`);
  // Symlink node_modules to avoid re-installing
  if (existsSync(join(sourceDir, "node_modules"))) {
    sh(`ln -s ${join(sourceDir, "node_modules")} ${join(dir, "node_modules")}`);
  }
}

// ── Generate clarte context for both runs ─────────────────────────────────────

// Seed a .clarte.json in both dirs forcing ides: ["claude"] so both runs
// produce identical CLAUDE.md and .claude/rules/clarte.md. The only difference
// between runs is that the MCP run gets .mcp.json + enforcement hooks.
const baseConfig = {
  ides: ["claude"],
  projectPurpose: "",
  keyPatterns: "",
  gotchas: "",
  generateSnapshot: false,
  snapshotPaths: [],
  stackCorrections: "",
  generatePerPackage: false,
};
writeFileSync(join(baselineDir, ".clarte.json"), JSON.stringify(baseConfig, null, 2));
writeFileSync(join(mcpDir,      ".clarte.json"), JSON.stringify(baseConfig, null, 2));
label("setup", "Pre-seeded .clarte.json (ides: claude) in both workdirs.");

label("setup", "Running clarte generate (baseline, no --mcp)...");
sh(`node ${join(CLARTE_ROOT, "dist/index.js")} ${baselineDir} --yes < /dev/null`);

label("setup", "Running clarte generate --mcp...");
sh(`node ${join(CLARTE_ROOT, "dist/index.js")} ${mcpDir} --mcp --yes < /dev/null`);

// Patch .mcp.json to use local dist
const mcpJsonPath = join(mcpDir, ".mcp.json");
writeFileSync(mcpJsonPath, JSON.stringify({
  mcpServers: {
    clarte: { command: "node", args: [join(CLARTE_ROOT, "dist/index.js"), "serve"], type: "stdio", cwd: mcpDir },
  },
}, null, 2));
label("setup", "Patched .mcp.json.");

// Pre-flight: verify shared files exist in both runs
const sharedRequired = [
  [baselineDir, ".clarte/graph.json"],
  [baselineDir, ".claude/rules/clarte.md"],
  [mcpDir, ".clarte/graph.json"],
  [mcpDir, ".claude/rules/clarte.md"],
  [mcpDir, ".claude/settings.json"],
];
for (const [dir, rel] of sharedRequired) {
  const f = join(dir, rel);
  if (!existsSync(f)) { label("ERROR", `Missing: ${f}`); process.exit(1); }
}
if (!existsSync(mcpJsonPath)) { label("ERROR", `Missing: ${mcpJsonPath}`); process.exit(1); }
label("setup", "Pre-flight OK.\n");

// ── Run sessions ──────────────────────────────────────────────────────────────

function runSession(workDir, extraArgs, tag) {
  const env = { ...process.env };
  delete env.CLAUDECODE;

  label(tag, `Starting claude -p (model: ${MODEL}, budget: $${BUDGET})...`);
  const start = Date.now();
  const proc = spawnSync(
    "claude",
    ["-p", TYPEORM_TASK, "--output-format", "json", "--model", MODEL,
     "--max-budget-usd", BUDGET, "--dangerously-skip-permissions", ...extraArgs],
    { cwd: workDir, env, encoding: "utf-8", timeout: 600_000, maxBuffer: 20 * 1024 * 1024 },
  );
  const durationMs = Date.now() - start;

  if (proc.stderr) {
    const mcpLines = proc.stderr.split("\n")
      .filter(l => l.includes("mcp") || l.includes("MCP") || l.includes("clarte") || l.includes("error") || l.includes("Error"));
    if (mcpLines.length > 0) {
      console.log(`\n[${tag} stderr]`);
      mcpLines.slice(0, 20).forEach(l => console.log(" ", l));
    }
  }

  if (!proc.stdout?.trim()) {
    label("ERROR", `${tag}: no output from claude -p`);
    if (proc.stderr) console.error(proc.stderr.slice(0, 500));
    return null;
  }

  let result;
  try { result = JSON.parse(proc.stdout); }
  catch { label("ERROR", `${tag}: failed to parse JSON output`); return null; }

  return { result, durationMs };
}

const baselineRun = runSession(baselineDir, [], "base");
const mcpRun = runSession(mcpDir, ["--mcp-config", mcpJsonPath, "--mcp-debug"], "mcp");

if (!baselineRun || !mcpRun) process.exit(1);

// ── Parse session JSONL ───────────────────────────────────────────────────────

function parseLog(workDir, apiResult) {
  const sessionId = apiResult.session_id ?? "";
  const projectKey = workDir.replace(/\//g, "-");
  const logPath = join(homedir(), ".claude", "projects", projectKey, `${sessionId}.jsonl`);

  const stats = {
    logFound: existsSync(logPath),
    logPath,
    toolCalls: {},   // all non-MCP tool calls
    mcpCalls: {},    // MCP tool calls
    firstEditTurn: null,
    totalToolTurns: 0,   // assistant turns containing at least one tool_use
    editTurns: 0,        // turns containing Edit/Write/str_replace_editor
    readTurns: 0,        // turns containing Read
    bashTurns: 0,        // turns containing Bash
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

      // Token usage (if present in metadata)
      const usage = msg.usage ?? entry.usage;
      if (usage) {
        stats.inputTokens += usage.input_tokens ?? 0;
        stats.outputTokens += usage.output_tokens ?? 0;
      }
    }

  }

  return stats;
}

const baselineStats = parseLog(baselineDir, baselineRun.result);
const mcpStats = parseLog(mcpDir, mcpRun.result);

// ── Patch stats ───────────────────────────────────────────────────────────────

function patchStats(workDir) {
  try {
    const diff = shq("git diff HEAD", { cwd: workDir });
    const statOut = shq("git diff HEAD --stat", { cwd: workDir });
    const files = shq("git diff HEAD --name-only", { cwd: workDir }).split("\n").filter(Boolean);
    const m = statOut.match(/(\d+) insertion[s]?.*?(\d+) deletion/s);
    return {
      diff,
      files,
      insertions: m ? parseInt(m[1]) : 0,
      deletions: m ? parseInt(m[2]) : 0,
    };
  } catch {
    return { diff: "", files: [], insertions: 0, deletions: 0 };
  }
}

const bPatch = patchStats(baselineDir);
const mPatch = patchStats(mcpDir);

// ── Report ────────────────────────────────────────────────────────────────────

const bR = baselineRun.result;
const mR = mcpRun.result;

function fmt(val, unit = "") {
  if (val === null || val === undefined) return "n/a";
  return `${val}${unit}`;
}

function fmtCost(usd) {
  return usd != null ? `$${usd.toFixed(4)}` : "n/a";
}

function delta(a, b, higherIsBetter = false) {
  if (a == null || b == null) return "";
  const d = b - a;
  const pct = a !== 0 ? Math.round((d / a) * 100) : 0;
  const sign = d > 0 ? "+" : "";
  const good = higherIsBetter ? d > 0 : d < 0;
  const marker = d === 0 ? "  =" : good ? "  ↓" : "  ↑";
  return `${marker} ${sign}${pct}%`;
}

const COL = 28;
const W = 10;
function row(label, bVal, mVal, dVal = "") {
  out(`  ${label.padEnd(COL)} ${String(bVal).padStart(W)} ${String(mVal).padStart(W)}  ${dVal}`);
}

const taskVariant = process.env.OPAQUE === "1" ? "opaque" : "specific";
out("\n══════════════════════════════════════════════════════════");
out("  MCP A/B Results");
out(`  Model: ${MODEL}  Budget: $${BUDGET}  Task: ${taskVariant}  Date: ${new Date().toISOString().slice(0, 10)}`);
out("══════════════════════════════════════════════════════════");
out(`  ${"".padEnd(COL)} ${"BASELINE".padStart(W)} ${"MCP".padStart(W)}`);
out("──────────────────────────────────────────────────────────");

// Session
row("Turns (API)",           bR.num_turns,       mR.num_turns,       delta(bR.num_turns, mR.num_turns));
row("Cost",                  fmtCost(bR.total_cost_usd), fmtCost(mR.total_cost_usd), delta(bR.total_cost_usd, mR.total_cost_usd));
row("Duration",              `${Math.round(baselineRun.durationMs/1000)}s`, `${Math.round(mcpRun.durationMs/1000)}s`);
row("Cost per turn",
  fmtCost((bR.total_cost_usd ?? 0) / (bR.num_turns || 1)),
  fmtCost((mR.total_cost_usd ?? 0) / (mR.num_turns || 1)));

// Timing
out("");
row("Tool-use turns",        baselineStats.totalToolTurns, mcpStats.totalToolTurns, delta(baselineStats.totalToolTurns, mcpStats.totalToolTurns));
row("First edit turn",       fmt(baselineStats.firstEditTurn), fmt(mcpStats.firstEditTurn), delta(baselineStats.firstEditTurn, mcpStats.firstEditTurn));
row("Exploration turns",
  fmt(baselineStats.firstEditTurn != null ? baselineStats.firstEditTurn - 1 : null),
  fmt(mcpStats.firstEditTurn != null ? mcpStats.firstEditTurn - 1 : null));
row("Exploration ratio",
  baselineStats.firstEditTurn != null ? `${Math.round((baselineStats.firstEditTurn-1)/baselineStats.totalToolTurns*100)}%` : "n/a",
  mcpStats.firstEditTurn != null ? `${Math.round((mcpStats.firstEditTurn-1)/mcpStats.totalToolTurns*100)}%` : "n/a");

// Tokens
if (baselineStats.inputTokens > 0 || mcpStats.inputTokens > 0) {
  out("");
  row("Input tokens",  fmt(baselineStats.inputTokens), fmt(mcpStats.inputTokens), delta(baselineStats.inputTokens, mcpStats.inputTokens));
  row("Output tokens", fmt(baselineStats.outputTokens), fmt(mcpStats.outputTokens), delta(baselineStats.outputTokens, mcpStats.outputTokens));
}

// Tool breakdown
out("\n  Tool calls:");
const allTools = new Set([...Object.keys(baselineStats.toolCalls), ...Object.keys(mcpStats.toolCalls)]);
const toolOrder = ["Read", "Edit", "Write", "Bash", "Grep", "Glob", "str_replace_editor"];
const orderedTools = [...toolOrder.filter(t => allTools.has(t)), ...[...allTools].filter(t => !toolOrder.includes(t)).sort()];
for (const t of orderedTools) {
  const b = baselineStats.toolCalls[t] ?? 0;
  const m = mcpStats.toolCalls[t] ?? 0;
  if (b === 0 && m === 0) continue;
  row(`  ${t}`, b || "-", m || "-", b > 0 && m > 0 ? delta(b, m) : "");
}

// Turn-level aggregates
out("");
row("  Edit turns",   baselineStats.editTurns,  mcpStats.editTurns);
row("  Read turns",   baselineStats.readTurns,  mcpStats.readTurns);
row("  Bash turns",   baselineStats.bashTurns,  mcpStats.bashTurns);

// MCP calls
const totalMcp = Object.values(mcpStats.mcpCalls).reduce((a, b) => a + b, 0);
if (totalMcp > 0) {
  out("\n  MCP tool calls (baseline: none):");
  for (const [t, c] of Object.entries(mcpStats.mcpCalls)) {
    row(`  ${t}`, "-", c);
  }
}

// Patch stats
out("\n  Patch:");
row("  Files changed",  bPatch.files.length, mPatch.files.length);
row("  Lines added",    bPatch.insertions,   mPatch.insertions);
row("  Lines removed",  bPatch.deletions,    mPatch.deletions);
row("  Net lines",      bPatch.insertions - bPatch.deletions, mPatch.insertions - mPatch.deletions);

const bFiles = new Set(bPatch.files);
const mFiles = new Set(mPatch.files);
const shared = bPatch.files.filter(f => mFiles.has(f));
const onlyB = bPatch.files.filter(f => !mFiles.has(f));
const onlyM = mPatch.files.filter(f => !bFiles.has(f));

out(`\n  Files changed:`);
if (shared.length > 0) out(`    both:     ${shared.join(", ")}`);
if (onlyB.length > 0)  out(`    baseline: ${onlyB.join(", ")}`);
if (onlyM.length > 0)  out(`    mcp only: ${onlyM.join(", ")}`);

// Checks
out("\n──────────────────────────────────────────────────────────");
const baselineClaudeContext = existsSync(join(baselineDir, ".claude", "rules", "clarte.md"));
const checks = [
  ["Baseline Claude context present", baselineClaudeContext],
  ["Baseline session log found",      baselineStats.logFound],
  ["MCP session log found",           mcpStats.logFound],
  ["MCP tools called",                totalMcp > 0],
  ["clarte_scope called",             (mcpStats.mcpCalls.scope ?? 0) > 0],
];
for (const [desc, pass] of checks) {
  out(`  ${pass ? "PASS" : "FAIL"}  ${desc}`);
}
const allPass = checks.every(([, p]) => p);
out(`\n  ${allPass ? "ALL PASS" : "SOME FAILED"}`);
out("══════════════════════════════════════════════════════════\n");

// ── Patches ───────────────────────────────────────────────────────────────────

out("══════════════════════════════════════════════════════════");
out("  Baseline patch");
out("══════════════════════════════════════════════════════════");
out(bPatch.diff.trim() || "(no changes)");

out("\n══════════════════════════════════════════════════════════");
out("  MCP patch");
out("══════════════════════════════════════════════════════════");
out(mPatch.diff.trim() || "(no changes)");

// ── Write report to file ──────────────────────────────────────────────────────

const reportFile = join(tmpdir(), `mcp-smoke-${ts}.txt`);
writeFileSync(reportFile, outLines.join("\n") + "\n");
console.log(`\nResults written to: ${reportFile}`);
console.log(`  ${allPass ? "ALL PASS" : "SOME FAILED"}  (baseline: ${fmtCost(bR.total_cost_usd)}, ${bR.num_turns} turns | mcp: ${fmtCost(mR.total_cost_usd)}, ${mR.num_turns} turns)`);

process.exit(allPass ? 0 : 1);
