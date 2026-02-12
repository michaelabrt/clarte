# R.15: Plan Template Injection

## Status

Deprioritized (2026-03-07)

## Context

Stanford research on plan caching demonstrated ~50% cost reduction in agent benchmarks. The idea: derive a plan template from the dependency graph (which files to edit, in what order, what to check) and inject it into the agent's system prompt. The agent would follow the plan instead of discovering the edit sequence through exploration.

This was attractive because R.11 showed 59% of agent turns are exploration. A good plan could skip most of that.

## Why Deprioritized

Three factors:

1. **Task variance.** Plan templates assume a predictable task structure. Academic benchmarks use well-defined tasks (SWE-bench issues with clear reproduction steps). Real-world bug fixes vary too widely: the same repo can produce tasks that need 3 files or 30 files, simple type fixes or deep architectural changes. A single template cannot cover this range.

2. **User judgment.** After reviewing the Stanford results and the proposed implementation, the user judged plan templates not applicable to actual use cases. The cost savings depend on plan reuse across similar tasks, which does not match the distribution of real coding tasks.

3. **R.18 reframing.** The R.18 synthesis confirmed that the bottleneck is first-edit timing (r=0.70-1.00 correlation with total cost), not planning quality. Agents do not fail because they lack a plan; they fail because they lack confidence to start editing. Confidence injection (R.20 pre-flight) addresses the actual bottleneck without requiring plan structure.

## References

- R.11: Failure Pattern Detection (`memory/r11-failure-patterns.md`)
- R.18: 10-Agent Research Synthesis (`memory/r18-research-synthesis.md`)
- R.20: BM25 Edit-Target Retrieval (`memory/bm25-retrieval-research.md`)
