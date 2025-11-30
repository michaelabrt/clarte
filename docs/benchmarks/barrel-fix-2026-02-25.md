# Barrel Fix Benchmark: 2026-02-25

**Clarte:** barrel-fix branch (directInDegree fix for barrel-routed imports)
**Model:** claude-sonnet-4-6
**Framework:** clarte-benchmark
**Design:** 4 tasks x 1 condition (with-context) x 7 reps = 28 sessions
**Total cost:** $9.53

## Context

Commit cb398ba introduced a barrel filter that correctly excluded barrel-internal edges
from tight coupling, cross-cutting, and HITS rankings. However, it had a bug: the
barrel-routed import path in `buildImportGraph` incremented `inDegree` but not
`directInDegree`. This meant files imported exclusively through barrels got
`directInDegree = 0`, making them invisible in Key Files, Working Guidelines, and
role derivation.

This benchmark validates the fix: incrementing `directInDegree` for barrel-routed
imports from non-barrel consumers.

## Versions Compared

| Version | Clarte SHA | Description | Reps |
|---------|-----------|-------------|------|
| Feb 24 (pre-barrel) | 6484236 | Before barrel filter (cb398ba) | 1 |
| Feb 25 (post-barrel) | 1966fed | After barrel filter, before directInDegree fix | 7 |
| Fix (barrel-fix) | barrel-fix | directInDegree fix for barrel-routed imports | 7 |

The Feb 24 baseline has only 1 rep per task. Use it for directional reference only.
The Feb 25 baseline and fix both have 7 reps and are directly comparable.

## Per-Task Results (median cost, median turns)

| Task | Metric | No Context | Feb 24 ctx | Feb 25 ctx | Fix ctx | Fix vs Feb 24 | Fix vs Feb 25 |
|------|--------|-----------|-----------|-----------|---------|--------------|--------------|
| ecommerce-api:fix-order-tax | cost | $0.4190 | $0.4733 | $0.2114 | $0.2118 | -55.2% | +0.2% |
| | turns | 11.0 | 11.0 | 8.0 | 8.0 | -27.3% | +0.0% |
| | N | 7 | 1 | 7 | 7 | | |
| large-ts-project:fix-task-transition | cost | $0.2166 | $0.1695 | $0.1705 | $0.1706 | +0.7% | +0.1% |
| | turns | 8.0 | 6.0 | 6.0 | 6.0 | +0.0% | +0.0% |
| | N | 7 | 1 | 7 | 7 | | |
| large-ts-project:test-date-utils | cost | $1.3965 | $0.7786 | $0.8195 | $0.7281 | -6.5% | -11.2% |
| | turns | 17.0 | 13.0 | 13.0 | 11.0 | -15.4% | -15.4% |
| | N | 7 | 1 | 7 | 7 | | |
| medium-ts-api:test-posts-resource | cost | $0.5105 | $0.2891 | $0.3483 | $0.3105 | +7.4% | -10.8% |
| | turns | 11.0 | 8.0 | 9.0 | 9.0 | +12.5% | +0.0% |
| | N | 7 | 1 | 7 | 7 | | |

## Aggregate Results

| Metric | No Context | Feb 24 ctx | Feb 25 ctx | Fix ctx | Fix vs Feb 24 | Fix vs Feb 25 |
|--------|-----------|-----------|-----------|---------|--------------|--------------|
| Median cost | $0.4805 | $0.3812 | $0.3144 | $0.2470 | -35.2% | -21.4% |
| Median turns | 11.0 | 9.5 | 8.0 | 8.0 | -15.8% | +0.0% |
| Median tokens | 132,118 | 100,070 | 72,691 | 60,238 | -39.8% | -17.1% |
| Pass rate | 100% | 100% | 100% | 100% | | |
| N | 28 | 4 | 28 | 28 | | |

## Analysis

### Fix vs Feb 25 (the real comparison, both N=28)

- **Median cost: -21.4%** ($0.31 to $0.25)
- **Median tokens: -17.1%** (72.7k to 60.2k)
- **Median turns: flat** (8.0 both)
- **Pass rate: 100% both**

The cost reduction comes from fewer input tokens (agent reads fewer files to orient).
The test-date-utils task benefits most (-11.2% cost, -15.4% turns) because `date.ts`
is now visible in the untested files list, giving the agent a direct pointer.

### Fix vs Feb 24 (directional only, Feb 24 has N=4)

- **Median cost: -35.2%** ($0.38 to $0.25)
- **Median tokens: -39.8%**
- **Median turns: -15.8%**

The fix is better than the pre-barrel-filter baseline too, because the correct barrel
filters (tight coupling, cross-cutting, HITS discounting) reduce noise in the CLAUDE.md
while the directInDegree fix restores the structural signals that were accidentally lost.

### Per-task observations

- **fix-task-transition**: Flat across all versions. This is a simple, well-signposted
  bug fix that the agent solves in exactly 6 turns regardless of context quality.
  It serves as a good control: the fix doesn't regress easy tasks.

- **test-date-utils**: Biggest beneficiary. With the fix, `date.ts` appears in
  the untested files list, saving the agent exploration time. Median cost dropped
  from $0.82 to $0.73, and median turns from 13 to 11.

- **fix-order-tax**: Flat between Feb 25 and fix (the ecommerce-api fixture doesn't
  have barrel imports, so the fix doesn't affect its CLAUDE.md). The large improvement
  vs Feb 24 is from the barrel filter itself (correct tight-coupling filtering).

- **test-posts-resource**: -10.8% cost vs Feb 25. The medium-ts-api fixture uses
  barrel re-exports; the fix restores proper import counts in Working Guidelines.

## What Changed

1. **`src/graph.ts`**: Barrel-routed import paths now increment `directInDegree`
   for non-barrel consumers, matching the existing pattern for direct imports.

2. **`src/test-map.ts`**: Untested files display limit increased from 10 to 15.

## Raw Data

- `clarte-benchmark/results/barrel-fix-full/benchmark-v0.0.0-dev-2026-02-25.json`
- `clarte-benchmark/results/benchmark-v0.0.0-dev-2026-02-25.json` (Feb 25 baseline)
- `clarte-benchmark/results/benchmark-v1.0.0-2026-02-24.json` (Feb 24 baseline)
