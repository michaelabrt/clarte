# R.17: Exploration Depth Nudge

## Status

Deprioritized (2026-03-07)

## Context

R.11 found that 59% of agent turns are exploration (reading files, searching, listing directories). Proposed injecting behavioral directives into CLAUDE.md to nudge agents toward shallower exploration: "Read at most N files before editing", "Start editing after 3 turns of exploration", etc.

This was motivated by the observation that agents over-explore. They read files they do not need, re-read files they already read and search for patterns they could infer from context. A hard nudge seemed like a low-cost intervention.

## Why Deprioritized

Subsumed by R.20 (pre-flight confidence injection). Two reasons:

1. **Wrong intervention point.** Nudging agents to explore less treats the symptom. The cause is uncertainty: agents explore because they do not know which files to edit. R.18 confirmed this - first-edit turn correlates with total cost at r=0.70-1.00. The fix is not "explore less" but "know more before you start."

2. **Pre-flight eliminates the need.** R.20 predicts edit targets from the task description using BM25F retrieval over the dependency graph. When agents receive a list of likely edit targets upfront, they skip the exploration phase naturally. No behavioral directive needed; the information itself changes the behavior.

R.19 also found that directive phrasing matters: "Always use X instead of Y" works, but softer instructions like "Try to limit exploration" get ignored. An exploration nudge would need aggressive phrasing, which risks suppressing necessary exploration on genuinely complex tasks.

## References

- R.11: Failure Pattern Detection (`memory/r11-failure-patterns.md`)
- R.18: 10-Agent Research Synthesis (`memory/r18-research-synthesis.md`)
- R.19: Composable Skill Primitives (`memory/r19-feasibility-spike.md`)
- R.20: BM25 Edit-Target Retrieval (`memory/bm25-retrieval-research.md`)
