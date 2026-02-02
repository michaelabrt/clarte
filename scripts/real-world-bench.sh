#!/usr/bin/env bash
set -euo pipefail

# Load nvm if available (needed when run via nohup which skips shell profile)
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

# ── Real-World Benchmark ────────────────────────────────────────────
# A/B comparison of clarte conditions on a real repo + real issue.
#
# Usage:
#   ./scripts/real-world-bench.sh [condition] [results-dir]
#
# Conditions:
#   placebo      - 1-line CLAUDE.md
#   clarte       - Full default clarte output
#   phone-book   - Phone book (file-index) + minimal header only
#   direct       - Original "direct" behavioral instruction
#   direct-1     - Variant: "Read the single most relevant file first"
#   direct-2     - Variant: "Do not use Grep or Glob to explore"
#   direct-3     - Variant: "$0.30 budget, be surgical"
#   all          - Run placebo + direct sequentially (default)
#   parallel     - Run placebo + direct-1/2/3 in parallel, then print combined table
#   r7           - R7 five-dimensions: placebo + direct-2 + 5 new conditions in parallel
#
# results-dir is optional; defaults to /tmp/clarte-bench-<timestamp>.
# Pass the same dir to multiple invocations to collect results together.
#
# Parallel from a regular terminal:
#   OPAQUE=1 MODEL=sonnet RUNS=3 ./scripts/real-world-bench.sh parallel

# ── Target ──────────────────────────────────────────────────────────
TARGET="${TARGET:-hono}"

case "$TARGET" in
  hono)
    REPO="honojs/hono"
    COMMIT="e0f8dd83fb8b84b1a28dee087c50693263fefde6"
    ISSUE_TAG="#4119 (JWK alg fallback)"
    INSTALL_CMD="npm install --silent"
    MAX_BUDGET="3.00"

    PLACEBO_TEXT="# hono
A TypeScript web framework. Tests use vitest."

    ISSUE_DETAILED="The verifyFromJwks function defaults the algorithm to HS256 when the JWK key \
object lacks an alg property. This causes verification to fail for RSA-signed tokens (RS256) \
when the JWKS endpoint (e.g. Microsoft Entra ID) omits alg from its keys. Fix the JWT \
verification to fall back to the algorithm from the JWT header (header.alg) instead of the \
hardcoded HS256 default when the JWK key does not specify an algorithm. Add tests."

    ISSUE_OPAQUE="JWT signature verification fails when using JWKS keys from providers like \
Microsoft Entra ID. The tokens are valid RS256 JWTs and the JWKS endpoint returns the correct \
keys, but verification rejects them. The same tokens verify fine with other libraries. \
It seems related to how the algorithm is determined when the JWKS key metadata doesn't \
explicitly specify it. Fix the bug and add tests."
    ;;
  directus)
    REPO="directus/directus"
    COMMIT="97b11eebfe6b7aa360c87034967dd31c15132f1c"
    ISSUE_TAG="#26596 (field selection >20 fields)"
    INSTALL_CMD="pnpm install --frozen-lockfile --config.engine-strict=false"
    MAX_BUDGET="5.00"

    PLACEBO_TEXT="# directus
A TypeScript data platform with REST and GraphQL APIs. Monorepo with pnpm workspaces. Tests use vitest."

    ISSUE_DETAILED="The qs query string parser has an arrayLimit default of 20. When the app \
sends field selections as array syntax (fields[]=a&fields[]=b&...), any collection with more \
than 20 selected fields silently drops all field selections. This causes blank items in the \
admin app and 'Unexpected error' in O2M relation fields. Fix the field selection to work with \
any number of fields, both in API request parsing and in the app's HTTP requests. Add tests."

    ISSUE_OPAQUE="After upgrading to 11.15.0, many collections show blank items in the admin \
panel. Clicking an item shows 'page not found' with 'undefined' as the item key in the URL. \
Some O2M relation fields show 'Unexpected error'. The items still exist (accessible via direct \
URL with a known key). Recreating bookmarks fixes them, but there are too many to redo. The \
console shows: TypeError: ye is not an Object (evaluating '\"\$type\" in ye'). Not all \
collections are affected. Fix the bug and add tests."
    ;;
  nestjs)
    REPO="nestjs/nest"
    COMMIT="ae0517b364cb79b21c386a89588dc3bd34e42395"
    ISSUE_TAG="#13910 (WebSocket shutdown hang)"
    INSTALL_CMD="npm ci --legacy-peer-deps"
    MAX_BUDGET="5.00"

    PLACEBO_TEXT="# nest
A TypeScript server framework. Tests use mocha. Monorepo with packages/ directory."

    ISSUE_DETAILED="The AbstractWsAdapter.close() method in packages/websockets/adapters/ws-adapter.ts \
unconditionally calls server.close() on the Socket.IO server during shutdown. Socket.IO internally \
calls close() on the underlying HTTP server, which blocks until all HTTP connections are closed. \
This happens before the Express adapter's closeConnections() is reached, so non-WebSocket \
long-running connections (like SSE) keep the HTTP server open forever. The fix requires passing \
the forceCloseConnections option from the application options to the WebSocket adapter and \
skipping the server.close() call when that flag is set. Fix the bug and add tests."

    ISSUE_OPAQUE="When a NestJS application uses WebSocket gateways alongside Server-Sent Events \
or other long-running HTTP connections, calling app.close() causes the application to hang \
indefinitely. The shutdown process never completes. The onApplicationShutdown lifecycle hooks on \
other providers are never called. This happens even when forceCloseConnections is set to true in \
the application options. Without WebSocket gateways, shutdown works correctly. Fix the bug and \
add tests."
    ;;
  typeorm)
    REPO="typeorm/typeorm"
    COMMIT="65dea3c0f562203fa729d1bed2775c11efa21845"
    ISSUE_TAG="#6326 (SQLite simple-enum array)"
    INSTALL_CMD="pnpm install"
    MAX_BUDGET="3.00"

    PLACEBO_TEXT="# TypeORM
A TypeScript ORM for Node.js. Supports many SQL databases. Tests use mocha."

    ISSUE_DETAILED="TypeORM's SQLite driver has three bugs with simple-enum columns when array: true. \
(1) In AbstractSqliteQueryRunner.buildCreateColumnSql(), the generated CHECK constraint validates \
against individual enum values, but stored values are comma-joined strings like '0,1' - skip CHECK \
generation when column.isArray is true. (2) In AbstractSqliteDriver.normalizeDefault(), array \
default values are not quoted - when the default is an array and type is simple-enum, join and wrap \
in quotes. (3) In DateUtils.simpleEnumToString() and DateUtils.stringToSimpleEnum(), arrays are not \
serialized/deserialized - join arrays with commas on write, split comma-separated strings and parse \
numeric values on read. Fix the bugs and add tests."

    ISSUE_OPAQUE="When using a simple-enum column with array: true on SQLite (or better-sqlite3), \
saving an entity fails with SQLITE_CONSTRAINT: CHECK constraint failed whenever the array contains \
more than one enum value. A single-element array works fine. After working around the CHECK \
constraint, saved arrays are returned as raw comma-separated strings (e.g. '0,1') instead of \
proper arrays (e.g. [0, 1]), and default values for these columns cause SQL syntax errors. Fix \
the bug and add tests."
    ;;
  *)
    echo "Unknown target: $TARGET"
    echo "Supported: TARGET=hono, TARGET=directus, TARGET=nestjs, or TARGET=typeorm"
    exit 1
    ;;
