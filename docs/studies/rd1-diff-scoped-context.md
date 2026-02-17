# R.D.1: Diff-Scoped Context

**Status:** Implemented, pending evaluation
**Branch:** `experimental/ongoing/rd1-diff-scoped-context`

## Hypothesis

Full CLAUDE.md has 2-4k tokens for every task. For a task scoped to 2-3 files,
directives like "when modifying X, also check Y, Z, W" on Orchestrator files
may send agents to files irrelevant to the task, wasting turns. There's a
7pp pass rate regression (93% vs 100% with full context on Sonnet) that may
be caused by exactly this pattern.

Scoping CLAUDE.md to the 2-hop neighborhood of changed files produces a
document that mentions only relevant files, preserves project-wide context
(conventions, architecture, config), and eliminates noise from the rest of
the codebase. This follows the same pattern as the 3 GO experiments: making
existing signals more precise, not adding new ones.

## Implementation

### Core primitive

`scopeContextAnalysis(analysis, relevantFiles)` in `src/core/scope-analysis.ts`:

- Filters all file-specific arrays and maps to entries touching `relevantFiles`
- Keeps project-wide fields unchanged: `layers`, `layerEdges`, `conventions`,
  `configConstraints`, `graphTopology`, `communities`, `monorepoAnalysis`
- Scopes `gitActivity` (hotFiles, changeCoupling, lagCouplings, commitCounts, fileChurn)
- Scopes `testMapping` (sourceToTests, untestedFiles; keeps testPattern/exemplarTestFile)

`scopeSnapshot(snapshot, relevantFiles, primaryLang, hasMultiLang)`:

- Filters `snapshot.entries` to relevant files
- Re-renders `snapshot.markdown` from filtered entries

### CLI surface

`clarte --diff [--scoped]` outputs a CLAUDE.md-shaped document to stdout
(or `--diff-file=PATH`) scoped to the 2-hop neighborhood of changed files.

### File changes

| File | Change |
|---|---|
| `src/core/scope-analysis.ts` | New - `scopeContextAnalysis`, `scopeSnapshot`, `scopeHubFiles`, `scopeCircularDeps` |
| `src/snapshot/snapshot.ts` | Export `renderMultiLangSnapshot` |
| `src/modes/diff.ts` | Add `scoped` param to `runDiffMode`, scoped output path, re-export moved helpers |
| `src/cli/args.ts` | Add `--scoped` flag parsing, conflict check, help entry |
| `src/index.ts` | Pass `scoped` to `runDiffMode` |
| `src/__tests__/scope-analysis.test.ts` | New - 22 unit tests |

### Key decisions

- `scopeHubFiles` and `scopeCircularDeps` moved from `diff.ts` to `scope-analysis.ts`,
  re-exported from `diff.ts` for backward compatibility. Avoids circular dependency.
- Uses `runAnalysis()` from `run-analysis.ts` rather than duplicating the pipeline.
  Side effects (analysis cache, delta snapshot) are acceptable.
- `--scoped` without `--diff` is an error.
- `--scoped` without `.clarte.json` is an error (config needed for `configToAnswers`).

## Evaluation plan

### E.1 (deterministic, run on this branch)

1. `npm run build` - no type errors
2. `npm run test` - all existing tests pass
3. `npx clarte --diff --scoped` on clarte itself produces valid markdown
4. Scoped output token count is <50% of `--diff` full output for a 2-3 file diff
5. Scoped output only references files within the 2-hop neighborhood

### E.2 (isolated LLM eval, run on clarte-benchmark)

Sonnet A/B at temp=0. Compare scoped context vs full CLAUDE.md on tasks with
known target files (single-file bug fixes, targeted changes). Measure:
- Pass rate
- Turn count (primary cost driver)
- Total tokens consumed

### E.3 (combinatorial benchmark, run on clarte-benchmark)

All feature combos at temp=0.3 vs vanilla baseline.

**GO gate:** Non-inferior overall (+0% or better on aggregate) AND >15% cost
reduction on the targeted-task subset (tasks where target file is in the changed
set).

**Hard NO-GO:** Pass rate drops below 90% on any fixture.

## Risk

Tasks where the agent needs to discover which files to change (no explicit
targets) may be under-informed by scoped context. The full `--diff` output
(without `--scoped`) remains available as fallback.

The scoped path runs `runAnalysis()` which writes an analysis cache and delta
snapshot. This is a side effect that doesn't occur in the standard `--diff`
path. Acceptable since these are local cache files.
