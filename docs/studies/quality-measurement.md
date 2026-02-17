# Experiment: R.10 - Quality Measurement

**Status:** Done (2026-03-06)

## Context

All benchmarks to date measure speed (turns) and cost (tokens). The implicit
assumption: if the agent produces a passing fix faster, the fix is equally
good. But what if different conditions produce different code quality? A faster
fix could be a worse fix.

This experiment tests whether conditions affect patch quality, not just patch
speed.

## Method

Manual review of 12 runs across 4 matched sets. Each set contains 3 runs of
the same task under different conditions (full context, placebo, no context).

Review criteria:
- **Code patch diff**: Are the edits structurally different?
- **Fix correctness**: Does the patch address the root cause or just the
  symptom?
- **Test quality**: Are generated tests meaningful? Do they cover edge cases?
- **Code style**: Does the patch follow existing conventions?

All tasks were simple bug fixes (single root cause, 1-3 files changed).

## Results

### Code patches

Across all 4 matched sets (12 runs), the code patches are functionally
identical. The agent converges on the same fix regardless of condition.

| Set | Full context patch | Placebo patch | No context patch |
|-----|-------------------|---------------|-----------------|
| 1 | Identical | Identical | Identical |
| 2 | Identical | Identical | Identical |
| 3 | Identical | Identical | +1 extra import (unused) |
| 4 | Identical | Identical | Identical |

Set 3 without context had a minor artifact (unused import) that would be
caught by a linter. The core fix was the same.

### Test quality

Test files showed more variation, but the variation was stochastic, not
correlated with condition.

| Observation | Frequency |
|-------------|-----------|
| Same test structure across all 3 conditions | 2/4 sets |
| One condition has extra edge case test | 1/4 sets |
| One condition has fewer assertions | 1/4 sets |

The "extra edge case" appeared in the no-context condition (set 2), and the
"fewer assertions" appeared in the full-context condition (set 4). No
directional pattern.

### Fix approach

All 12 runs identified the same root cause and applied the same structural
fix. No condition led the agent to a different diagnosis or a superficial
workaround.

## Insight

On simple bug fixes, conditions affect exploration time, not fix quality. The
agent converges on the same patch regardless of context availability. The
dependency graph and code structure constrain the solution space enough that
the "right fix" is discoverable from any starting point.

This is a null result, but an informative one. It means speed benchmarks are
a valid proxy for overall quality on this task class. Faster means cheaper
without a quality tradeoff.

The open question: does quality differentiation appear on more complex tasks
(multi-file refactors, architectural changes, feature additions)? These tasks
have larger solution spaces where context might steer the agent toward a
better design. R.18's finding that multi-file decomposability is only 3-14%
suggests the opportunity is small, but untested.
