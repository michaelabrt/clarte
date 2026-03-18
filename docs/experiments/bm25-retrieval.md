# R.20: BM25F Edit-Target Retrieval

## Status

GO (2026-03-10). Hono URL consolidated with n=8 on 2026-03-11. TypeORM consolidated with n=3 on 2026-03-12.

## Context

After R.18 showed first-edit timing is the key mechanism, built a retrieval system to predict which files need editing from a task description.

## Method

BM25F scoring on file path tokens + function/method names from AST. Per-field normalization (separate avgdl for path vs symbol fields), unified IDF, test-file proxy scoring, import graph expansion and co-change partner boosting. Integrated into pre-flight system: graph generation, BM25F target resolution, task-context.md with per-file symbols, generated CLAUDE.md with imperative directives.

Tested on 4 real-world bug fixes (3 Hono single-package, 1 TypeORM monorepo), opaque prompts, Sonnet. The URL fragment and TypeORM rows pool pilots with later controlled ABs.

## Results

| Task | Placebo | Pre-flight | Delta | n |
|------|---------|-----------|-------|---|
| Hono URL fragments (opaque) | completed, high variance | completed, 3x more consistent | faster, tighter | 8+8 |
| Hono URL fragments (detailed) | completed | completed | parity (no overhead) | 10+1 |
| Hono JSX context | wrong file, DNF | correct file, 2 min to first edit | **completion + correctness** | 2+2 |
| Hono form validator | DNF | completed (18 turns) | **completion** | 1+1 |
| TypeORM SQLite enum | 47.7 turns | 16.3 turns | **-66% turns** | 3+3 |

Pre-flight finished all 4 opaque tasks. Placebo finished 2 of 4. On hono-url (n=8), pre-flight sessions were 3x more consistent. On TypeORM (n=3), the turn gap was 66%. On JSX context loss, pre-flight predicted the correct file (`src/jsx/context.ts`) and the agent edited it in 2 minutes; placebo chose the wrong file (`src/jsx/base.ts`) after 14 minutes and did not finish. First approach to beat placebo on single-package repos. See [on-demand delivery](on-demand-delivery.md) for the prompt-gating mechanism.

## Insight

Confidence injection ("edit these files") works where information injection ("here's the architecture") failed. The graph makes the routing decision; the agent executes the correct edit without exploration. The primary wins are correctness (right file, right fix) and efficiency (fewer turns, less wall-clock time), not token savings.
