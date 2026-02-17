# Experiment: R.11 - Failure Pattern Detection

**Status:** Done (2026-03-06)

## Context

After 18 experiments with no content/hook wins at E.3, the question shifted
from "what content helps?" to "where do agents actually waste time?" A
bottom-up analysis of session logs to identify addressable failure patterns.

170 benchmark sessions. 7595 total turns. 17 experimental conditions.

## Method

Classified every turn in every session into one of three phases:

| Phase | Definition |
|-------|-----------|
| Exploration | All turns before the first Edit/Write call |
| Edit | First edit through last edit |
| Tail | All turns after the last edit (verification, cleanup) |

Within each phase, identified sub-patterns by tool call type and repetition
signatures.

## Results

### Phase distribution

| Phase | Share of turns | Avg turns per session |
|-------|---------------|---------------------|
| Exploration | 59% | 26.4 |
| Edit | 28% | 12.5 |
| Tail | 13% | 5.9 |

### Tail analysis (most actionable)

149/170 sessions (88%) have 2+ tail turns. Average: 5.9 tail turns.

Dominant sub-pattern: **test output parsing loops** (75% of tail turns).

The sequence:
1. Agent runs tests, sees long output (sometimes truncated)
2. Agent re-runs with `--grep` filter to isolate failures
3. Filter syntax wrong or output still long
4. Agent tries different filter, different reporter, pipes to head
5. Repeats 3-7 times

Only 16% of sessions have actual test re-runs (fixing a test that failed).
The rest are parsing the output of tests that already passed.

### Exploration analysis

- 59% of all turns are exploration (before first edit)
- Only 22 of 170 sessions have clearly wasteful reads (files unrelated to the
  task's neighborhood)
- 75% of exploration reads are within 1-2 hops of target files in the
  dependency graph
- The agent is not lost; it is thorough

### Condition independence

No experimental condition meaningfully reduces tail or exploration waste.
Tail is roughly constant at 4-6 turns regardless of whether the agent has
full context, placebo or no context.

| Condition | Avg tail turns |
|-----------|---------------|
| Full context | 5.7 |
| Placebo | 5.4 |
| No context | 6.3 |
| Hooks | 6.1 |

## Insight

Two addressable waste patterns:

1. **Test output parsing** (75% of tail, ~4 turns per session): A structural
   problem. The agent cannot reliably parse test output from Bash. A
   pre-configured test script with clean, predictable output format would
   eliminate the parsing loop entirely.

2. **Exploration reduction** (~26 turns per session, but mostly not wasteful):
   File routing (telling the agent which files to edit) could compress the
   useful 75% of exploration. The wasteful 25% is too small to target.

The tail is the higher-leverage target: smaller phase but nearly 100%
addressable. Exploration is larger but mostly productive; compressing it
requires confidence injection (R.18), not information injection.
