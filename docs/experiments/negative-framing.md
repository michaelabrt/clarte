# Experiment: Negative Framing

**Date:** 2026-03-06
**Status:** No-go

## Hypothesis

Constraint-based language ("Do NOT modify X without checking Y", "NEVER add more upward dependencies") would be more salient to LLM agents than positive guidance ("When modifying X, also check Y"), leading to fewer missed co-change checks and fewer wasted turns.

Inspired by literature on instruction-following in LLMs, where negation and prohibition framing sometimes improves compliance.

## Implementation

Added `--experimental-negative-framing` CLI flag that threads a `framing: "positive" | "negative"` parameter through the generation pipeline. When `negative`, all directive-generating functions rewrite their output:

| Positive | Negative |
|----------|----------|
| `When modifying X, check Y` | `Do NOT modify X without checking Y` |
| `Do not add more upward dependencies` | `NEVER add more upward dependencies` |
| `Review recent changes before modifying` | `Do NOT modify without reviewing recent changes` |
| `Read thoroughly before modifying` | `Do NOT modify without reading thoroughly` |

Affected functions: `foundationGuards`, `coChangeHints`, `chokepointCaution`, `layerViolationWarnings`, `highChurnCaution`, `complexityWarnings`, `lagCouplingHints`, `changeImpactPredictions`, `renderTestMappingSection`.

## Results

Tested as variant D in R9 benchmark (TypeORM, SQLite simple-enum array issue, Sonnet, n=3):

| Condition | Avg Turns | Avg Cost | vs Placebo |
|-----------|-----------|----------|------------|
| placebo   | 31.3      | $0.61    | baseline   |
| negative  | 33.0      | $0.67    | +5.4% turns, +10% cost |

Per-run: 36t/$0.73, 32t/$0.66, 31t/$0.63.

## Analysis

Negative framing provides no benefit. Agents already follow positive instructions well; negating them adds cognitive overhead without changing behavior. The "Do NOT... without" construction is also slightly longer than the positive form, increasing token count for no gain.

This is consistent with the broader R9 finding: no content variant (E, D, F, C) beats placebo on single-package projects.

## Decision

No-go. Positive framing is retained as the default. Code changes reverted.
