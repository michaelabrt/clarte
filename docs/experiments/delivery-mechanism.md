# Experiment Series: Delivery Mechanism (R.D series)

**Status:** Planned (not yet started)

## Background

Every experiment to date has touched the *content* of the context file: what signals
to include, how to rank files, how to phrase directives. None has touched *delivery*:
when context is provided, how it's scoped, or what mechanism carries it.

The meta-pattern from 14 experiments: only graph correctness fixes survived E.3.
Every attempt to be smarter about presentation or selection failed. This suggests
the *content* is close to optimal given the current delivery model. The untested
frontier is the delivery model itself.

**Core hypothesis:** Matching context scope to task scope reduces wasted turns
and the occasional failure from irrelevant directives, without losing the
information agents need for open-ended tasks.

---

## R.D.1 — Diff-Scoped Context

**Conviction: High**

### Theory

Full CLAUDE.md has ~2-4k tokens for every task. For a task scoped to 2-3 files,
the Key Files table, coupling pairs and directives that don't mention those files
are noise. Worse: change-impact directives like "when modifying X, also check Y,
Z, W" may send the agent to files it doesn't need, wasting turns.

Directed BFS from the changed file set produces a neighborhood containing:
- Hub file entries for files in the diff + direct neighbors
- Coupling pairs where at least one file is in the diff
- Directives mentioning those files
- Conventions and architecture (always relevant, unchanged)

This is the same class of fix as directed betweenness (making an existing
signal more precise) rather than adding new information.

### Implementation

New `clarte diff-context <file1> <file2> ...` mode. Outputs a scoped markdown
block, not a full CLAUDE.md. Intended for injection into the task message, not
a persistent rules file.

Key changes:
- `src/modes/diff.ts`: add `--diff-context` subcommand
- `src/templates/main-context.ts`: add `scopeToFiles(paths: string[])` filter
- New `src/graph/neighborhood.ts`: N-hop BFS from seed files; 1-hop for Key
  Files neighbors, 2-hop for coupling pairs

### Evaluation

**E.1:** For a 3-file diff, scoped context mentions only files within 2 hops.
Token count is <40% of full context.

**E.2:** Run Sonnet benchmark with scoped context injected in the task message
(replacing full CLAUDE.md) for tasks that have a known target file. Measure
cost delta vs. full context baseline.

**E.3:** Standard combinatorial benchmark. GO gate: non-inferior overall + the
targeted-task subset shows clear cost reduction (>15%).

**Hard NO-GO:** Pass rate drops below 90% on any fixture. Must not break tasks
that full context handles correctly.

### Risk

Tasks where the agent needs to discover which files to change are under-informed
by scoped context. Mitigation: fallback to full context when no explicit file
targets are in the task description.

---

## R.D.2 — Task-Type Context

**Conviction: Medium**

### Theory

Different task types benefit from different sections. A bug fix needs test
mapping and change-impact directives. A refactor needs coupling analysis and
chokepoints. A new feature needs conventions and architecture. The current
context weights all sections equally regardless of task type.

Simple keyword classification on the task description, with per-profile section
weights:

```
bug-fix:    test-map (×3), change-impact (×2), key-files (×1), conventions (×1)
refactor:   coupling (×3), chokepoints (×2), architecture (×2), key-files (×1)
feature:    conventions (×3), architecture (×2), key-files (×2), test-map (×1)
default:    all sections equal
```

### Implementation

A `--task-type <bug-fix|refactor|feature>` flag that adjusts section priority
weights inside `buildSections()`. Opt-in only (not inferred automatically).

### Risk

Section reordering experiments have a mixed track record. The difference in
selected sections may be small, and misclassification is easy. Run after R.D.1;
if R.D.1 already shows the gap is about *which files* are mentioned rather than
*which sections* are emphasized, R.D.2 is less interesting.

---

## R.D.3 — On-Demand Context via MCP Tool

**Conviction: Medium (different class of experiment)**

### Theory

CLAUDE.md is consumed passively — agents read it once at conversation start and
use it as background knowledge for all subsequent turns. The agent cannot ask
"what are the coupling pairs for this specific file?" or "which files import
this module?". Context is always push, never pull.

An MCP server serving structured graph queries lets agents request exactly what
they need, when they need it, rather than loading the full context speculatively.

### Proposed tools

```
clarte_key_files(path?: string) → hub files for project or subdir
clarte_dependencies(file: string) → direct importers and imports of a file
clarte_directives(file: string) → directives relevant to a specific file
clarte_conventions() → inferred naming and style conventions
```

The server reads from a pre-generated `.clarte-cache.json` rather than
re-analyzing on every call (sub-millisecond response).

### Evaluation design

Run benchmark tasks with:
a) Baseline (no context, no tools)
b) Full CLAUDE.md (current model)
c) MCP tools only, no CLAUDE.md

Compare cost, pass rate and turns across all three conditions.

**Why this is interesting even if it doesn't win:** It answers the question
definitively. If MCP on-demand matches full CLAUDE.md, the *content* is what
matters and the delivery model is irrelevant. If it outperforms, it opens a new
product direction and validates the pull model.

See also `mcp-tools.md` for prior exploration.

---

## Priority Order

1. **R.D.1** (diff-scoped): Most actionable. Follows the graph correctness
   pattern. Can reuse existing benchmark tasks by filtering to those with a
   known target file. Start here.

2. **R.D.3** (MCP on-demand): Answers a bigger question. Higher implementation
   effort. Run after R.D.1 has a result.

3. **R.D.2** (task-type): Lowest confidence. Run last or fold into R.D.1
   analysis (does scoped context perform differently by task type?).

---

## Connection to Pass Rate Regression

The current 93% vs 100% pass rate issue (7pp regression with full context on
Sonnet) is possibly related to delivery. Directives like "when modifying X, also
check Y, Z, W" on Orchestrator files may send agents to irrelevant files on
tasks that require focused changes. R.D.1 addresses this directly: scoped
context would not fire those directives if Y, Z and W are outside the 2-hop
neighborhood of the task's target files.
