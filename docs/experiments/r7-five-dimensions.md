# R7: Five Dimensions Experiment

**Status**: No-go (all five conditions dropped)
**Date**: 2026-03-05
**Benchmark**: honojs/hono @ e0f8dd83, issue #4119 (JWK alg fallback)
**Setup**: Opaque prompt, Sonnet, n=3, budget $3.00

## Hypothesis

R5/R6 showed static analysis content doesn't help agents and often hurts. Direct-2 ("Do not use Grep or Glob to explore") saved 40% cost. Can we find value in dimensions beyond static analysis: aesthetic/tacit knowledge, verification discipline, memory/learning, dynamic context injection and ecological awareness?

## Conditions

All conditions start from the 2-line placebo CLAUDE.md (`# hono\nA TypeScript web framework. Tests use vitest.`) and add one thing.

| ID | Name | Dimension | What it adds |
|----|------|-----------|-------------|
| A | culture | Aesthetic/tacit | LLM-extracted coding conventions (~200 tokens) |
| B | checklist | Verification | 3-step pre-submit checklist (run tests, check edge case, verify coverage) |
| C | memory | Memory/learning | Navigation hints ("JWT middleware lives in src/middleware/jwt/") |
| D | hooks | Dynamic context | PreToolUse hook injecting per-file hints when Read is called |
| E | cochange | Ecological | Co-change pairs from git log ("jwt.ts <-> jws.ts (85%)") |

Placebo and direct-2 included as baselines.

## Raw Results

```
Condition  |  Run |  Turns |     Cost
-----------|------|--------|---------
placebo    |    1 |     16 |    $0.43
placebo    |    2 |     16 |    $0.49
placebo    |    3 |     16 |    $0.45
direct-2   |    1 |     17 |    $0.44
direct-2   |    2 |     19 |    $0.48
direct-2   |    3 |     18 |    $0.53
culture    |    1 |     21 |    $0.55
culture    |    2 |     18 |    $0.44
culture    |    3 |     19 |    $0.45
checklist  |    1 |     21 |    $0.52
checklist  |    2 |     19 |    $0.42
checklist  |    3 |     19 |    $0.55
memory     |    1 |     16 |    $0.50
memory     |    2 |     16 |    $0.61
memory     |    3 |     17 |    $0.67
hooks      |    1 |     22 |    $0.49
hooks      |    2 |     18 |    $0.72
hooks      |    3 |     19 |    $0.57
cochange   |    1 |     20 |    $0.51
cochange   |    2 |     16 |    $0.49
cochange   |    3 |     18 |    $0.45
```

## Averages

| Condition | Avg Turns | Avg Cost | Turns vs placebo | Cost vs placebo |
|-----------|-----------|----------|------------------|-----------------|
| placebo | 16.0 | $0.46 | - | - |
| direct-2 | 18.0 | $0.48 | +12.5% | +5% |
| culture | 19.3 | $0.48 | +20.6% | +5% |
| checklist | 19.7 | $0.50 | +23.1% | +8% |
| memory | 16.3 | $0.59 | +1.9% | +29% |
| hooks | 19.7 | $0.59 | +23.1% | +29% |
| cochange | 18.0 | $0.48 | +12.5% | +5% |

## Verdict: All five no-go

No condition showed positive signal. Every condition is either worse on turns, worse on cost, or both.

**Clear drops** (>20% worse on turns): culture, checklist, hooks. These are unambiguous even at n=3.

**Marginal drops**: memory (+1.9% turns, +29% cost) and cochange (+12.5% turns, +5% cost). Neither shows the "clear positive signal" required by the GO bar. Memory's near-placebo turn count is interesting but the cost penalty is real - navigation hints don't reduce exploration, they just make the agent read more per turn.

**Hooks** (+23% turns, +29% cost) is the worst condition. This confirms R4's finding: injecting context at read-time adds re-read turns. Dynamic delivery is actively harmful.

**Direct-2 regression**: Direct-2 averaged 18.0 turns here vs its R6 performance of ~40% cost savings over placebo. At n=3 this could be noise or session-level variance. Not actionable from this data alone.

## Key Takeaways

1. **Content doesn't help, regardless of dimension.** R5/R6 showed static analysis content hurts. R7 shows that conventions, checklists, navigation hints, dynamic hints and co-change data also hurt (or at best do nothing). The pattern is consistent across 200+ sessions and 7 content types.

2. **Adding any text to CLAUDE.md beyond the minimum is a tax.** Every condition that added content to the placebo performed worse. The agent doesn't need help navigating - it needs to not be distracted.

3. **Dynamic injection is the worst delivery mechanism tested.** Hooks added both turns and cost. This matches R4 (read-executor injection adds re-read turns).

4. **Placebo remains unbeaten.** Across R5, R6 and R7, the 2-line placebo is the strongest or tied-for-strongest condition. The only thing that has beaten it is direct-2's cost savings in R6, which did not reproduce here.
