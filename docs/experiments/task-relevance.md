# R.3 Information Bottleneck (Task-Aware Budget Weighting) Experiment

**Branch**: `experimental/go/release-1.1.0` (deleted)
**Status**: NO GO (passed E.2 isolated eval with +6%, failed E.3 combo benchmark)
**Date**: 2026-02-21

## Theory

80% of future tasks touch 20% of the codebase. The existing snapshot budget allocator (`applyTokenBudget()`) treats files somewhat uniformly: HITS authority + a small gitBoost (raw commit count, max ~1.8x). It doesn't know which area of the codebase is likely to be worked on next, and doesn't boost the dependencies of hot files.

R.3 adds neighborhood-propagated task relevance: if `src/index.ts` is hot, its direct dependencies (`graph.ts`, `types.ts`, `snapshot.ts`) also get a budget boost, because the agent will need those files when working on `index.ts`.

**Key lesson from R.1 (NO-GO)**: Budget reweighting is zero-sum under tight budgets. Boosting file A displaces file B. R.1's "structural surprise" signal lacked precision and displaced useful files. R.3 mitigates this by: (1) using a stronger signal (recent git activity predicts future work better than structural anomalies), (2) conservative multiplier range, (3) budget-neutral normalization so total effective budget stays the same.

## Implementation

### Algorithm (`src/task-relevance.ts`, ~120 lines)

1. **Hot zone identification**: Rank files by commit count, take top 20% (clamped to 3-15 files).
2. **Neighborhood propagation**: Call `computeNeighborhood()` with hot zone as changed files. 1-hop neighbors get raw score 0.6, 2-hop neighbors get 0.3.
3. **Coupling propagation**: For each change-coupling pair where one side is in the hot zone, the other side gets a boost scaled by confidence (confidence * 0.5).
4. **Score assignment**: Hot zone files get 1.0, then take max with neighborhood/coupling scores.
5. **Convert to multiplier**: `FLOOR + raw * (CEILING - FLOOR)` where FLOOR=0.9, CEILING=1.2. Deliberately conservative (0.9x to 1.2x range) to avoid R.1's displacement problem.
6. **Budget-neutral normalization**: Scale all multipliers so their weighted average equals 1.0. This ensures total effective budget stays the same; only the distribution shifts.

### Pipeline integration

The `taskBoost` multiplier is added to the scoring formula in `applyTokenBudget()`:
```
value = (centrality * categoryBoost * gitBoost * taskBoost) / tokens
```

This is computed after `gitActivity` and before `generateSnapshot()`, then threaded through at both call sites (JSON mode and interactive mode).

## Files modified

| File | Change |
|------|--------|
| `src/task-relevance.ts` | **NEW** - core algorithm (~120 lines) |
| `src/types.ts` | Added `taskRelevance?` to `ContextAnalysis` |
| `src/snapshot.ts` | Threaded `taskRelevance` through `generateSnapshot()` and `applyTokenBudget()`, added `taskBoost` multiplier to scoring |
| `src/index.ts` | Compute task relevance after git analysis, pass to both `generateSnapshot()` call sites, store in analysis |
| `src/__tests__/task-relevance.test.ts` | **NEW** - 15 unit tests |
| `src/__tests__/eval/task-relevance-eval.test.ts` | **NEW** - 10 E.1 eval tests (layered-app + hub-and-spoke fixtures) |
| `src/__tests__/eval/task-relevance-llm-tasks.ts` | **NEW** - 12 LLM tasks for E.2 evaluation |
| `src/__tests__/eval/task-relevance-llm-eval.test.ts` | **NEW** - E.2 LLM A/B evaluation (3-iteration consistency + 18-task regression check) |

## Results

### E.1 Deterministic eval

15 unit tests + 10 eval assertions all pass. Key properties verified:

| Property | Status |
|----------|--------|
| Hot zone selects files with highest commit counts | PASS |
| 1-hop neighbors score higher than cold files | PASS |
| 2-hop neighbors score lower than 1-hop | PASS |
| Coupling-boosted files score higher than cold files | PASS |
| Average multiplier = 1.0 (budget-neutral) | PASS |
| All multipliers positive, spread < 2x | PASS |
| Hub files (types/index.ts) not displaced from top positions | PASS |
| Task-relevant files rank higher with R.3 than without | PASS |

### E.2 LLM A/B evaluation

12 specialized R.3 tasks across 4 categories + full 18-task regression suite. Model: claude-sonnet-4-20250514, temperature 0.

**Context comparison**:

