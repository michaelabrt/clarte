# Experiment: R.18 - Research Synthesis

**Status:** Done (2026-03-07)

## Context

18 experiments over 3 weeks. 0/15 content, presentation and hook experiments
survived E.3 combinatorial benchmarking. Only 3/3 graph correctness fixes
shipped. The research needed a synthesis pass to extract the underlying
mechanism before continuing.

10 research agents analyzed 426 passing sessions (4775 turns) across all
conditions. Separate partition analysis on 3 repos (clarte, hono, zod).

## Method

### Session log deep-dive

Computed per-session metrics:
- **First-edit turn**: the turn number of the first Edit/Write call
- **Total turns**: session length
- **Phase splits**: exploration, edit, tail (using R.11 classification)
- **Correlation**: first-edit turn vs total turns

### Partition analysis

For each of 3 repos, analyzed multi-file commit history to measure how often
commits can be decomposed into independent sub-tasks:
- Connected component analysis on file co-change graphs
- Measured "meaningful decomposability" (2+ non-singleton components)

### Literature review

External research on plan caching, context distillation and agent efficiency.

## Results

### First-edit timing

| Metric | Value |
|--------|-------|
| Correlation (first-edit turn vs total turns) | r = 0.70 - 1.00 |
| Tasks where correlation holds | 15/19 |
| Impact of each delayed first-edit turn | ~1.3 additional total turns |

Per-condition first-edit timing:

| Condition | Avg first-edit turn |
|-----------|-------------------|
| With context | 5.0 |
| Placebo | 7.5 |
| No context | 7.8 |

Context moves the first edit 2.8 turns earlier. Each of those turns saves ~1.3
downstream turns, for a net saving of ~3.6 turns.

### Phase time breakdown

| Phase | Share of session time |
|-------|-------------------|
| Exploration | 55% |
| Edit | 14% |
| Tail (verification) | 31% |

31% of session time is tail: the agent re-running tests, re-reading files and
verifying its own work after the last edit.

### Multi-agent decomposition

| Repo | Meaningful decomposability |
|------|--------------------------|
| clarte | 14% |
| hono | 3% |
| zod | 8% |

Most multi-file commits are either fully connected (all files depend on each
other) or one main cluster plus singletons. Splitting into parallel sub-agents
would help on 3-14% of real-world tasks.

**Verdict: killed.** The decomposition ceiling is too low to justify the
orchestration overhead.

## Insight

Context does not help agents know more. It helps them start editing sooner.

The mechanism: when an agent sees "Key Files: src/foo.ts (51 importers)" and
"When modifying foo.ts, check bar.ts", it skips 2-3 turns of exploratory reads
and jumps to the edit. The information itself (51 importers) is not what the
agent uses; the confidence that these are the right files is what matters.

This reframes the product direction. "Edit src/foo.ts and src/bar.ts. Start
now." (directive) is qualitatively different from "src/foo.ts has 49 importers"
(information). The graph should make the decision; the agent should execute.

The untested direction: targeted confidence injection. Use the dependency graph
to predict edit targets, then emit a directive ("Edit these files") instead of
a description ("These files are important"). Zero reasoning overhead for the
agent.
