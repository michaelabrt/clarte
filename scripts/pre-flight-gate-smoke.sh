#!/usr/bin/env bash
# Pre-flight gate smoke test
#
# Verifies the deny-and-redirect mechanism end-to-end:
#   1. Gate fires when agent tries to Read with task-context.md present
#   2. Deny message redirects agent to spawn clarte-pre-flight
#   3. Agent tool enforces clarte-pre-flight (denies Explore etc.)
#
# Uses a tiny project + cheap task so the agent's natural first action is Read.
# Budget: ~$0.10 (haiku, single short session).
#
# Usage: bash scripts/pre-flight-gate-smoke.sh

set -euo pipefail

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

CLARTE_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
MODEL="${MODEL:-sonnet}"

WORK_DIR="/tmp/pre-flight-gate-smoke-$(date +%Y%m%d-%H%M%S)"
RESULTS_DIR="$WORK_DIR/results"
mkdir -p "$RESULTS_DIR"

echo "Pre-flight Gate Smoke Test"
echo "Model: $MODEL"
echo "Work dir: $WORK_DIR"
echo ""

# Must run outside Claude Code (nested sessions are blocked)
if [ -n "${CLAUDECODE:-}" ]; then
  echo "ERROR: Cannot run inside a Claude Code session (nested sessions crash)."
  echo "Run this script directly from a terminal: bash scripts/pre-flight-gate-smoke.sh"
  echo ""
  echo "Running hook unit tests only (no live session)..."
  UNIT_ONLY=1
fi
UNIT_ONLY="${UNIT_ONLY:-0}"


# ── Setup: minimal project ────────────────────────────────────────
PROJECT="$WORK_DIR/project"
mkdir -p "$PROJECT/src"

# Simple TypeScript file
cat > "$PROJECT/src/math.ts" << 'SRC'
export const add = (a: number, b: number): number => a + b;
export const multiply = (a: number, b: number): number => a * b;
export const MAX_VALUE = 1000;
SRC

cat > "$PROJECT/package.json" << 'PKG'
{"name":"math-utils","version":"1.0.0"}
PKG

# Install hooks directly by copying from clarte's own generated hooks
echo "Installing hooks..."
mkdir -p "$PROJECT/.clarte/hooks"
for hook in on-session-start.mjs on-pre-flight-gate.mjs on-pre-agent.mjs on-fail-fast.mjs on-prompt.mjs; do
  cp "$CLARTE_ROOT/.clarte/hooks/$hook" "$PROJECT/.clarte/hooks/$hook"
done
# clarte-pre-flight must be in ~/.claude/agents/ (user-global) to register as a subagent_type.
# Copy it there if not already present.
mkdir -p "$HOME/.claude/agents"
cp "$CLARTE_ROOT/.claude/agents/clarte-pre-flight.md" "$HOME/.claude/agents/clarte-pre-flight.md" 2>/dev/null || true
echo "  clarte-pre-flight agent: $([ -f "$HOME/.claude/agents/clarte-pre-flight.md" ] && echo 'installed' || echo 'MISSING')"

# Write settings.json with hook registrations
mkdir -p "$PROJECT/.claude"
cat > "$PROJECT/.claude/settings.json" << 'SETTINGS'
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "command", "command": "node .clarte/hooks/on-session-start.mjs"}]}],
    "PreToolUse": [
      {"matcher": "Read|Grep|Glob|Bash", "hooks": [{"type": "command", "command": "node .clarte/hooks/on-pre-flight-gate.mjs"}]},
      {"hooks": [{"type": "command", "command": "node .clarte/hooks/on-fail-fast.mjs"}]},
      {"matcher": "Agent", "hooks": [{"type": "command", "command": "node .clarte/hooks/on-pre-agent.mjs"}]}
    ],
    "UserPromptSubmit": [{"hooks": [{"type": "command", "command": "node .clarte/hooks/on-prompt.mjs"}]}]
  }
}
SETTINGS

# Write task-context.md to arm the gate (oracle condition)
mkdir -p "$PROJECT/.clarte"
cat > "$PROJECT/.clarte/task-context.md" << 'CTX'
# Edit targets (clarte)

Based on past fixes to similar issues, these files are most likely to need editing:

- src/math.ts

Matched commit: fix: correct arithmetic operations
CTX

# Write a minimal CLAUDE.md
echo "# math-utils
A tiny TypeScript math utility library." > "$PROJECT/CLAUDE.md"

# ── Hook unit tests (run without a live session) ────────────────────
PASS=0
FAIL=0

check() {
  local label="$1" got="$2" want="$3"
  if [ "$got" = "$want" ]; then
    echo "  PASS: $label"
    PASS=$((PASS+1))
  else
    echo "  FAIL: $label (got '$got', want '$want')"
    FAIL=$((FAIL+1))
  fi
}

