# R.14: Stop Hook on Test Pass

## Status

No-go (2026-03-07)

## Context

Implemented a PreToolUse hook that blocks repeated test commands when no code edits happen between runs. Hypothesis: agent wastes turns re-running the same test hoping for different results.

## Method

Built fail-fast hook (deny after 3 identical test commands with no Edit/Write between them). File-based override escape hatch. Benchmarked on TypeORM ($1 budget) and Directus ($5 budget), 2 runs each.

## Results

- Zero test commands fired on both TypeORM and Directus
- Agent spends entire budget on exploration/editing, never reaches the test-rerun tail
- R.11 data confirms: only 16% of sessions have test re-runs, and budget-capped sessions rarely reach the test phase
- Hook mechanism is sound but ceiling is ~0.5 avg turns saved

## Insight

The addressable surface is too small. Test re-run loops exist (R.11) but are concentrated in sessions that exceed the typical budget. Hook works correctly but the ROI is negligible.
