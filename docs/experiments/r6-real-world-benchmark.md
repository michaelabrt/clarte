# Experiment: Real-World Benchmark (R.6)

**Date:** 2026-03-04
**Status:** Active (direct wording iteration in progress)

## Background

R5 (181 sessions on synthetic benchmarks) showed full static analysis loses to a one-liner placebo on detailed tasks (+12% turns, +24.5% cost). Wins only on opaque tasks (-14% turns). The synthetic benchmark had reached its limits: fake tool executor, tiny fixture repos (10-30 files), tasks that don't require real navigation.

R6 moved to a real-world benchmark: a real repo, a real GitHub issue, real Claude Code execution with `claude -p`.

## Setup

- **Repo**: honojs/hono (~270 TypeScript files, vitest)
- **Issue**: #4119 (JWK `alg` fallback)
- **Bug**: `verifyFromJwks` defaults algorithm to HS256 when the JWK lacks an `alg` property, breaking RSA-signed tokens from providers like Microsoft Entra ID
- **Commit**: e0f8dd83 (just before fix PR #4144)
- **Budget cap**: $3.00 per run
- **Execution**: `claude -p` with `--dangerously-skip-permissions`, JSON output
- **Allowed tools**: Read, Write, Edit, Glob, Grep, Bash

### Prompts

Two prompt variants tested:

**Detailed** (names the function, root cause and fix direction):
> The verifyFromJwks function defaults the algorithm to HS256 when the JWK key object lacks an alg property. This causes verification to fail for RSA-signed tokens (RS256)...

**Opaque** (describes symptom only):
> JWT signature verification fails when using JWKS keys from providers like Microsoft Entra ID. The tokens are valid RS256 JWTs and the JWKS endpoint returns the correct keys, but verification rejects them...

## Conditions

| Condition | CLAUDE.md content |
|-----------|-------------------|
| **placebo** | 2-line: project name + test runner |
| **clarte** | Full default `npx clarte --yes` output |
| **phone-book** | File index + header only (new `file-index` section) |
| **pointer** | Placebo + "read .claude/rules/clarte.md if you need to discover files" |
| **direct** | Placebo + "don't explore upfront, go directly to likely files" |

## Results

### Opus, Opaque Prompt (n=2)

| Condition | Turns | Cost |
|-----------|-------|------|
| placebo | 12, 14 | $0.54, $0.49 |
| clarte | 9, 12 | $0.48, $0.65 |

### Opus, Detailed Prompt (n=3-4)

| Condition | Turns | Cost |
|-----------|-------|------|
| placebo | 11, 13, 13, 12 | $0.36-$0.44 |
| clarte | 15, 18 | $0.47-$0.59 |
| phone-book | 11, 13 | $0.45-$0.48 |

### Opus, Pointer, Opaque Prompt (n=3)

| Condition | Avg turns | Avg cost |
|-----------|-----------|----------|
| placebo | 9.0 (9, 8, 10) | $0.49 |
| pointer | 14.0 (13, 12, 17) | $0.74 |

Pointer lost badly. The agent reads the rules file every run regardless of need, adding overhead.

### Sonnet, Opaque Prompt (n=7)

| Condition | All turns | Avg turns | Avg cost | Stdev |
|-----------|-----------|-----------|----------|-------|
| placebo | 10, 14, 13, 21, 14, 9, 13 | **13.4** | **$0.60** | 3.8 |
| clarte | 15, 20, 19, 17, 15, 16, 14 | 16.6 | $0.63 | 2.2 |

Placebo wins on turns. Clarte has lower variance but higher floor.

### Sonnet, Direct vs Placebo, Opaque Prompt (n=6)

| Condition | All turns | Avg turns | Avg cost |
|-----------|-----------|-----------|----------|
| placebo | 19, 15, 14, 11, 20, 18 | 16.2 | **$0.63** |
| direct | 15, 17, 15, 22, 18, 16 | 17.2 | **$0.54** |

Same turns, but direct is ~15% cheaper. The agent reads fewer files per turn.

### Haiku, Opaque Prompt (n=6 of 10 completed)

| Condition | All turns | Avg turns | Avg cost |
|-----------|-----------|-----------|----------|
| placebo | 35, 41, 29, 27, 23, 29 | 30.7 | $0.29 |
| clarte | 45, 18, 26, 22, 39, 43 | 32.2 | $0.44 |

Haiku struggles regardless. 4 runs didn't complete within budget. Clarte adds cost without helping.

## Key Findings

1. **Nothing beats placebo on turns** for this task, across all models and prompt types. Structural context adds reading overhead that exceeds its navigation value on a well-named codebase.

2. **"Direct" behavioral instruction** matches placebo on turns but is ~15% cheaper ($0.54 vs $0.63). The agent reads fewer files per turn. This is the only positive signal in the entire experiment.

3. **Pointer approach failed.** Telling the agent "read .claude/rules/clarte.md if you need to discover files" causes it to read the file every time, adding a turn and cost.

4. **Phone book alone doesn't help.** A file index without behavioral guidance is noise. The agent either ignores it or reads files it doesn't need.

5. **Variance is enormous.** Same condition varies 8-21 turns across runs. Minimum n=7 to see any pattern.

6. **Model matters more than context.** Opus solves in ~12 turns avg, Sonnet ~15, Haiku ~30. Weaker models have more room for optimization but clarte doesn't help them either.

## Code Changes

| File | Change |
|------|--------|
| `src/templates/sections/file-index.ts` (new) | Compact 1-line-per-file export index |
| `src/templates/main-context.ts` | Integrated file-index section after key-files, priority 3 |
| `src/__tests__/file-index-section.test.ts` (new) | 15 unit tests |
| `scripts/real-world-bench.sh` (new) | Multi-condition benchmark script |
| `src/modes/generate.ts` | Fixed `--yes` to skip git hook prompt |

## Caveats

- Single repo (hono, 270 files), single issue (JWT bug). Results may not generalize to larger repos or harder tasks.
- Hono has clear file naming (`src/middleware/jwt/`). On a codebase with opaque naming, navigation context may help more.
- Correctness was not systematically evaluated (whether the fix matches the PR intent).
- At 270 files, `glob("**/*.ts")` is cheap. The calculus may shift on 1000+ file repos where exploration is expensive.

## Lessons Learned

- **Real benchmarks reveal what synthetic ones hide.** The synthetic benchmark's fake tool executor and 10-file repos masked the fact that Claude is already good at navigating medium-sized codebases. Real execution shows the overhead of reading context exceeds the savings from better navigation.
- **Behavioral instruction > structural data.** "Don't explore upfront" (3 tokens of instruction) saves more cost than 2000 tokens of structural analysis. What the agent DOES matters more than what it KNOWS.
- **Passive delivery is wasteful.** CLAUDE.md is read once and most of it is irrelevant to the specific task. A pointer to a rules file makes it worse (adds a read turn). The right delivery is either nothing or a behavioral nudge.
- **Variance dominates.** Run-to-run variance (8-21 turns on the same condition) is larger than between-condition differences (~3 turns). Small n comparisons are unreliable. Need n>=7 per condition.

## Round 2: Direct Wording Variants (Sonnet, Opaque, n=3)

Three variant wordings tested against placebo, all in parallel:

| Variant | Wording |
|---------|---------|
| direct-1 | "Read the single most relevant file first based on the task description, then fix the bug. Only search for more files if your first attempt fails." |
| direct-2 | "Do not use Grep or Glob to explore. Open the file most likely to contain the bug based on the task description. Fix it, then run tests." |
| direct-3 | "You have a $0.30 budget. Be surgical: find the bug in as few file reads as possible." |

### Raw Results

| Condition | Run 1 | Run 2 | Run 3 | Avg Turns | Avg Cost |
|-----------|-------|-------|-------|-----------|----------|
| placebo | 17 / $0.72 | 15 / $0.61 | 12 / $0.61 | 14.7 | $0.65 |
| direct-1 | 18 / $0.43 | 19 / $0.53 | 20 / $0.55 | 19.0 | $0.50 |
| direct-2 | 17 / $0.43 | 14 / $0.31 | 16 / $0.44 | 15.7 | $0.39 |
| direct-3 | 18 / $0.45 | 21 / $0.55 | 17 / $0.43 | 18.7 | $0.48 |

### Deltas vs Placebo

| Condition | Turn Δ | Cost Δ |
|-----------|--------|--------|
| direct-1 | +29% | -23% |
| **direct-2** | **+7%** | **-40%** |
| direct-3 | +27% | -26% |

### Analysis

**direct-2 is the clear winner.** Near-placebo turns (+7%, within noise at n=3) with 40% cost savings. The instruction directly suppresses the Grep/Glob exploration phase that burns tokens without yielding useful results on this codebase. The agent goes straight to reading the likely file.

direct-1 and direct-3 save cost (23-26%) but add ~28% more turns. "Read the single most relevant file first" and "be surgical" make the agent too narrow in its initial approach, causing more fix-test-fix iterations.

The original "direct" wording (R6 round 1) saved ~15% cost at same turns. direct-2 improves on that substantially: -40% cost with only +7% turns (likely noise).

**Mechanism**: Forbidding Grep/Glob forces the agent to use Read directly on its best guess. This skips the "let me search the codebase" phase (typically 2-4 turns of Glob + Grep) and goes straight to reading code. On a well-named codebase like hono, the agent's first guess is usually right.

## Open Questions

- **n=3 is too small for turn comparison.** The +7% turn delta for direct-2 is within variance. Need n>=7 to confirm it's truly turn-neutral.
- **Correctness not checked.** All conditions may solve the bug differently. Need to verify direct-2 doesn't produce worse fixes.
- **Single-repo bias.** Hono has clear file naming (`src/middleware/jwt/`). On a repo with opaque naming, forbidding Grep/Glob might backfire.
- **direct-2 + structural context.** Would combining direct-2's behavioral instruction with a phone book or key-files list help on harder tasks?

## Next Steps

1. Run direct-2 at n=7+ to confirm turn-neutrality.
2. Check correctness of direct-2 outputs (do the fixes match the PR intent?).
3. Test on a second repo with less obvious file naming to see if the pattern holds.