GATE="$PROJECT/.clarte/hooks/on-pre-flight-gate.mjs"
AGENT_HOOK="$PROJECT/.clarte/hooks/on-pre-agent.mjs"

make_input() { cat > /tmp/smoke-input.json; }
get_decision() { node "$1" < /tmp/smoke-input.json 2>/dev/null | python3 -c "import json,sys; d=json.load(sys.stdin); print(d.get('hookSpecificOutput',{}).get('permissionDecision',''))" 2>/dev/null || echo ""; }

echo "Hook unit tests:"

# Gate: no task-context.md -> allow
rm -f "$PROJECT/.clarte/task-context.md"
echo '{"tool_name":"Read","tool_input":{"file_path":"src/math.ts"},"cwd":"'"$PROJECT"'"}' | make_input
check "gate: no task-context.md -> allow" "$(get_decision "$GATE")" ""

# Gate: task-context.md exists, no marker -> deny
echo "# targets" > "$PROJECT/.clarte/task-context.md"
echo '{"tool_name":"Read","tool_input":{"file_path":"src/math.ts"},"cwd":"'"$PROJECT"'"}' | make_input
check "gate: task-context.md + no marker -> deny" "$(get_decision "$GATE")" "deny"

# Gate: marker exists -> allow
mkdir -p "$PROJECT/.clarte/hooks/.state"
echo "done" > "$PROJECT/.clarte/hooks/.state/pre-flight-done"
echo '{"tool_name":"Read","tool_input":{"file_path":"src/math.ts"},"cwd":"'"$PROJECT"'"}' | make_input
check "gate: marker exists -> allow" "$(get_decision "$GATE")" ""

# Gate: non-gated Bash -> allow
rm "$PROJECT/.clarte/hooks/.state/pre-flight-done"
echo '{"tool_name":"Bash","tool_input":{"command":"ls -la"},"cwd":"'"$PROJECT"'"}' | make_input
check "gate: Bash ls -> allow" "$(get_decision "$GATE")" ""

# Gate: Bash cat .ts -> deny
echo '{"tool_name":"Bash","tool_input":{"command":"cat src/math.ts"},"cwd":"'"$PROJECT"'"}' | make_input
check "gate: Bash cat .ts -> deny" "$(get_decision "$GATE")" "deny"

# Agent hook: Explore when gate armed -> deny
echo '{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"explore"},"cwd":"'"$PROJECT"'"}' | make_input
check "agent: Explore when armed -> deny" "$(get_decision "$AGENT_HOOK")" "deny"

# Agent hook: clarte-pre-flight when gate armed -> allow + write marker
rm -f "$PROJECT/.clarte/hooks/.state/pre-flight-done"
echo '{"tool_name":"Agent","tool_input":{"subagent_type":"clarte-pre-flight","prompt":"run"},"cwd":"'"$PROJECT"'"}' | make_input
OUT=$(node "$AGENT_HOOK" < /tmp/smoke-input.json 2>/dev/null)
MARKER=$([ -f "$PROJECT/.clarte/hooks/.state/pre-flight-done" ] && echo yes || echo no)
check "agent: clarte-pre-flight -> allow" "$OUT" ""
check "agent: clarte-pre-flight -> writes marker" "$MARKER" "yes"

# Agent hook: gate disarmed (no task-context) -> any agent allowed
rm "$PROJECT/.clarte/task-context.md"
echo '{"tool_name":"Agent","tool_input":{"subagent_type":"Explore","prompt":"explore"},"cwd":"'"$PROJECT"'"}' | make_input
check "agent: no task-context -> Explore allowed" "$(get_decision "$AGENT_HOOK")" ""

echo ""
echo "  Unit tests: $PASS passed, $FAIL failed"
echo ""

if [ "$FAIL" -gt 0 ]; then
  echo "Unit tests FAILED. Aborting live session."
  exit 1
fi

if [ "$UNIT_ONLY" = "1" ]; then
  echo "Unit tests complete. Run outside Claude Code for full live session test."
  exit 0
fi

# Re-arm the gate for the live session
echo "# Edit targets" > "$PROJECT/.clarte/task-context.md"
echo "- src/math.ts" >> "$PROJECT/.clarte/task-context.md"
rm -f "$PROJECT/.clarte/hooks/.state/pre-flight-done"

echo "Gate armed. Running session..."
echo ""

# Task: simple enough that agent's first instinct is to Read the file
TASK="The add function in src/math.ts should throw a RangeError when either argument exceeds MAX_VALUE. Add this validation."

# Run session
(cd "$PROJECT" && claude -p "$TASK" \
  --output-format json \
  --model "$MODEL" \
  --max-budget-usd 0.50 \
  --allowedTools "Read,Write,Edit,Glob,Grep,Bash,Agent" \
  --dangerously-skip-permissions \
  > "$RESULTS_DIR/session.json" 2>/dev/null) || true

