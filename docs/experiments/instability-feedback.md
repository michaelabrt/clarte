# Experiment: Instability Feedback (Brittle Dependency Directive)

**Branch:** `experimental/ongoing/hits-instability-feedback`
**Date:** 2026-02-23
**Verdict:** NO-GO

## Theory

Foundation files (high authority, many dependents) that also have many outgoing imports are "brittle foundations": changes to their upstream dependencies cascade to all their dependents. This is a unique data point not captured elsewhere in the context:

- **Key Files** shows `importedBy` count (incoming) but not outgoing import count
- **Tight Coupling** shows named imports between specific pairs, not file-level import count
- **Instability ratio** (outgoing / (outgoing + incoming)) quantifies the brittleness

The hypothesis: surfacing the instability ratio and outgoing import count as a Working Guidelines directive would help the agent be more careful when modifying files with high dependency instability, leading to fewer cascading breakages and more targeted edits.

## Implementation

Added directive category 15 ("Brittle dependency directives") to `src/templates/directives.ts`:

1. Filter hub files for Foundation/Bridge role with authority >= 0.4 and >= 5 outgoing imports
2. Compute instability ratio: `imports / (imports + importedBy)`
3. Exclude files already flagged by tech-debt category (instability >= 0.8, fanIn >= 3) to avoid duplication
4. Require instability >= 0.25 (moderate threshold)
5. Emit up to 3 directives with the format:
   ```
   `path` has high dependency instability (N outgoing imports vs M dependents, I=0.XX).
   Changes to its upstream imports will cascade to all dependents.
   Pin dependency interfaces where possible.
   ```

### Files modified

| File | Change |
|------|--------|
| `src/templates/directives.ts` | Category 15: brittle dependency directive (~30 lines) |
| `src/__tests__/eval/instability-feedback-eval.test.ts` | E.2 value-add eval harness (5 tasks, judge-scored) |
| `src/__tests__/eval/instability-feedback-combo-eval.test.ts` | E.3-lite combo eval harness (10 tasks, temp=0.3) |

## Evaluation

### E.1: Deterministic tests

The directive correctly fires on clarte's own CLAUDE.md for `src/watch.ts` and `src/diff.ts` (both have instability > 0.25 with sufficient authority). Verified by manual inspection.

### E.2: Isolated LLM eval (temp=0, 3 iterations, 5 tasks)

Tested on drizzle-kit's CLAUDE.md where the directive fires for snapshotsDiffer.ts, migrate.ts, and jsonStatements.ts.

5 tasks requiring specific quantitative data (outgoing import counts, instability ratios) that only the treatment directive provides.

| Arm | Pass rate | Delta |
|-----|-----------|-------|
| Baseline (directive stripped) | 5/15 (33%) | |
| Treatment (directive intact) | 7/15 (47%) | **+13.3%** |

Treatment showed improvement on tasks requiring specific import counts and instability ratios. Baseline could not answer these questions because the data was not available in any other section.

### E.3-lite: Combo eval (temp=0.3, 5 iterations, 10 tasks)

10 tasks: 5 instability-focused + 5 general architecture (regression detection).

| Arm | Aggregate | Delta |
|-----|-----------|-------|
| Baseline | 37/50 (74%) | |
| Treatment | 37/50 (74%) | **+0%** |

Per-iteration breakdown showed 2 iterations where treatment improved, 2 where it regressed, 1 neutral. The +13.3% signal from E.2 washed out completely under real variance at temp=0.3.

### Agentic benchmark (clarte-benchmark ablation, 2 reps, 4 tasks)

Compared `with-context` (directive present) vs `ablation-instability-feedback` (directive surgically removed) using clarte-benchmark's agentic framework.

| Condition | Pass rate | Median cost | Total cost |
|-----------|-----------|-------------|------------|
| with-context | 8/8 (100%) | $0.251 | $2.90 |
| ablation-instability-feedback | 8/8 (100%) | $0.252 | $3.03 |

Paired results (4 tasks x 2 reps = 8 pairs): 4 favored with-context, 4 favored ablation. Cost deltas ranged from -52% to +164% between reps of the same task. No directional signal.

### Total eval cost

| Eval | Cost |
|------|------|
| E.2 (isolated, 3 iters) | ~$1.50 |
| E.3-lite (combo, 5 iters) | ~$7.00 |
| Agentic benchmark (16 sessions) | $6.13 |
| **Total** | **~$14.63** |

## Why NO-GO

1. **Zero signal in real conditions.** E.3 showed +0% (2 improve, 2 regress). The agentic benchmark showed a 4-4 paired split with enormous variance. The E.2 +13.3% was a false positive from temp=0 masking variance.
2. **The directive data is rarely actionable.** For the directive to change agent behavior, the agent must be modifying a file with high instability AND need to be warned about cascade risk. In practice, the benchmark tasks never hit this scenario. The directive gets read but never acted upon.
3. **Extra tokens with no payoff.** Each directive line adds ~40 tokens to the Working Guidelines section. Across 3 directives, that's ~120 tokens consumed on every context load with no measurable benefit.
4. **Consistent with the E.3 lesson.** This is the second experiment (after content-dedup) where E.2 showed a positive signal that completely disappeared in E.3. Isolated evals at temp=0 are necessary but not sufficient.

## Lessons learned

- **E.2 false positives are systematic.** Both content-dedup and instability-feedback passed E.2 with positive signals (+0% and +13.3% respectively) but showed zero or negative delta in E.3. The temp=0 isolated eval is good for catching regressions but not for confirming value-add.
- **Directive-level ablation works.** The clarte-benchmark `generateClarteDirectiveAblation()` approach (generate full context, then regex-strip specific lines) is a clean way to test individual directives without needing `--exclude` support for each one.
- **Quantitative data is only useful when the task demands it.** The instability ratio is genuinely unique information, but the agent only needs it when explicitly asked about dependency risk. General coding tasks (fix bugs, write tests) don't trigger the scenario where this data changes behavior.
- **Small n agentic benchmarks show massive variance.** The ablation benchmark had per-task cost swings of +164% / -52% between reps. Even 7 reps may not converge for high-variance tasks like test-date-utils.

## Possible future directions

- **Conditional emission**: Only emit instability directives when the task touches files with high instability (requires task-awareness at generation time, which clarte doesn't have).
- **Integration with diff mode**: In `--diff` mode, if the changed files have high instability dependents, warn about cascade risk. This would be more targeted than always-on directives.
- **Neither may be worth the complexity.** The existing Working Guidelines already surface risk factors ("multiple risk factors: high churn, tightly coupled") which overlap with the instability signal.
