# R.13: Test Reporter Pre-Configuration

## Status

Killed (2026-03-07)

## Context

Proposed pre-configuring test reporters (e.g. Mocha's `--reporter dot`, Vitest's `--reporter=verbose`) to produce shorter output. R.11 identified test-output parsing loops as 75% of tail waste across 170 sessions and 7595 turns. Shorter output seemed like a direct fix: less to parse, fewer confused re-runs.

The idea was to inject reporter configuration via hooks or CLAUDE.md directives so agents would see concise pass/fail summaries instead of full stack traces and diffs.

## Why Killed

Three independent reasons converged during the plan audit:

1. **Already tested.** R.9 evaluated near-identical test-related instructions as part of its 18-experiment synthesis. All content/presentation/delivery/hooks experiments were no-go (0/15). Test-related directives showed no positive signal in isolation or combination.

2. **Wrong root cause.** R.12 proved that agents re-run tests because of verification compulsion, not because they cannot read the output. The agent wants confirmation that the fix worked. Shorter output does not reduce the urge to re-run; it only makes each re-run marginally cheaper.

3. **Mechanical fix exists.** The fail-fast hook (R.14) already addresses the pattern of repeated test runs at the behavioral level. A stop-on-pass hook is a stronger intervention than output formatting.

A fourth factor: Claude Code natively tail-truncates long Bash output. The problem surface was already smaller than the R.11 numbers suggested.

## References

- R.11: Failure Pattern Detection (`memory/r11-failure-patterns.md`)
- R.12: Hook Context Injection (`docs/experiments/hook-context-injection.md`)
- R.9: Post-Experiment Synthesis (`memory/r9-research-directions.md`)
- Plan Audit findings (`memory/plan-audit-findings.md`)
