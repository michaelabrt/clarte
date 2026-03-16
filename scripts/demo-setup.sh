#!/usr/bin/env bash
set -euo pipefail

# Demo setup: creates two TypeORM checkouts for side-by-side recording
# Left panel: without Clarté (clean repo)
# Right panel: with Clarté (pre-flight + hooks installed)

DEMO_DIR="/tmp/clarte-demo"
TYPEORM_COMMIT="65dea3c0"
PROMPT='SQLite CHECK constraint fails with simple-enum array columns. The values are stored correctly but reading them back throws a CHECK constraint error. Fix the bug and add tests.'

echo "Setting up demo in $DEMO_DIR..."
rm -rf "$DEMO_DIR"
mkdir -p "$DEMO_DIR"

# Clone TypeORM once, then copy
echo "Cloning TypeORM..."
git clone --quiet https://github.com/typeorm/typeorm.git "$DEMO_DIR/typeorm-base"
cd "$DEMO_DIR/typeorm-base"
git checkout --quiet "$TYPEORM_COMMIT"

echo "Creating 'without' checkout..."
cp -r "$DEMO_DIR/typeorm-base" "$DEMO_DIR/without"

echo "Creating 'with' checkout..."
cp -r "$DEMO_DIR/typeorm-base" "$DEMO_DIR/with"

# Install deps in both
echo "Installing deps (without)..."
cd "$DEMO_DIR/without" && pnpm install --frozen-lockfile --quiet 2>/dev/null || pnpm install --quiet

echo "Installing deps (with)..."
cd "$DEMO_DIR/with" && pnpm install --frozen-lockfile --quiet 2>/dev/null || pnpm install --quiet

# Run Clarté on the 'with' version
# Use node directly to avoid npm/pnpm devEngines conflict
echo "Running Clarté on 'with' checkout..."
cd /home/micha/developer/projects/clarte && npm run build 2>/dev/null
cd "$DEMO_DIR/with"
node /home/micha/developer/projects/clarte/dist/index.js --yes

# Clean up base clone
rm -rf "$DEMO_DIR/typeorm-base"

echo ""
echo "============================================"
echo "  Demo ready!"
echo "============================================"
echo ""
echo "Left panel (without):  cd $DEMO_DIR/without"
echo "Right panel (with):    cd $DEMO_DIR/with"
echo ""
echo "Prompt to paste in both:"
echo ""
echo "  $PROMPT"
echo ""
echo "============================================"
echo ""
echo "Windows Terminal split instructions:"
echo ""
echo "  1. Open Windows Terminal"
echo "  2. Alt+Shift+D to split vertically (left/right)"
echo "  3. Left pane:"
echo "     cd $DEMO_DIR/without"
echo "     echo '═══ Without Clarté ═══'"
echo "     claude"
echo "  4. Alt+Right to switch to right pane"
echo "  5. Right pane:"
echo "     cd $DEMO_DIR/with"
echo "     echo '═══ With Clarté ═══'"
echo "     claude"
echo "  6. Start recording (OBS or Win+G)"
echo "  7. Paste the prompt in BOTH panes"
echo "     Tip: paste in 'without' first, wait 2-3 seconds, then paste in 'with'"
echo "     This way 'with' catches up and passes 'without' on screen"
echo ""
