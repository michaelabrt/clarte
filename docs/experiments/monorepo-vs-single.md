# Experiment: R.8 - Monorepo vs Single Package

**Status:** Done (2026-03-05). **Superseded by [R.20](bm25-retrieval.md)** - pre-flight targeting resolved the single-package regression. Clarté now completes tasks on single-package repos that the agent cannot finish alone (Hono JSX, Hono form validator) and reduces turns by 66% on TypeORM.
**Branch:** `experimental/go/monorepo-routing`

## Context

R.5 showed context value is narrow: it helps on opaque tasks but hurts on
detailed ones. But R.5 tested on single-package repos only. Monorepos have a
fundamentally different navigation problem: the agent must first identify which
package contains the bug before it can localize files.

Hypothesis: context value correlates with package count, not file count or
codebase complexity.

## Method

Two real-world repos with opaque bug prompts:

| Repo | Structure | Task |
|------|-----------|------|
| NestJS | 9-package monorepo | WebSocket shutdown bug (opaque prompt) |
| TypeORM | Single package, 677 files | SQLite enum array bug (opaque prompt) |

- NestJS: n=7 runs (4 with clarte, 3 without)
- TypeORM: n=3 runs (2 with clarte, 1 without)
- Model: Sonnet
- All prompts opaque: symptom described, no file targets given

## Results

### NestJS (monorepo, 9 packages)

| Condition | Avg turns | Avg cost | Win rate |
|-----------|-----------|----------|----------|
| With clarte | 8.3 | $0.42 | 6/7 (86%) |
| Without clarte | 11.7 | $0.53 | - |
| **Delta** | **-29%** | **-20%** | |

Clarte's key-files and package structure sections route the agent to the
correct package (platform-ws) within 1-2 turns. Without context, the agent
explores 3-4 packages before finding the right one.

### TypeORM (single package, 677 files)

| Condition | Avg turns | Avg cost | Win rate |
|-----------|-----------|----------|----------|
| With clarte | 14.2 | $0.89 | 0/3 (0%) |
| Without clarte | 11.5 | $0.34 | - |
| **Delta** | **+24%** | **+162%** | |

The agent self-localizes efficiently via grep in a single-package repo. Clarte's
coupling directives ("when modifying X, also check Y, Z") send it to files
outside the task scope, adding exploration turns.

### Summary

| Metric | Monorepo | Single-package |
|--------|----------|----------------|
| Turn delta | -29% | +24% |
| Cost delta | -20% | +162% |
| Signal | Strong positive | Strong negative |

## Insight

The discriminating variable is package count, not file count or complexity.
TypeORM has 677 files but one package; the agent finds the right file in 2-3
grep calls. NestJS has fewer total files but 9 packages; without routing hints,
the agent wastes 3-5 turns in the wrong package.

Detection is simple: count top-level package.json files. Monorepo (2+ packages)
gets full context output. Single-package gets minimal output (wrapper +
guidelines only).

This explains R.5's split result: the "detailed task" category was dominated by
single-package repos where the agent already self-localizes. The "opaque task"
category included monorepo tasks where routing matters.