esac

# Select prompt based on OPAQUE env var
if [ "${OPAQUE:-}" = "1" ]; then
  ISSUE_TEXT="$ISSUE_OPAQUE"
  echo "Using OPAQUE prompt"
else
  ISSUE_TEXT="$ISSUE_DETAILED"
  echo "Using DETAILED prompt"
fi
echo "Target: $TARGET ($REPO @ ${COMMIT:0:8})"

ALLOWED_TOOLS="Read,Write,Edit,Glob,Grep,Bash"

# ── Paths ───────────────────────────────────────────────────────────
CONDITION="${CONDITION:-${1:-all}}"
BENCH_DIR="${2:-/tmp/clarte-bench-$(date +%Y%m%d-%H%M%S)}"
RESULTS_DIR="$BENCH_DIR/results"
CLARTE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLARTE_BIN="$CLARTE_ROOT/src/index.ts"
R7_ASSETS="$CLARTE_ROOT/scripts/r7-assets"

mkdir -p "$RESULTS_DIR"
echo "Benchmark dir: $BENCH_DIR"
echo "Results dir:   $RESULTS_DIR"
echo ""

# ── Helpers ─────────────────────────────────────────────────────────

clone_repo() {
  local target_dir="$1"
  echo "[$2] Cloning $REPO at ${COMMIT:0:8}..."
  git clone --quiet "https://github.com/$REPO.git" "$target_dir" 2>/dev/null
  (cd "$target_dir" && git checkout --quiet "$COMMIT")
  # Relax engine constraints if present (e.g. Directus requires Node 22)
  if [ -f "$target_dir/.npmrc" ]; then
    sed -i 's/engine-strict=true/engine-strict=false/' "$target_dir/.npmrc"
  fi
  echo "[$2] Installing deps..."
  (cd "$target_dir" && $INSTALL_CMD 2>/dev/null) || true
}

run_condition() {
  local name="$1"
  local work_dir="$2"
  local result_file="$RESULTS_DIR/${name}.json"

  echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
  (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
    --output-format json \
    --model "${MODEL:-sonnet}" \
    --max-budget-usd "$MAX_BUDGET" \
    --allowedTools "$ALLOWED_TOOLS" \
    --dangerously-skip-permissions \
    > "$result_file" 2>/dev/null) || true

  echo "[$name] Done. Result: $result_file"

  # Collect session log for clarte learn analysis
  collect_session_log "$name" "$work_dir" "$result_file"
}

