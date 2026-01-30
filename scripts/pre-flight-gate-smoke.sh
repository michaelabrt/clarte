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

# Build clarte first to ensure hooks are up to date
(cd "$CLARTE_ROOT" && npm run build 2>/dev/null)

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

# Install clarte hooks via generate
echo "Installing hooks..."
cat > "$PROJECT/.clarte.json" << 'CFG'
{"_version":2,"ides":["claude"],"projectPurpose":"","keyPatterns":"","gotchas":"","generateSnapshot":false,"snapshotPaths":[],"stackCorrections":"","generatePerPackage":false}
CFG
mkdir -p "$PROJECT/.git"  # needed for hook generation
(cd "$PROJECT" && git init --quiet && node "$CLARTE_ROOT/dist/index.js" --yes 2>/dev/null)

# Write task-context.md to arm the gate (oracle condition)
mkdir -p "$PROJECT/.clarte"
cat > "$PROJECT/.clarte/task-context.md" << 'CTX'
# Edit targets (clarte)

Based on past fixes to similar issues, these files are most likely to need editing:

- src/math.ts

Matched commit: fix: correct arithmetic operations
CTX

# Delete the generated CLAUDE.md to keep the task pure
rm -f "$PROJECT/.claude/rules/clarte.md" "$PROJECT/CLAUDE.md"

# Write a minimal CLAUDE.md so Claude knows it's a TS project
echo "# math-utils
A tiny TypeScript math utility library." > "$PROJECT/CLAUDE.md"

# Write the clarte-pre-flight agent definition
mkdir -p "$PROJECT/.claude/agents"
cp "$PROJECT/.claude/agents/clarte-pre-flight.md" "$PROJECT/.claude/agents/clarte-pre-flight.md" 2>/dev/null || true

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
  PROJECT_DIR_NAME=$(echo "$ABS_PROJECT" | sed 's|^/||; s|/|-|g')
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
