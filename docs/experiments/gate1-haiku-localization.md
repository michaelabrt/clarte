# Experiment: Gate 1 - Haiku File Localization Accuracy Eval

**Date:** 2026-03-07
**Verdict:** NO-GO (LLM-based file localization killed; updatedInput mechanism kept open for behavioral uses)
**Cost:** $0.20 total (21 Haiku API calls)

## Theory

Before building a full hook-based file localization system, test whether a cheap LLM (Haiku) can reliably identify the correct file to edit given a bug description and repository metadata. If Haiku cannot localize accurately on a controlled eval, the entire enrichment pipeline is not worth building.

Three repos from the benchmark suite: hono, nestjs and typeorm. Each has a known ground-truth file for its bug-fix task.

## Phase 1: Baseline Accuracy (12 calls)

Two prompt styles crossed with two file representations:
- **Opaque prompts**: bug description without naming the target file
- **Detailed prompts**: bug description with enough context to narrow it down
- **Bare**: file paths only
- **Paths+exports**: file paths with exported symbol names

| Prompt | Representation | Accuracy |
|--------|---------------|----------|
| Opaque | Bare | 1/3 (typeorm only) |
| Opaque | Paths+exports | 1/3 (typeorm only) |
| Detailed | Bare | 2/3 (nestjs + typeorm) |
| Detailed | Paths+exports | 3/3 (all three) |

Exports boost: +1 on detailed (flipped hono), neutral on opaque. Opaque prompts fail on 2/3 repos regardless of representation.

## Phase 2: Query Reformulation (9 calls)

Reformulated the opaque prompts to be more specific without revealing the target file directly.

| Prompt | Representation | Accuracy |
|--------|---------------|----------|
| Reformulated opaque | Bare | 2/3 (flipped nestjs) |
| Reformulated opaque | Paths+exports | 2/3 (flipped nestjs) |

Hono still misses. The failure mode is consistent: jwt vs jwk one-character confusion. Haiku picks `src/utils/jwt/jwt.ts` instead of `src/middleware/jwt/jwt.ts`.

## Gate 3: Shadow Analysis (66 transcripts, zero cost)

Analyzed 66 existing placebo benchmark transcripts to measure how well the agent self-localizes without any enrichment.

| Repo | Agent self-localization | Notes |
|------|------------------------|-------|
| Hono | 1/48 (2%) | Agent reads `src/utils/jwt/jwt.ts` 52/48 times instead of `src/middleware/jwt/jwt.ts` |
| NestJS | 6/7 (86%) | Agent finds `ws-adapter.ts` by read 3-5 |
| TypeORM | 11/11 (100%) | Agent nails all 3 ground truth files by read 1 |

## Why NO-GO

1. **Reformulation only helps where the agent already succeeds.** NestJS (86% agent self-localization) and typeorm (100%) both respond to better prompts. Hono (2%) does not. The enrichment has no additive value on the hard case.

2. **The hard case is genuinely hard.** The hono jwt/jwk confusion is a one-character difference in a deep directory tree. Haiku fails on it. The agent fails on it. Reformulation fails on it. This is not a problem that prompt engineering solves cheaply.

3. **Literature confirms the pattern.** No top SWE-bench system uses external prompt enrichment (Agentless reaches 77.7% without it). Strong agents benefit little from retrieval augmentation (CodeRAG-Bench). Wrong context actively hurts: -3% solve rate, +20% cost (ContextBench, arXiv 2602.05892).

4. **Cost-benefit is inverted.** The two repos where enrichment would be accurate (nestjs, typeorm) are exactly the repos where the agent already self-localizes at 86-100%. The one repo where the agent genuinely struggles (hono, 2%) is exactly where enrichment also fails.

## Decision

Kill LLM-based file localization enrichment. The mechanism does not solve the cases that need solving.

Keep the `updatedInput` hook mechanism open for behavioral uses: `decision:block` on test retry loops, deterministic test command injection. These are behavioral interventions that do not depend on LLM accuracy.

## Lessons learned

- **Gate experiments pay for themselves.** 21 Haiku calls ($0.20) killed a feature that would have cost $50+ in benchmark time to evaluate properly. The shadow analysis of existing transcripts was free.
- **Shadow analysis is underused.** Existing benchmark transcripts contain agent behavior data that can answer new questions at zero cost. The 66-transcript hono/nestjs/typeorm corpus answered the self-localization question without running anything.
- **Enrichment helps least where it is needed most.** This is consistent with R12 (hook injection) and R7 (unsolicited info): external context hurts or is irrelevant on hard tasks. The agent's failure mode on hono is not "doesn't know which file" but "can't distinguish similar paths" - a problem that retrieval augmentation shares.
