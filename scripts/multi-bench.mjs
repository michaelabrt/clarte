#!/usr/bin/env node
// Multi-condition benchmark: 4 conditions in parallel against the typeorm SQLite enum task.
//
// Usage:
//   node scripts/multi-bench.mjs [source-repo-path]
//
// Conditions:
//   baseline     - Placebo CLAUDE.md only, no MCP tools
//   clarte-grep  - Placebo CLAUDE.md + clarte-grep directive, clarte generate produces script
//   fat-scope    - Placebo CLAUDE.md + MCP server (clarte_scope returns file contents)
//   clarte-route - Placebo CLAUDE.md + clarte_route directive + MCP server
//
// Set MODEL=sonnet (default) or MODEL=haiku.
// Set BUDGET=1.50 (default).

import { execSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
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
const BUDGET = process.env.BUDGET ?? "1.50";

// Placebo CLAUDE.md used as base for all conditions
const PLACEBO = `# TypeORM
A TypeScript ORM for Node.js. Supports many SQL databases. Tests use mocha.
`;

const CONDITIONS = ["baseline", "clarte-route"];

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

// ── Route logic (inline port of clarte_route) ─────────────────────────────────

const BM25_K1 = 1.5;
const BM25_B  = 0.75;

function tokenize(text) {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length >= 3);
}

function buildCorpus(messages) {
  const docs = messages.map(tokenize);
  const avgdl = docs.length === 0 ? 1 : docs.reduce((s, d) => s + d.length, 0) / docs.length;
  const df = new Map();
  for (const doc of docs)
    for (const term of new Set(doc))
      df.set(term, (df.get(term) ?? 0) + 1);
  return { docs, avgdl, df };
}

function bm25(queryTokens, doc, corpus) {
  const N = corpus.docs.length;
  const dl = doc.length;
  const tf = new Map();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
  let score = 0;
  for (const term of queryTokens) {
    const termTf = tf.get(term) ?? 0;
    if (termTf === 0) continue;
    const dfVal = corpus.df.get(term) ?? 0;
    const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
    score += idf * (termTf * (BM25_K1 + 1)) / (termTf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / corpus.avgdl)));
  }
  return score;
}

function computeRoute(rootDir, task) {
  let log;
  try {
    log = shq(`git log --format="%H|%s" --max-count=500`, { cwd: rootDir });
  } catch { return []; }

  const commits = log.split("\n").filter(Boolean).map(line => {
    const sep = line.indexOf("|");
    return sep === -1 ? null : { sha: line.slice(0, sep), message: line.slice(sep + 1) };
  }).filter(Boolean);

  if (commits.length === 0) return [];

  const corpus = buildCorpus(commits.map(c => c.message));
  const query  = tokenize(task);
  const top = commits
    .map((c, i) => ({ ...c, score: bm25(query, corpus.docs[i], corpus) }))
    .filter(c => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const seen = new Set();
  for (const commit of top) {
    let diff;
    try { diff = shq(`git diff-tree --no-commit-id -r --name-only ${commit.sha}`, { cwd: rootDir }); }
    catch { continue; }
    for (const f of diff.split("\n").filter(Boolean)) {
      if (existsSync(join(rootDir, f))) seen.add(f);
      if (seen.size >= 5) break;
    }
    if (seen.size >= 5) break;
  }
  return [...seen];
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

// baseline: placebo only
writeFileSync(join(workDirs["baseline"], "CLAUDE.md"), PLACEBO);
label("setup", "baseline: CLAUDE.md written.");

// clarte-route: clarte generate --mcp produces CLAUDE.md with graph tools section + .mcp.json
const baseConfig = { ides: ["claude"], projectPurpose: "", keyPatterns: "", gotchas: "",
  generateSnapshot: false, snapshotPaths: [], stackCorrections: "", generatePerPackage: false };
writeFileSync(join(workDirs["clarte-route"], ".clarte.json"), JSON.stringify(baseConfig, null, 2));
label("setup", "Running clarte generate --mcp for clarte-route...");
try {
  sh(`node ${join(CLARTE_ROOT, "dist/index.js")} ${workDirs["clarte-route"]} --mcp --yes < /dev/null`);
} catch (e) {
  label("WARN", `clarte generate failed for clarte-route: ${e.message}`);
}
const routeMcpJson = join(workDirs["clarte-route"], ".mcp.json");
writeFileSync(routeMcpJson, JSON.stringify({
  mcpServers: {
    clarte: {
      command: "node",
      args: [join(CLARTE_ROOT, "dist/index.js"), "serve"],
      type: "stdio",
      cwd: workDirs["clarte-route"],
    },
  },
}, null, 2));
label("setup", "clarte-route: MCP server configured.");

label("setup", "Setup complete. Starting baseline vs clarte-route...\n");

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

label("bench", "baseline vs clarte-route...");
const [baselineRun, routeRun] = await Promise.all([
  runSession(workDirs["baseline"],     [],                                                "baseline"),
  runSession(workDirs["clarte-route"], ["--mcp-config", routeMcpJson, "--mcp-debug"],   "c-route"),
]);

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
  "baseline":     { run: baselineRun, workDir: workDirs["baseline"] },
  "clarte-route": { run: routeRun,    workDir: workDirs["clarte-route"] },
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

const bRes = runs["baseline"].run.result;

out("");
out("══════════════════════════════════════════════════════════════════════");
out(`  Multi-condition benchmark  Model: ${MODEL}  Budget: $${BUDGET}`);
out(`  Date: ${new Date().toISOString().slice(0, 10)}  Task: opaque SQLite enum`);
out("══════════════════════════════════════════════════════════════════════");

// Main table
const COL_W = [17, 8, 10, 12, 11, 12];
function tableRow(...cells) {
  out("  " + cells.map((c, i) => String(c).padStart(COL_W[i] ?? 10)).join("  "));
}

out("");
tableRow("Condition", "Turns", "Cost", "First-edit", "Explore%", "vs baseline");
out("  " + "─".repeat(COL_W.reduce((a, b) => a + b, 0) + COL_W.length * 2));

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
    cond === "baseline" ? "—" : deltaPct(bRes?.num_turns, res?.num_turns ?? null),
  );
}

// Cost delta
out("");
out("  Cost delta vs baseline:");
for (const cond of CONDITIONS) {
  if (cond === "baseline") continue;
  const cost = runs[cond].run.result?.total_cost_usd ?? null;
  out(`    ${cond.padEnd(14)}  ${fmtCost(cost)}  (${deltaPct(bRes?.total_cost_usd ?? null, cost)})`);
}

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
  const vb = cond === "baseline" ? "—" : deltaPct(bRes?.num_turns, res?.num_turns ?? null);
  console.log(
    `    ${cond.padEnd(14)}  turns=${fmtN(res?.num_turns)}  cost=${fmtCost(res?.total_cost_usd)}` +
    `  first-edit=${fmtN(stats?.firstEditTurn)}  vs-baseline=${vb}`,
  );
}
console.log("");
const checksPass = checks.filter(([, p]) => p).length;
console.log(`  Checks: ${checksPass}/${checks.length} passed`);
console.log("═".repeat(70));

process.exit(failed.length > 0 ? 1 : 0);