collect_session_log() {
  local name="$1"
  local work_dir="$2"
  local result_file="$3"

  if [ ! -f "$result_file" ] || [ ! -s "$result_file" ]; then
    return
  fi

  # Extract session_id from result JSON
  local session_id
  session_id=$(node --eval "
    try {
      const d = require('$result_file');
      if (d.session_id) console.log(d.session_id);
    } catch {}
  " 2>/dev/null)

  if [ -z "$session_id" ]; then
    return
  fi

  # Compute Claude project dir: absolute path with / replaced by -
  local abs_work_dir
  abs_work_dir=$(cd "$work_dir" 2>/dev/null && pwd || echo "$work_dir")
  local project_dir_name
  project_dir_name=$(echo "$abs_work_dir" | sed 's|/|-|g')
  local log_src="$HOME/.claude/projects/${project_dir_name}/${session_id}.jsonl"

  if [ -f "$log_src" ]; then
    local log_dst="$RESULTS_DIR/${name}-session.jsonl"
    # For numbered runs, use the result file name pattern
    if [[ "$result_file" =~ -([0-9]+)\.json$ ]]; then
      local run_num="${BASH_REMATCH[1]}"
      log_dst="$RESULTS_DIR/${name}-${run_num}-session.jsonl"
    fi
    cp "$log_src" "$log_dst"
    echo "[$name] Session log: $log_dst"
  fi
}

extract_metrics() {
  local file="$1"
  if [ ! -f "$file" ] || [ ! -s "$file" ]; then
    echo "N/A|N/A|N/A|N/A"
    return
  fi

  # Use node instead of jq (jq may not be installed)
  node --eval '
const d = require(process.argv[1]);
const c = d.total_cost_usd ? d.total_cost_usd.toFixed(2) : "N/A";
// Aggregate tokens across all models (includes sub-agents)
const mu = d.modelUsage || {};
let cw = 0, cr = 0, o = 0;
for (const m of Object.values(mu)) {
  cw += m.cacheCreationInputTokens || 0;
  cr += m.cacheReadInputTokens || 0;
  o  += m.outputTokens || 0;
}
// Count actual assistant turns from session JSONL if available
const jsonlPath = process.argv[1].replace(/\.json$/, "-session.jsonl");
let turns = "N/A";
try {
  const lines = require("fs").readFileSync(jsonlPath, "utf8").split("\n").filter(Boolean);
  let n = 0;
  for (const l of lines) {
    try {
      const ev = JSON.parse(l);
      const content = ev?.message?.content;
      if (Array.isArray(content) && content.some(x => x.type === "tool_use" || x.type === "text")) {
        if (ev?.message?.role === "assistant") n++;
      }
    } catch {}
  }
  if (n > 0) turns = n;
} catch {}
console.log([turns, cw, cr, o, c].join("|"))
' "$file"
}

print_results() {
  echo ""
  echo "═══════════════════════════════════════════════════════════════"
  echo "  BENCHMARK RESULTS"
  echo "  Repo: $REPO @ ${COMMIT:0:8}"
  echo "  Issue: $ISSUE_TAG"
  echo "═══════════════════════════════════════════════════════════════"
  echo ""
  printf "%-14s | %6s | %13s | %12s | %13s | %8s\n" "Condition" "Turns" "Cache Write" "Cache Read" "Output Tokens" "Cost"
  printf "%-14s-|-%6s-|-%13s-|-%12s-|-%13s-|-%8s\n" "--------------" "------" "-------------" "------------" "-------------" "--------"

  for name in placebo clarte phone-book pointer direct direct-1 direct-2 direct-3 edit-targets pre-flight; do
    local file="$RESULTS_DIR/${name}.json"
    if [ -f "$file" ] && [ -s "$file" ]; then
      IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
      printf "%-14s | %6s | %13s | %12s | %13s | \$%s\n" "$name" "$turns" "$cw" "$cr" "$output" "$cost"
    fi
  done

  echo ""
  echo "Raw results in: $RESULTS_DIR/"
}

# ── Conditions ──────────────────────────────────────────────────────

run_placebo() {
  local work_dir="$BENCH_DIR/placebo"
  clone_repo "$work_dir" "placebo"

  echo "[placebo] Writing placebo CLAUDE.md..."
  echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"

  run_condition "placebo" "$work_dir"
}

run_clarte() {
  local work_dir="$BENCH_DIR/clarte"
  clone_repo "$work_dir" "clarte"

  # Pre-seed config to target Claude Code with TypeScript detection
  cat > "$work_dir/.clarte.json" << 'CLARTE_CFG_EOF'
{
  "_version": 2,
  "ides": ["claude"],
  "projectPurpose": "",
  "keyPatterns": "",
  "gotchas": "",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": true
}
CLARTE_CFG_EOF

  echo "[clarte] Running clarte --yes (budgeted output + hooks)..."
  (cd "$work_dir" && node "$CLARTE_ROOT/dist/index.js" --yes 2>/dev/null) || true

  run_condition "clarte" "$work_dir"
}

run_pointer() {
  local work_dir="$BENCH_DIR/pointer"
  clone_repo "$work_dir" "pointer"

  echo "[pointer] Running clarte --yes (full output to rules file)..."
  (cd "$work_dir" && npx tsx "$CLARTE_BIN" --yes 2>/dev/null) || true

  echo "[pointer] Replacing CLAUDE.md with pointer..."
  printf '%s\n\n%s\n' "$PLACEBO_TEXT" "If you need to discover which files to modify and the task doesn't tell you, read .claude/rules/clarte.md for a file index and architectural guide before searching." > "$work_dir/CLAUDE.md"

  run_condition "pointer" "$work_dir"
}

# ── Direct Variant Wordings ─────────────────────────────────────────

DIRECT_WORDING="Do not explore the codebase upfront. Based on the task description, go directly to the most likely files and start reading code. Only broaden your search if your first attempt doesn't find the relevant code."

DIRECT_1_WORDING="Read the single most relevant file first based on the task description, then fix the bug. Only search for more files if your first attempt fails."

DIRECT_2_WORDING="Do not use Grep or Glob to explore. Open the file most likely to contain the bug based on the task description. Fix it, then run tests."

DIRECT_3_WORDING="You have a \$0.30 budget. Be surgical: find the bug in as few file reads as possible."

write_direct_claude_md() {
  local work_dir="$1"
  local wording="$2"
  printf '%s\n\n%s\n' "$PLACEBO_TEXT" "$wording" > "$work_dir/CLAUDE.md"
}

run_direct() {
  local work_dir="$BENCH_DIR/direct"
  clone_repo "$work_dir" "direct"
  echo "[direct] Writing behavioral CLAUDE.md..."
  write_direct_claude_md "$work_dir" "$DIRECT_WORDING"
  run_condition "direct" "$work_dir"
}

run_direct_variant() {
  local variant="$1"
  local wording="$2"
  local work_dir="$BENCH_DIR/$variant"
  clone_repo "$work_dir" "$variant"
  echo "[$variant] Writing behavioral CLAUDE.md..."
  write_direct_claude_md "$work_dir" "$wording"
  run_condition "$variant" "$work_dir"
}

run_phone_book() {
  local work_dir="$BENCH_DIR/phone-book"
  clone_repo "$work_dir" "phone-book"

  echo "[phone-book] Running clarte --yes --include=file-index..."
  (cd "$work_dir" && npx tsx "$CLARTE_BIN" --yes \
    --include file-index,header,what-is-this,tech-stack \
    --exclude working-guidelines,key-files,circular-deps,architecture,package-dependencies,framework-hints,conventions,code-snapshot,hot-files,change-coupling,test-mapping,structure,monorepo-structure,dead-files,cross-cutting,chokepoints,tight-coupling,hidden-coupling,layer-consistency,key-patterns,gotchas,development,config-constraints \
    2>/dev/null) || true

  run_condition "phone-book" "$work_dir"
}

# ── R7 Condition Setup ─────────────────────────────────────────────
# Each function takes a work_dir (already cloned) and writes its CLAUDE.md / hooks.

setup_r7_culture() {
  local work_dir="$1"
  local culture
  culture="$(cat "$R7_ASSETS/culture-guide.txt" 2>/dev/null || echo '(run scripts/r7-setup.sh first)')"
  printf '%s\n\n## Code Style\n%s\n' "$PLACEBO_TEXT" "$culture" > "$work_dir/CLAUDE.md"
}

setup_r7_checklist() {
  local work_dir="$1"
  local checklist
  checklist="$(cat "$R7_ASSETS/checklist.md" 2>/dev/null || echo '(missing checklist.md)')"
  printf '%s\n\n%s\n' "$PLACEBO_TEXT" "$checklist" > "$work_dir/CLAUDE.md"
}

setup_r7_memory() {
  local work_dir="$1"
  printf '%s\n\n## Project Notes\n%s\n' "$PLACEBO_TEXT" "\
- JWT middleware lives in src/middleware/jwt/. The main verification logic is in jwt.ts.
- Test files mirror source structure under src/middleware/jwt/jwt.test.ts.
- When debugging crypto-related issues, check the algorithm selection logic carefully.
- The project uses a monorepo-like structure under src/ with middleware/, router/, utils/." > "$work_dir/CLAUDE.md"
}

setup_r7_hooks() {
  local work_dir="$1"
  # Write placebo CLAUDE.md (hooks provide the context instead)
  echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"

  # Copy hook script and map into the repo
  mkdir -p "$work_dir/.clarte/hooks"
  cp "$R7_ASSETS/on-read.mjs" "$work_dir/.clarte/hooks/on-read.mjs"
  cp "$R7_ASSETS/hook-map.json" "$work_dir/.clarte/hooks/hook-map.json"

  # Write .claude/settings.json with PreToolUse hook
  mkdir -p "$work_dir/.claude"
  cat > "$work_dir/.claude/settings.json" << 'SETTINGS_EOF'
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Read",
      "hooks": [{ "type": "command", "command": "node .clarte/hooks/on-read.mjs" }]
    }]
  }
}
SETTINGS_EOF
}

setup_fail_fast() {
  local work_dir="$1"
  # Placebo CLAUDE.md (testing hook only, not clarte content)
  echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"

  # Write the fail-fast hook script
  mkdir -p "$work_dir/.clarte/hooks"
  cat > "$work_dir/.clarte/hooks/on-fail-fast.mjs" << 'HOOK_EOF'
#!/usr/bin/env node
// Generated by clarte - do not edit
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";

let input;
try { input = JSON.parse(readFileSync("/dev/stdin", "utf-8")); } catch { process.exit(0); }
const tool = input.tool_name;
if (!tool) process.exit(0);

const STATE_DIR = ".clarte/hooks/.state";
const STATE_FILE = STATE_DIR + "/fail-fast.json";
const THRESHOLD = 3;
const TEST_RE = /\b(npm\s+test|npm\s+run\s+test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+(run\s+)?test|npx\s+(vitest|jest|mocha)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test)\b/;

function readState() {
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")); } catch { return { base: "", count: 0 }; }
}

function writeState(state) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(STATE_FILE, JSON.stringify(state)); } catch {}
}

function extractBase(cmd) {
  return cmd.split("|")[0].replace(/\s*2>&1\s*$/, "").trim();
}

if (tool !== "Bash" && tool !== "Edit" && tool !== "Write") process.exit(0);

if (existsSync(".clarte/fail-fast-override")) process.exit(0);

if (tool === "Edit" || tool === "Write") {
  writeState({ base: "", count: 0 });
  process.exit(0);
}

