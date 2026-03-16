#!/usr/bin/env bash
# Phase 1 Validation Gate — Check 4 / AC 1.9.3
#
# Runs `clarte refresh` on the clarte repo itself and diffs the generated CLAUDE.md
# against the previous version. Only temporal differences are acceptable.
#
# Exit codes:
#   0  — pass (no structural changes, or first run with no baseline)
#   1  — fail (structural diff found)
#
# Usage:
#   ./scripts/self-test.sh               # run against built dist/
#   CLARTE_BIN=node ./scripts/self-test.sh  # override binary

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
CLARTE_BIN="${CLARTE_BIN:-node}"
CLARTE_ENTRY="$REPO_ROOT/dist/index.js"
BASELINE="$REPO_ROOT/CLAUDE.md.baseline"

echo "=== Phase 1 Self-Test: clarte refresh ==="
cd "$REPO_ROOT"

# Build unless dist already exists and is newer than src
if [ ! -f "$CLARTE_ENTRY" ] || find src -newer "$CLARTE_ENTRY" -name '*.ts' | grep -q .; then
  echo "Building clarte..."
  bun run build
fi

# Snapshot current output as baseline if none exists
if [ ! -f CLAUDE.md ]; then
  echo "No CLAUDE.md found — running initial refresh to create baseline..."
  $CLARTE_BIN "$CLARTE_ENTRY" refresh --root "$REPO_ROOT"
  echo "PASS: Baseline created."
  exit 0
fi

cp CLAUDE.md "$BASELINE"

# Run refresh
$CLARTE_BIN "$CLARTE_ENTRY" refresh --root "$REPO_ROOT"

# Diff, stripping lines that only contain temporal info (e.g. "modified 2d ago")
DIFF=$(diff "$BASELINE" CLAUDE.md \
  | grep -E "^[<>]" \
  | grep -v "modified [0-9]" \
  | grep -v "updated [0-9]" \
  | grep -v "ago$" \
  | grep -v "^[<>] *$" \
  || true)

rm -f "$BASELINE"

if [ -n "$DIFF" ]; then
  echo ""
  echo "FAIL: Structural changes in CLAUDE.md after clarte refresh:"
  echo "$DIFF"
  echo ""
  echo "Acceptable changes: timestamps, 'modified X ago' lines."
  echo "Any change to key files, directives, architecture, or change coupling is a regression."
  exit 1
fi

echo "PASS: clarte refresh produced no structural changes."