echo "Session complete."
echo ""

# Collect session log
SESSION_ID=$(node --eval "try{const d=require('$RESULTS_DIR/session.json');if(d.session_id)console.log(d.session_id)}catch{}" 2>/dev/null)
if [ -n "$SESSION_ID" ]; then
  ABS_PROJECT=$(cd "$PROJECT" && pwd)
  PROJECT_DIR_NAME=$(echo "$ABS_PROJECT" | sed 's|/|-|g')
  LOG_SRC="$HOME/.claude/projects/${PROJECT_DIR_NAME}/${SESSION_ID}.jsonl"
  if [ -f "$LOG_SRC" ]; then
    cp "$LOG_SRC" "$RESULTS_DIR/session.jsonl"
    echo "Session log saved."
  fi
fi

# ── Analysis ────────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  SMOKE TEST RESULTS"
echo "══════════════════════════════════════════════════════"

# Metrics
if [ -f "$RESULTS_DIR/session.json" ] && [ -s "$RESULTS_DIR/session.json" ]; then
  TURNS=$(node --eval "try{const d=require('$RESULTS_DIR/session.json');console.log(d.num_turns||'N/A')}catch{console.log('N/A')}" 2>/dev/null)
  COST=$(node --eval "try{const d=require('$RESULTS_DIR/session.json');console.log(d.total_cost_usd?'\$'+d.total_cost_usd.toFixed(3):'N/A')}catch{console.log('N/A')}" 2>/dev/null)
  echo "  Turns: $TURNS | Cost: $COST"
else
  echo "  Session failed or empty output"
fi
echo ""

# Gate analysis
if [ -f "$RESULTS_DIR/session.jsonl" ]; then
  DENY_COUNT=$(python3 -c "
import json
count = 0
with open('$RESULTS_DIR/session.jsonl') as f:
    for line in f:
        if 'permissionDecision' in line and '\"deny\"' in line:
            count += 1
print(count)
" 2>/dev/null || echo 0)

  GATE_DENY=$(python3 -c "
import json
count = 0
with open('$RESULTS_DIR/session.jsonl') as f:
    for line in f:
        if 'pre-flight gate' in line.lower() or 'clarte-pre-flight' in line:
            count += 1
print(count)
" 2>/dev/null || echo 0)

  PREFLIGHT_SPAWNED=$(python3 -c "
import json
count = 0
with open('$RESULTS_DIR/session.jsonl') as f:
    for line in f:
        if 'clarte-pre-flight' in line and 'tool_use' in line:
            count += 1
print(count)
" 2>/dev/null || echo 0)

  echo "  permissionDecision deny events: $DENY_COUNT"
  echo "  Gate messages in log: $GATE_DENY"
  echo "  clarte-pre-flight spawned: $PREFLIGHT_SPAWNED"
  echo ""

  # Show first tool calls
  echo "  First 8 tool calls:"
  python3 << PYEOF
import json
calls = []
with open('$RESULTS_DIR/session.jsonl') as f:
    for i, line in enumerate(f):
        try:
            ev = json.loads(line)
            msg = ev.get('message', {})
            content = msg.get('content', [])
            if isinstance(content, list):
                for item in content:
                    if isinstance(item, dict) and item.get('type') == 'tool_use':
                        name = item.get('name', '')
                        inp = item.get('input', {})
                        if name == 'Agent':
                            val = inp.get('subagent_type', '?')
                        elif name == 'Read':
                            val = (inp.get('file_path') or '').split('/')[-1]
                        elif name == 'Bash':
                            val = (inp.get('command') or '')[:50]
                        elif name in ('Grep', 'Glob'):
                            val = (inp.get('pattern') or inp.get('path') or '')[:40]
                        else:
                            val = str(inp)[:40]
                        calls.append(f'    [{len(calls)+1}] {name}({val})')
                        if len(calls) >= 8:
                            break
        except:
            pass
        if len(calls) >= 8:
            break
for c in calls:
    print(c)
PYEOF

  # Verdict
  echo ""
  if [ "$DENY_COUNT" -gt 0 ]; then
    echo "  GATE MECHANISM: PASS - deny fired $DENY_COUNT time(s)"
  else
    echo "  GATE MECHANISM: NOT TESTED - no deny events (agent may have spawned Agent first)"
  fi

  MARKER_WRITTEN=$([ -f "$PROJECT/.clarte/hooks/.state/pre-flight-done" ] && echo yes || echo no)
  echo "  pre-flight-done marker: $MARKER_WRITTEN"
else
  echo "  No session log found."
fi

echo ""
echo "Session log: $RESULTS_DIR/session.jsonl"
echo "Full results: $RESULTS_DIR/"
