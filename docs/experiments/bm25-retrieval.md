# R.20: BM25F Edit-Target Retrieval

## Status

GO (2026-03-10)

## Context

After R.18 showed first-edit timing is the key mechanism, built a retrieval system to predict which files need editing from a task description.

## Method

BM25F scoring on file path tokens + function/method names from AST. Per-field normalization (separate avgdl for path vs symbol fields), unified IDF, test-file proxy scoring, import graph expansion and co-change partner boosting. Integrated into pre-flight system: graph generation, BM25F target resolution, task-context.md with per-file symbols, generated CLAUDE.md with imperative directives.

Tested on 4 real-world bug fixes (3 Hono single-package, 1 TypeORM monorepo), opaque prompts, Sonnet.

## Results

| Task | Pre-flight | Placebo | Delta |
|------|-----------|---------|-------|
| Hono URL fragments | 12t / $0.31 | 15t / $0.42 | -26% cost |
| Hono JSX context | 17t / $0.48 | DNF | - |
| Hono form validator | 18t / $0.41 | DNF | - |
| TypeORM SQLite enum | ~11t | ~22t | ~50% turn reduction |

Pre-flight finished all 4 tasks. Placebo finished 2 of 4. First approach to beat placebo on single-package repos.

## Insight

Confidence injection ("edit these files") works where information injection ("here's the architecture") failed. The graph makes the routing decision; the agent executes without exploration overhead.