if (tool === "Bash") {
  const cmd = input.tool_input?.command || "";
  if (TEST_RE.test(cmd)) {
    const base = extractBase(cmd);
    const state = readState();
    if (state.base === base) {
      state.count += 1;
    } else {
      state.base = base;
      state.count = 1;
    }
    writeState(state);
    if (state.count >= THRESHOLD) {
      const output = JSON.stringify({
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: "Blocked: you have run the same test command " + state.count + " times with no code edits in between. The test output will not change. Re-read the existing output and try a different fix, or create .clarte/fail-fast-override to disable this check."
        }
      });
      process.stdout.write(output);
      process.exit(0);
    }
  }
  // Non-test Bash (grep, cat, git) does NOT reset the counter.
  // Only Edit/Write resets, because the agent actually tried a fix.
}
HOOK_EOF

  # Write .claude/settings.json with the hook
  mkdir -p "$work_dir/.claude"
  cat > "$work_dir/.claude/settings.json" << 'SETTINGS_EOF'
{
  "hooks": {
    "PreToolUse": [{
      "hooks": [{ "type": "command", "command": "node .clarte/hooks/on-fail-fast.mjs" }]
    }]
  }
}
SETTINGS_EOF
}

# ── Kill Gate ──────────────────────────────────────────────────────
# Compares experimental vs placebo cost after each run.
# Returns 0 (continue) or 1 (kill). Threshold: +20% cost.

check_kill_gate() {
  local placebo_file="$1"
  local exp_file="$2"
  local run_num="$3"

  if [ ! -f "$placebo_file" ] || [ ! -s "$placebo_file" ] || [ ! -f "$exp_file" ] || [ ! -s "$exp_file" ]; then
    echo "CONTINUE|Run $run_num: missing result file, continuing"
    return 0
  fi

  node --eval "
    const fs = require('fs');
    try {
      const p = JSON.parse(fs.readFileSync('$placebo_file', 'utf8'));
      const e = JSON.parse(fs.readFileSync('$exp_file', 'utf8'));
      const pc = p.total_cost_usd || 0;
      const ec = e.total_cost_usd || 0;
      const pt = p.num_turns || 0;
      const et = e.num_turns || 0;
      if (pc === 0) { console.log('CONTINUE|placebo cost is 0'); process.exit(0); }
      const delta = ((ec - pc) / pc * 100).toFixed(1);
      const msg = 'Run $run_num: placebo=' + pt + 't/\$' + pc.toFixed(2) + ', exp=' + et + 't/\$' + ec.toFixed(2) + ' (cost delta: ' + delta + '%)';
      if (ec > pc * 1.20) {
        console.log('KILL|' + msg);
      } else {
        console.log('CONTINUE|' + msg);
      }
    } catch (e) {
      console.log('CONTINUE|parse error: ' + e.message);
    }
  " 2>/dev/null
}