| Condition | Tokens | Entries | Excluded |
|-----------|--------|---------|----------|
| Baseline (no R.3) | 5,923 | 170 | 14 |
| R.3 (task-relevance) | 5,715 | 166 | 18 |
| Delta | -3.5% | -4 | +4 |

R.3 shifts 4 entries from cold files to task-relevant files, with slightly fewer total tokens (different entries have different sizes).

**3-iteration consistency run (specialized tasks)**:

| Metric | Iter 1 | Iter 2 | Iter 3 |
|--------|--------|--------|--------|
| Baseline | 58% | 58% | 67% |
| R.3 | 67% | 67% | 67% |
| Delta | +8% | +8% | 0% |
| Verdict | GO | GO | ITERATE |

Aggregate: mean delta = **+6%**, min = 0%, max = +8%.

The ITERATE on iteration 3 was a single code-generation task flip (LLM used wrong field name on `GitAnalysis`), not a systematic regression. No category ever lost 2+ tasks.

Per-category worst-case delta across all 3 runs:

| Category | Worst | Best |
|----------|-------|------|
| file-location | 0 | +1 |
| dependency | 0 | 0 |
| modification-planning | 0 | +1 |
| code-generation | -1 | 0 |

**Regression check (full 18-task suite, 1 iteration)**:

| Metric | Value |
|--------|-------|
| Baseline | 78% |
| R.3 | **83%** |
| Delta | **+6%** |
| Verdict | **GO** |

No category regressed. Code-generation improved (+1). The type-understanding failures (0/3 both conditions) are pre-existing due to exact-number keyword matching against a growing codebase.

**Total eval cost**: $2.56

### GO/NO GO criteria

| Criterion | Target | Result | Status |
|-----------|--------|--------|--------|
| Budget neutrality | avg multiplier = 1.0 | verified to 5 decimal places | PASS |
| No displacement of hub files | hubs stay in top positions | verified | PASS |
| Task-relevant files rank higher | hot zone + neighbors boosted | verified | PASS |
| E.1 eval assertions | all pass | 25/25 pass | PASS |
| E.2 specialized tasks | no iteration drops >10% | min delta = 0%, mean = +6% | PASS |
| E.2 regression check | no regression on standard suite | +6% improvement | PASS |

**Verdict: GO**

## What worked

- Budget-neutral normalization prevents the zero-sum displacement that killed R.1. The total budget stays the same; only the allocation shifts.
- Conservative multiplier range (0.9x to 1.2x pre-normalization) means even worst-case, a cold file loses at most ~10% of its score.
- Git commit counts are a much stronger predictor of task relevance than structural anomalies (R.1's signal). The correlation between "files changed recently" and "files that will change soon" is well-established.
- Neighborhood propagation adds genuinely new signal: even files with zero commits get boosted if they're dependencies of active files. The existing `gitBoost` only handles direct churn.

## What didn't work

- `tr-sc-2` (listing graph.ts exports from the snapshot) fails consistently in both conditions. The stigmergic snapshot only shows compressed one-line signatures for functions, so the LLM can't enumerate individual export names. This is a task design issue, not an R.3 issue.
- `tr-gen-1` and `tr-gen-3` fail intermittently because the LLM uses wrong field names on `GitAnalysis` and `ImportGraph`. Again, both conditions fail equally; this is about the snapshot format, not R.3.

## E.3 Combo Benchmark (NO GO)

R.3 passed E.2 in isolation with a +6% mean delta. However, when combined with R.2 (typification) and R.4 (stigmergic) in the E.3 combinatorial benchmark (N=2 smoke test, temp=0.3, 30 tasks, all 8 feature combinations), the combined release showed a slightly negative delta vs baseline. No individual combination or the full triple produced a statistically significant improvement.

**Key lesson**: R.3's +6% isolated gain at temp=0 did not survive the combo benchmark at temp=0.3 with real variance. The conservative multiplier range (0.9x-1.2x) may be too narrow to produce measurable signal, or the signal may be masked by interaction effects with R.2/R.4.

The task-relevance code remains on the deleted branch for reference.

## Possible future directions

- Revisit with wider multiplier range or different propagation strategy
- Combine with R.1 surprise scores: `tokens(file) = surprise(file) * relevance(file) * base_importance(file)`
- Adaptive hot zone sizing based on git activity distribution (e.g., Pareto detection)
- Temporal decay: weight more recent commits exponentially higher than older ones (currently uses raw counts)
- Per-community task relevance: if the hot zone is concentrated in one community, boost that community's internal files more aggressively
