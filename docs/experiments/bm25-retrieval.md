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
| Hono URL fragments (opaque) | $0.34 avg | $0.28 avg | -17% cost | 8+8 |
| Hono URL fragments (detailed) | $0.16 avg | $0.15 | parity | 10+1 |
| Hono JSX context | DNF | 17t / $0.48 | pre-flight only | 1+1 |
| Hono form validator | DNF | 18t / $0.41 | pre-flight only | 1+1 |
| TypeORM SQLite enum | 47.7t / $1.47 | 16.3t / $0.43 | -66% turns, -71% cost | 3+3 |

Pre-flight finished all 4 opaque tasks. Placebo finished 2 of 4. On hono-url (n=8), pre-flight variance was 3x tighter ($0.25-$0.31 vs $0.26-$0.42). On TypeORM (n=3), the gap was -66% turns and -71% cost. First approach to beat placebo on single-package repos. See [on-demand delivery](on-demand-delivery.md) for the prompt-gating mechanism.

## Insight

Confidence injection ("edit these files") works where information injection ("here's the architecture") failed. The graph makes the routing decision; the agent executes without exploration overhead.