# Analyze session transcript for hook engagement and test patterns.
# Reads the JSONL transcript and counts test commands, Bash calls,
# Edit/Write calls, and hook deny blocks per condition.
check_hook_engagement() {
  local placebo_log_dir="$1"
  local exp_log_dir="$2"
  local run_num="$3"

  node - "$placebo_log_dir" "$exp_log_dir" "$run_num" << 'ENGAGE_EOF'
    const fs = require('fs');
    const path = require('path');
    const [,, placeboDir, expDir, runNum] = process.argv;

    const TEST_RE = /\b(npm\s+test|npm\s+run\s+test|pnpm\s+(run\s+)?test|yarn\s+test|bun\s+(run\s+)?test|npx\s+(vitest|jest|mocha)|vitest|jest|mocha|pytest|cargo\s+test|go\s+test)\b/;

    function analyze(dir) {
      let files;
      try { files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')); } catch { return null; }
      if (!files.length) return null;
      const lines = fs.readFileSync(path.join(dir, files[0]), 'utf8').split('\n').filter(Boolean);

      let testCmds = 0, bashCalls = 0, edits = 0, reads = 0, blocks = 0;
      for (const line of lines) {
        const d = JSON.parse(line);
        if (d.type === 'assistant') {
          for (const b of (d.message?.content || [])) {
            if (b?.type !== 'tool_use') continue;
            if (b.name === 'Bash') {
              bashCalls++;
              if (TEST_RE.test(b.input?.command || '')) testCmds++;
            }
            if (b.name === 'Edit' || b.name === 'Write') edits++;
            if (b.name === 'Read') reads++;
          }
        }
        if (d.type === 'user') {
          const content = d.message?.content;
          const text = typeof content === 'string' ? content : JSON.stringify(content || '');
          if (text.includes('same test command') && text.includes('Blocked')) blocks++;
        }
      }
      return { testCmds, bashCalls, edits, reads, blocks };
    }

    const p = analyze(placeboDir);
    const e = analyze(expDir);

    if (!p || !e) { console.log('  (transcript not available)'); process.exit(0); }

    const hookFired = e.blocks > 0;
    console.log('  placebo: ' + p.reads + ' reads, ' + p.edits + ' edits, ' + p.bashCalls + ' bash (' + p.testCmds + ' test)');
    console.log('  exp:     ' + e.reads + ' reads, ' + e.edits + ' edits, ' + e.bashCalls + ' bash (' + e.testCmds + ' test), ' + e.blocks + ' blocks');
    console.log('  hook engaged: ' + (hookFired ? 'YES (' + e.blocks + ' blocks)' : 'NO (threshold not reached, ' + e.testCmds + ' test cmds)'));
ENGAGE_EOF
}

setup_r7_cochange() {
  local work_dir="$1"
  local pairs
  pairs="$(cat "$R7_ASSETS/cochange-pairs.txt" 2>/dev/null || echo '(run scripts/r7-setup.sh first)')"
  printf '%s\n\n## Files that change together\n%s\n' "$PLACEBO_TEXT" "$pairs" > "$work_dir/CLAUDE.md"
}

# ── Edit-Targets Condition ─────────────────────────────────────────
# Uses clarte's persisted graph to resolve edit targets from the issue text,
# then injects them via --append-system-prompt. CLAUDE.md is placebo only.

run_edit_targets() {
  local work_dir="$BENCH_DIR/edit-targets"
  clone_repo "$work_dir" "edit-targets"

  # Write placebo CLAUDE.md (directive comes via --append-system-prompt)
  echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"

  # Generate the graph
  cat > "$work_dir/.clarte.json" << 'CLARTE_CFG_EOF'
{
  "_version": 2,
  "ides": ["claude"],
  "projectPurpose": "",
  "keyPatterns": "",
  "gotchas": "",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": true
}
CLARTE_CFG_EOF

  echo "[edit-targets] Running clarte --yes to generate graph..."
  (cd "$work_dir" && node "$CLARTE_ROOT/dist/index.js" --yes 2>/dev/null) || true

  # Resolve targets using the graph (write temp .mts file for top-level await support)
  local resolve_script="$work_dir/_resolve-targets.mts"
  cat > "$resolve_script" << RESOLVE_EOF
import { loadPersistedGraph } from "$CLARTE_ROOT/src/graph/persist.ts";
import { resolveEditTargets } from "$CLARTE_ROOT/src/cli/resolve-targets.ts";
import { formatEditDirective } from "$CLARTE_ROOT/src/cli/format-directive.ts";
const graph = await loadPersistedGraph("$work_dir");
if (!graph) process.exit(0);
const targets = resolveEditTargets(process.argv[2], graph);
const d = formatEditDirective(targets);
if (d) process.stdout.write(d);
RESOLVE_EOF

  local directive resolve_stderr
  resolve_stderr=$(mktemp)
  directive=$(npx tsx "$resolve_script" "$ISSUE_TEXT" 2>"$resolve_stderr") || true
  if [ -s "$resolve_stderr" ]; then
    echo "[edit-targets] Resolve stderr: $(cat "$resolve_stderr")"
  fi
  rm -f "$resolve_script" "$resolve_stderr"

  local result_file="$RESULTS_DIR/edit-targets.json"

  if [ -n "$directive" ]; then
    echo "[edit-targets] Directive: $directive"
    echo "[edit-targets] Running claude -p with --append-system-prompt (budget \$$MAX_BUDGET)..."
    (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
      --output-format json \
      --model "${MODEL:-sonnet}" \
      --max-budget-usd "$MAX_BUDGET" \
      --allowedTools "$ALLOWED_TOOLS" \
      --dangerously-skip-permissions \
      --append-system-prompt "$directive" \
      > "$result_file" 2>/dev/null) || true
  else
    echo "[edit-targets] No targets resolved, running plain claude -p..."
    (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
      --output-format json \
      --model "${MODEL:-sonnet}" \
      --max-budget-usd "$MAX_BUDGET" \
      --allowedTools "$ALLOWED_TOOLS" \
      --dangerously-skip-permissions \
      > "$result_file" 2>/dev/null) || true
  fi

  echo "[edit-targets] Done. Result: $result_file"
  collect_session_log "edit-targets" "$work_dir" "$result_file"
}

run_pre_flight() {
  local work_dir="$BENCH_DIR/pre-flight"
  clone_repo "$work_dir" "pre-flight"

  # Generate graph + hooks
  cat > "$work_dir/.clarte.json" << 'CLARTE_CFG_EOF'
{
  "_version": 2,
  "ides": ["claude"],
  "projectPurpose": "",
  "keyPatterns": "",
  "gotchas": "",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": true
}
CLARTE_CFG_EOF

  echo "[pre-flight] Running clarte --yes to generate graph + hooks..."
  (cd "$work_dir" && node "$CLARTE_ROOT/dist/index.js" --yes 2>/dev/null) || true

  # Resolve targets and write task-context.md to arm the gate
  local resolve_script="$work_dir/_resolve-targets.mts"
  cat > "$resolve_script" << RESOLVE_EOF
import { loadPersistedGraph } from "$CLARTE_ROOT/src/graph/persist.ts";
import { resolveEditTargets } from "$CLARTE_ROOT/src/cli/resolve-targets.ts";
const graph = await loadPersistedGraph("$work_dir");
if (!graph) process.exit(0);
const targets = resolveEditTargets(process.argv[2], graph);
if (targets.length > 0) process.stdout.write(targets.join("\n"));
RESOLVE_EOF

  local targets resolve_stderr
  resolve_stderr=$(mktemp)
  targets=$(npx tsx "$resolve_script" "$ISSUE_TEXT" 2>"$resolve_stderr") || true
  if [ -s "$resolve_stderr" ]; then
    echo "[pre-flight] Resolve stderr: $(cat "$resolve_stderr")"
  fi
  rm -f "$resolve_script" "$resolve_stderr"

  local result_file="$RESULTS_DIR/pre-flight.json"

  if [ -n "$targets" ]; then
    echo "[pre-flight] Targets resolved:"
    echo "$targets" | sed 's/^/  - /'

    # Find test files that reference the target source files
    local test_files=""
    for target in $targets; do
      local base
      base=$(basename "$target" .ts)
      local matches
      matches=$(grep -rl "$base" "$work_dir" --include="*.ts" 2>/dev/null \
        | grep -E "(test|spec|__tests__|github-issues)" \
        | grep -v "node_modules" | head -2) || true
      if [ -n "$matches" ]; then
        test_files=$(printf "%s\n%s" "$test_files" "$matches")
      fi
    done
    test_files=$(echo "$test_files" | sort -u | grep -v "^$" | \
      sed "s|$work_dir/||") || true

    # Write task-context.md to arm the pre-flight gate
    mkdir -p "$work_dir/.clarte"
    {
      echo "# Task"
      echo ""
      echo "$ISSUE_TEXT"
      echo ""
      echo "# Source files to edit"
      echo ""
      echo "Based on dependency graph analysis, these files are most likely to need editing:"
      echo ""
      echo "$targets" | sed 's/^/- /'
      if [ -n "$test_files" ]; then
        echo ""
        echo "# Test files"
        echo ""
        echo "These tests must pass after your edits:"
        echo ""
        echo "$test_files" | sed 's/^/- /'
      fi
    } > "$work_dir/.clarte/task-context.md"

    if [ -n "$test_files" ]; then
      echo "[pre-flight] Test files found:"
      echo "$test_files" | sed 's/^/  - /'
    fi

    echo "[pre-flight] Running claude -p with pre-flight gate (budget \$$MAX_BUDGET)..."
    (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
      --output-format json \
      --model "${MODEL:-sonnet}" \
      --max-budget-usd "$MAX_BUDGET" \
      --allowedTools "$ALLOWED_TOOLS,Agent" \
      --dangerously-skip-permissions \
      > "$result_file" 2>/dev/null) || true
  else
    echo "[pre-flight] No targets resolved, running plain claude -p..."
    (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
      --output-format json \
      --model "${MODEL:-sonnet}" \
      --max-budget-usd "$MAX_BUDGET" \
      --allowedTools "$ALLOWED_TOOLS" \
      --dangerously-skip-permissions \
      > "$result_file" 2>/dev/null) || true
  fi

  echo "[pre-flight] Done. Result: $result_file"
  collect_session_log "pre-flight" "$work_dir" "$result_file"
}

# ── Main ────────────────────────────────────────────────────────────

RUNS="${RUNS:-1}"

case "$CONDITION" in
  placebo)    run_placebo; print_results ;;
  clarte)     run_clarte; print_results ;;
  phone-book) run_phone_book; print_results ;;
  pointer)    run_pointer; print_results ;;
  direct-1)   run_direct_variant "direct-1" "$DIRECT_1_WORDING"; print_results ;;
  direct-2)   run_direct_variant "direct-2" "$DIRECT_2_WORDING"; print_results ;;
  direct-3)   run_direct_variant "direct-3" "$DIRECT_3_WORDING"; print_results ;;
  edit-targets) run_edit_targets; print_results ;;
  pre-flight) run_pre_flight; print_results ;;
  parallel)
    for i in $(seq 1 "$RUNS"); do
      echo ""
      echo "════════════════════ Run $i of $RUNS ════════════════════"
      RUN_BENCH="$BENCH_DIR/run-$i"
      mkdir -p "$RUN_BENCH"

      run_parallel_condition() {
        local name="$1"
        local wording="$2"
        local work_dir="$RUN_BENCH/$name"
        clone_repo "$work_dir" "$name"
        echo "[$name] Writing CLAUDE.md..."
        if [ -z "$wording" ]; then
          echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"
        else
          write_direct_claude_md "$work_dir" "$wording"
        fi
        local result_file="$RESULTS_DIR/${name}-${i}.json"
        echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
        (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
          --output-format json \
          --model "${MODEL:-sonnet}" \
          --max-budget-usd "$MAX_BUDGET" \
          --allowedTools "$ALLOWED_TOOLS" \
          --dangerously-skip-permissions \
          > "$result_file" 2>/dev/null) || true
        echo "[$name] Run $i done."
      }

      run_parallel_condition "placebo" "" &
      run_parallel_condition "direct-1" "$DIRECT_1_WORDING" &
      run_parallel_condition "direct-2" "$DIRECT_2_WORDING" &
      run_parallel_condition "direct-3" "$DIRECT_3_WORDING" &
      wait

      # Clean up cloned repos to save disk
      rm -rf "$RUN_BENCH"
    done

    # Print aggregate results
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  AGGREGATE RESULTS ($RUNS runs)"
    echo "  Repo: $REPO @ ${COMMIT:0:8}"
    echo "  Issue: $ISSUE_TAG"
    echo "  Model: ${MODEL:-sonnet}"
    if [ "${OPAQUE:-}" = "1" ]; then echo "  Prompt: opaque"; else echo "  Prompt: detailed"; fi
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    printf "%-10s | %4s | %6s | %8s\n" "Condition" "Run" "Turns" "Cost"
    printf "%-10s-|-%4s-|-%6s-|-%8s\n" "----------" "----" "------" "--------"

    for name in placebo direct-1 direct-2 direct-3; do
      for j in $(seq 1 "$RUNS"); do
        file="$RESULTS_DIR/${name}-${j}.json"
        if [ -f "$file" ] && [ -s "$file" ]; then
          IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
          printf "%-10s | %4s | %6s | \$%s\n" "$name" "$j" "$turns" "$cost"
        fi
      done
    done

    # Print averages
    echo ""
    printf "%-10s | %10s | %10s\n" "Condition" "Avg Turns" "Avg Cost"
    printf "%-10s-|-%10s-|-%10s\n" "----------" "----------" "----------"
    for name in placebo direct-1 direct-2 direct-3; do
      node --eval "
        const fs = require('fs');
        let turns = [], costs = [];
        for (let j = 1; j <= $RUNS; j++) {
          const f = '$RESULTS_DIR/${name}-' + j + '.json';
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.num_turns) turns.push(d.num_turns);
            if (d.total_cost_usd) costs.push(d.total_cost_usd);
          } catch {}
        }
        if (turns.length === 0) { console.log('$name'.padEnd(10) + ' |        N/A |        N/A'); }
        else {
          const at = (turns.reduce((a,b)=>a+b,0)/turns.length).toFixed(1);
          const ac = (costs.reduce((a,b)=>a+b,0)/costs.length).toFixed(2);
          console.log('$name'.padEnd(10) + ' | ' + at.padStart(10) + ' | ' + ('\$'+ac).padStart(10));
        }
      " 2>/dev/null || true
    done
    echo ""
    ;;
  r7)
    R7_CONDITIONS="placebo direct-2 culture checklist memory hooks cochange"

    for i in $(seq 1 "$RUNS"); do
      echo ""
      echo "════════════════════ Run $i of $RUNS ════════════════════"
      RUN_BENCH="$BENCH_DIR/run-$i"
      mkdir -p "$RUN_BENCH"

      run_r7_single() {
        local name="$1"
        local work_dir="$RUN_BENCH/$name"
        clone_repo "$work_dir" "$name"

        case "$name" in
          placebo)
            echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"
            ;;
          direct-2)
            write_direct_claude_md "$work_dir" "$DIRECT_2_WORDING"
            ;;
          culture)   setup_r7_culture "$work_dir" ;;
          checklist) setup_r7_checklist "$work_dir" ;;
          memory)    setup_r7_memory "$work_dir" ;;
          hooks)     setup_r7_hooks "$work_dir" ;;
          cochange)  setup_r7_cochange "$work_dir" ;;
        esac

        local result_file="$RESULTS_DIR/${name}-${i}.json"
        echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
        (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
          --output-format json \
          --model "${MODEL:-sonnet}" \
          --max-budget-usd "$MAX_BUDGET" \
          --allowedTools "$ALLOWED_TOOLS" \
          --dangerously-skip-permissions \
          > "$result_file" 2>/dev/null) || true
        echo "[$name] Run $i done."
      }

      for cond in $R7_CONDITIONS; do
        run_r7_single "$cond" &
      done
      wait

      # Clean up cloned repos to save disk
      rm -rf "$RUN_BENCH"
    done

    # Print aggregate results
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  R7 FIVE-DIMENSIONS RESULTS ($RUNS runs)"
    echo "  Repo: $REPO @ ${COMMIT:0:8}"
    echo "  Issue: $ISSUE_TAG"
    echo "  Model: ${MODEL:-sonnet}"
    if [ "${OPAQUE:-}" = "1" ]; then echo "  Prompt: opaque"; else echo "  Prompt: detailed"; fi
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    printf "%-10s | %4s | %6s | %8s\n" "Condition" "Run" "Turns" "Cost"
    printf "%-10s-|-%4s-|-%6s-|-%8s\n" "----------" "----" "------" "--------"

    for name in $R7_CONDITIONS; do
      for j in $(seq 1 "$RUNS"); do
        file="$RESULTS_DIR/${name}-${j}.json"
        if [ -f "$file" ] && [ -s "$file" ]; then
          IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
          printf "%-10s | %4s | %6s | \$%s\n" "$name" "$j" "$turns" "$cost"
        fi
      done
    done

    # Print averages
    echo ""
    printf "%-10s | %10s | %10s\n" "Condition" "Avg Turns" "Avg Cost"
    printf "%-10s-|-%10s-|-%10s\n" "----------" "----------" "----------"
    for name in $R7_CONDITIONS; do
      node --eval "
        const fs = require('fs');
        let turns = [], costs = [];
        for (let j = 1; j <= $RUNS; j++) {
          const f = '$RESULTS_DIR/${name}-' + j + '.json';
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.num_turns) turns.push(d.num_turns);
            if (d.total_cost_usd) costs.push(d.total_cost_usd);
          } catch {}
        }
        if (turns.length === 0) { console.log('$name'.padEnd(10) + ' |        N/A |        N/A'); }
        else {
          const at = (turns.reduce((a,b)=>a+b,0)/turns.length).toFixed(1);
          const ac = (costs.reduce((a,b)=>a+b,0)/costs.length).toFixed(2);
          console.log('$name'.padEnd(10) + ' | ' + at.padStart(10) + ' | ' + ('\$'+ac).padStart(10));
        }
      " 2>/dev/null || true
    done
    echo ""
    ;;
  ab)
    AB_CONDITIONS="placebo clarte"

    # Auto-detect starting run number from existing results
    START_RUN=1
    while [ -f "$RESULTS_DIR/placebo-${START_RUN}.json" ] && [ -s "$RESULTS_DIR/placebo-${START_RUN}.json" ]; do
      START_RUN=$((START_RUN + 1))
    done
    TOTAL_RUNS=$((START_RUN + RUNS - 1))
    if [ "$START_RUN" -gt 1 ]; then
      echo "Found existing results up to run $((START_RUN - 1)), starting at run $START_RUN"
    fi

    for i in $(seq "$START_RUN" "$TOTAL_RUNS"); do
      echo ""
      echo "════════════════════ Run $i of $RUNS ════════════════════"
      RUN_BENCH="$BENCH_DIR/run-$i"
      mkdir -p "$RUN_BENCH"

      run_ab_single() {
        local name="$1"
        local work_dir="$RUN_BENCH/$name"
        clone_repo "$work_dir" "$name"

        case "$name" in
          placebo)
            echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"
            ;;
          clarte)
            # Pre-seed config targeting Claude Code
            cat > "$work_dir/.clarte.json" << 'CLARTE_CFG_EOF'
{
  "_version": 2,
  "ides": ["claude"],
  "projectPurpose": "",
  "keyPatterns": "",
  "gotchas": "",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": true
}
CLARTE_CFG_EOF
            echo "[clarte] Running clarte --yes (budgeted output + hooks)..."
            (cd "$work_dir" && node "$CLARTE_ROOT/dist/index.js" --yes 2>/dev/null) || true
            ;;
        esac

        local result_file="$RESULTS_DIR/${name}-${i}.json"
        echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
        (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
          --output-format json \
          --model "${MODEL:-sonnet}" \
          --max-budget-usd "$MAX_BUDGET" \
          --allowedTools "$ALLOWED_TOOLS" \
          --dangerously-skip-permissions \
          > "$result_file" 2>/dev/null) || true
        echo "[$name] Run $i done."
      }

      for cond in $AB_CONDITIONS; do
        run_ab_single "$cond" &
      done
      wait

      rm -rf "$RUN_BENCH"
    done

    # Print per-run results (scan all existing result files)
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  A/B RESULTS"
    echo "  Repo: $REPO @ ${COMMIT:0:8}"
    echo "  Issue: $ISSUE_TAG"
    echo "  Model: ${MODEL:-sonnet}"
    if [ "${OPAQUE:-}" = "1" ]; then echo "  Prompt: opaque"; else echo "  Prompt: detailed"; fi
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    printf "%-10s | %4s | %6s | %8s\n" "Condition" "Run" "Turns" "Cost"
    printf "%-10s-|-%4s-|-%6s-|-%8s\n" "----------" "----" "------" "--------"

    for name in $AB_CONDITIONS; do
      j=1
      while [ -f "$RESULTS_DIR/${name}-${j}.json" ]; do
        file="$RESULTS_DIR/${name}-${j}.json"
        if [ -s "$file" ]; then
          IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
          printf "%-10s | %4s | %6s | \$%s\n" "$name" "$j" "$turns" "$cost"
        fi
        j=$((j + 1))
      done
    done

    # Print averages
    echo ""
    printf "%-10s | %10s | %10s\n" "Condition" "Avg Turns" "Avg Cost"
    printf "%-10s-|-%10s-|-%10s\n" "----------" "----------" "----------"
    for name in $AB_CONDITIONS; do
      node --eval "
        const fs = require('fs');
        const path = require('path');
        let turns = [], costs = [];
        for (let j = 1; ; j++) {
          const f = '$RESULTS_DIR/${name}-' + j + '.json';
          if (!fs.existsSync(f)) break;
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.num_turns) turns.push(d.num_turns);
            if (d.total_cost_usd) costs.push(d.total_cost_usd);
          } catch {}
        }
        if (turns.length === 0) { console.log('$name'.padEnd(10) + ' |        N/A |        N/A'); }
        else {
          const n = turns.length;
          const at = (turns.reduce((a,b)=>a+b,0)/n).toFixed(1);
          const ac = (costs.reduce((a,b)=>a+b,0)/n).toFixed(2);
          console.log('$name'.padEnd(10) + ' | ' + (at+' (n='+n+')').padStart(10) + ' | ' + ('\$'+ac).padStart(10));
        }
      " 2>/dev/null || true
    done
    echo ""
    ;;
  r9)
    R9_CONDITIONS="placebo exp-E exp-D exp-F exp-C"

    for i in $(seq 1 "$RUNS"); do
      echo ""
      echo "════════════════════ Run $i of $RUNS ════════════════════"
      RUN_BENCH="$BENCH_DIR/run-$i"
      mkdir -p "$RUN_BENCH"

      run_r9_single() {
        local name="$1"
        local work_dir="$RUN_BENCH/$name"
        clone_repo "$work_dir" "$name"

        case "$name" in
          placebo)
            echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"
            ;;
          exp-*)
            local variant="${name#exp-}"
            # Pre-seed config targeting Claude Code
            cat > "$work_dir/.clarte.json" << 'CLARTE_CFG_EOF'
{
  "_version": 2,
  "ides": ["claude"],
  "projectPurpose": "",
  "keyPatterns": "",
  "gotchas": "",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": false
}
CLARTE_CFG_EOF
            echo "[$name] Running clarte --variant=$variant --yes..."
            (cd "$work_dir" && npx tsx "$CLARTE_BIN" --variant="$variant" --yes 2>/dev/null) || true
            ;;
        esac

        local result_file="$RESULTS_DIR/${name}-${i}.json"
        echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
        (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
          --output-format json \
          --model "${MODEL:-sonnet}" \
          --max-budget-usd "$MAX_BUDGET" \
          --allowedTools "$ALLOWED_TOOLS" \
          --dangerously-skip-permissions \
          > "$result_file" 2>/dev/null) || true
        echo "[$name] Run $i done."
      }

      for cond in $R9_CONDITIONS; do
        run_r9_single "$cond" &
      done
      wait

      rm -rf "$RUN_BENCH"
    done

    # Print aggregate results
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    echo "  R9 VARIANT RESULTS ($RUNS runs)"
    echo "  Repo: $REPO @ ${COMMIT:0:8}"
    echo "  Issue: $ISSUE_TAG"
    echo "  Model: ${MODEL:-sonnet}"
    if [ "${OPAQUE:-}" = "1" ]; then echo "  Prompt: opaque"; else echo "  Prompt: detailed"; fi
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    printf "%-10s | %4s | %6s | %8s\n" "Condition" "Run" "Turns" "Cost"
    printf "%-10s-|-%4s-|-%6s-|-%8s\n" "----------" "----" "------" "--------"

    for name in $R9_CONDITIONS; do
      for j in $(seq 1 "$RUNS"); do
        file="$RESULTS_DIR/${name}-${j}.json"
        if [ -f "$file" ] && [ -s "$file" ]; then
          IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
          printf "%-10s | %4s | %6s | \$%s\n" "$name" "$j" "$turns" "$cost"
        fi
      done
    done

    echo ""
    printf "%-10s | %10s | %10s\n" "Condition" "Avg Turns" "Avg Cost"
    printf "%-10s-|-%10s-|-%10s\n" "----------" "----------" "----------"
    for name in $R9_CONDITIONS; do
      node --eval "
        const fs = require('fs');
        let turns = [], costs = [];
        for (let j = 1; j <= $RUNS; j++) {
          const f = '$RESULTS_DIR/${name}-' + j + '.json';
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.num_turns) turns.push(d.num_turns);
            if (d.total_cost_usd) costs.push(d.total_cost_usd);
          } catch {}
        }
        if (turns.length === 0) { console.log('$name'.padEnd(10) + ' |        N/A |        N/A'); }
        else {
          const at = (turns.reduce((a,b)=>a+b,0)/turns.length).toFixed(1);
          const ac = (costs.reduce((a,b)=>a+b,0)/costs.length).toFixed(2);
          console.log('$name'.padEnd(10) + ' | ' + at.padStart(10) + ' | ' + ('\$'+ac).padStart(10));
        }
      " 2>/dev/null || true
    done
    echo ""
    ;;
  fail-fast-ab)
    FF_CONDITIONS="placebo fail-fast"

    # Auto-detect starting run number from existing results
    START_RUN=1
    while [ -f "$RESULTS_DIR/placebo-${START_RUN}.json" ] && [ -s "$RESULTS_DIR/placebo-${START_RUN}.json" ]; do
      START_RUN=$((START_RUN + 1))
    done
    TOTAL_RUNS=$((START_RUN + RUNS - 1))
    if [ "$START_RUN" -gt 1 ]; then
      echo "Found existing results up to run $((START_RUN - 1)), starting at run $START_RUN"
    fi

    KILLED=0
    for i in $(seq "$START_RUN" "$TOTAL_RUNS"); do
      echo ""
      echo "════════════════════ Run $i of $TOTAL_RUNS ════════════════════"
      RUN_BENCH="$BENCH_DIR/run-$i"
      mkdir -p "$RUN_BENCH"

      run_ff_single() {
        local name="$1"
        local work_dir="$RUN_BENCH/$name"
        clone_repo "$work_dir" "$name"

        case "$name" in
          placebo)
            echo "$PLACEBO_TEXT" > "$work_dir/CLAUDE.md"
            ;;
          fail-fast)
            setup_fail_fast "$work_dir"
            ;;
        esac

        local result_file="$RESULTS_DIR/${name}-${i}.json"
        echo "[$name] Running claude -p (budget \$$MAX_BUDGET)..."
        (cd "$work_dir" && env -u CLAUDECODE claude -p "$ISSUE_TEXT" \
          --output-format json \
          --model "${MODEL:-sonnet}" \
          --max-budget-usd "$MAX_BUDGET" \
          --allowedTools "$ALLOWED_TOOLS" \
          --dangerously-skip-permissions \
          > "$result_file" 2>/dev/null) || true
        echo "[$name] Run $i done."
        collect_session_log "$name" "$work_dir" "$result_file"
      }

      for cond in $FF_CONDITIONS; do
        run_ff_single "$cond" &
      done
      wait

      # ── Hook engagement + kill gate check ─────────────────────────
      echo ""
      echo "[engagement] Run $i:"
      # Session logs are in Claude's project dirs, keyed by the work dir path
      PLACEBO_PROJECT_DIR="$HOME/.claude/projects/$(echo "$RUN_BENCH/placebo" | sed 's|/|-|g')"
      EXP_PROJECT_DIR="$HOME/.claude/projects/$(echo "$RUN_BENCH/fail-fast" | sed 's|/|-|g')"
      check_hook_engagement "$PLACEBO_PROJECT_DIR" "$EXP_PROJECT_DIR" "$i"

      GATE_RESULT=$(check_kill_gate "$RESULTS_DIR/placebo-${i}.json" "$RESULTS_DIR/fail-fast-${i}.json" "$i")
      GATE_DECISION=$(echo "$GATE_RESULT" | cut -d'|' -f1)
      GATE_MSG=$(echo "$GATE_RESULT" | cut -d'|' -f2-)

      echo "[kill-gate] $GATE_MSG"

      if [ "$GATE_DECISION" = "KILL" ]; then
        echo ""
        echo "══════════════════════════════════════════════════════════════"
        echo "  KILL GATE TRIGGERED on run $i"
        echo "  Experimental cost exceeded placebo by >20%."
        echo "  Stopping benchmark. Rethink the approach."
        echo "══════════════════════════════════════════════════════════════"
        KILLED=1
        rm -rf "$RUN_BENCH"
        break
      fi

      rm -rf "$RUN_BENCH"
    done

    # Print results (all completed runs)
    echo ""
    echo "═══════════════════════════════════════════════════════════════"
    if [ "$KILLED" = "1" ]; then
      echo "  FAIL-FAST A/B RESULTS (killed after run $i)"
    else
      echo "  FAIL-FAST A/B RESULTS ($TOTAL_RUNS runs)"
    fi
    echo "  Repo: $REPO @ ${COMMIT:0:8}"
    echo "  Issue: $ISSUE_TAG"
    echo "  Model: ${MODEL:-sonnet}"
    if [ "${OPAQUE:-}" = "1" ]; then echo "  Prompt: opaque"; else echo "  Prompt: detailed"; fi
    echo "  Kill gate: +20% cost"
    echo "═══════════════════════════════════════════════════════════════"
    echo ""
    printf "%-10s | %4s | %6s | %8s\n" "Condition" "Run" "Turns" "Cost"
    printf "%-10s-|-%4s-|-%6s-|-%8s\n" "----------" "----" "------" "--------"

    for name in $FF_CONDITIONS; do
      j=1
      while [ -f "$RESULTS_DIR/${name}-${j}.json" ]; do
        file="$RESULTS_DIR/${name}-${j}.json"
        if [ -s "$file" ]; then
          IFS='|' read -r turns cw cr output cost <<< "$(extract_metrics "$file")"
          printf "%-10s | %4s | %6s | \$%s\n" "$name" "$j" "$turns" "$cost"
        fi
        j=$((j + 1))
      done
    done

    # Print averages
    echo ""
    printf "%-10s | %10s | %10s\n" "Condition" "Avg Turns" "Avg Cost"
    printf "%-10s-|-%10s-|-%10s\n" "----------" "----------" "----------"
    for name in $FF_CONDITIONS; do
      node --eval "
        const fs = require('fs');
        let turns = [], costs = [];
        for (let j = 1; ; j++) {
          const f = '$RESULTS_DIR/${name}-' + j + '.json';
          if (!fs.existsSync(f)) break;
          try {
            const d = JSON.parse(fs.readFileSync(f, 'utf8'));
            if (d.num_turns) turns.push(d.num_turns);
            if (d.total_cost_usd) costs.push(d.total_cost_usd);
          } catch {}
        }
        if (turns.length === 0) { console.log('$name'.padEnd(10) + ' |        N/A |        N/A'); }
        else {
          const n = turns.length;
          const at = (turns.reduce((a,b)=>a+b,0)/n).toFixed(1);
          const ac = (costs.reduce((a,b)=>a+b,0)/n).toFixed(2);
          console.log('$name'.padEnd(10) + ' | ' + (at+' (n='+n+')').padStart(10) + ' | ' + ('\$'+ac).padStart(10));
        }
      " 2>/dev/null || true
    done

    if [ "$KILLED" = "1" ]; then
      echo ""
      echo "  VERDICT: NO-GO (killed by automatic kill gate)"
    fi
    echo ""
    ;;
  all)
    run_placebo
    run_direct
    print_results
    ;;
  *)
    echo "Unknown condition: $CONDITION"
    echo "Usage: TARGET=hono|directus $0 [placebo|clarte|pointer|direct|direct-1|direct-2|direct-3|edit-targets|pre-flight|parallel|r7|r9|fail-fast-ab|all]"
    exit 1
    ;;
esac
