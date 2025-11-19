# R.2 Cartographic Typification Experiment

**Branch**: `experimental/go/release-1.1.0` (deleted)
**Status**: NO GO (passed E.2 isolated eval, failed E.3 combo benchmark)
**Date**: 2026-02-21

## Theory

Cartographic generalization is a map-making technique: when rendering a map at smaller scale, cartographers replace N similar features with a single pattern description plus a list of instances. Applied to code context, this means: when a codebase has many structurally similar hub files (e.g., 30 route handlers, 15 React components), describe the pattern once and list the instances, instead of describing each file individually.

Token cost drops from O(N * per-file-cost) to O(1 * pattern-cost + N * name-cost).

Four cartographic operators applied:
- **Typification**: Replace N similar files with "pattern + list of N instances"
- **Exaggeration**: Files with deviation from group norms are marked as exceptions and rendered individually
- **Amalgamation**: Tightly-coupled files in the same directory with the same role merge into a single group
- **Simplification**: Group members get reduced detail (just filenames), since the pattern covers their behavior

## Implementation

### Grouping logic (`typifyFiles()`)

Files are grouped by the key `(directory, role)`. Groups require 3+ members (configurable via `minGroupSize`). Within a group, members whose authority or importedBy score deviates by more than 2x the group mean are marked as exceptions and rendered individually (cartographic "exaggeration").

If too many exceptions push the group below `minGroupSize`, the entire bucket falls back to ungrouped (individual rendering).

### Trait extraction

Each group computes shared traits:
- Average authority score
- Average importedBy count
- Instability (shown when >50% of members are unstable)
- Common imports (files imported by >50% of members)
- Common importers (files that import >50% of members)

### Rendering (`renderTypifiedKeyFiles()`)

Two sections in the output:
1. **Individual table**: Ungrouped files + group exceptions, rendered as the traditional `| File | Imported By | Stability |` table
2. **Group descriptions**: Each group rendered as a compact line: `**N [role] files in dir/**: file1.ts, file2.ts, file3.ts` with shared traits (avg importers, instability, shared deps)

### Integration in `main-context.ts`

The typification path is tried first. If `typifyFiles()` finds groups, it uses `renderTypifiedKeyFiles()`. If no groups are found (common for projects with heterogeneous directory structures), it falls back to the traditional individual table. This means typification is always active but only changes output when it can actually help.

## Files modified

| File | Change |
|------|--------|
| `src/typification.ts` | New file. `typifyFiles()`, `renderTypifiedKeyFiles()`, `estimateTypificationSavings()`, types (`FileGroup`, `GroupTraits`, `TypificationResult`). |
| `src/templates/main-context.ts` | Integration: tries typification first, falls back to traditional table when no groups found. |
| `src/__tests__/typification.test.ts` | 13 unit tests covering grouping, rendering, exceptions, traits, edge cases. |
| `src/__tests__/eval/typification-eval.test.ts` | E.1 eval tests on both benchmark fixtures. |
| `src/__tests__/eval/typification-llm-tasks.ts` | 12 LLM eval tasks for typification A/B testing. |
| `src/__tests__/eval/typification-llm-eval.test.ts` | E.2 LLM A/B eval runner (python-backend fixture, 3 iterations). |

## Results

### Synthetic fixtures (E.1 eval)

| Fixture | Hub files | Groups | Files grouped | Ungrouped | Token savings |
|---------|-----------|--------|---------------|-----------|---------------|
| react-fullstack | 31 | 2 | 8 | 23 | 16.6% |
| python-backend | 25 | 5 | 16 | 9 | 38.3% |

### Real-world: clarte project

Typification finds **zero groups** on the clarte codebase. Each directory has files with different roles, so no `(directory, role)` bucket reaches 3 members. This is expected: clarte is a relatively small CLI tool with heterogeneous file structure, not a large application with repetitive patterns.

The feature correctly falls back to the traditional individual table with no output change.

### Where typification shines

Projects with repetitive structure benefit most:
- **API backends** with many route handlers in the same directory (python-backend: 38.3% savings)
- **React/Vue apps** with many page components or hooks (react-fullstack: 16.6% savings)
- **Monorepos** with many similar packages

Projects with unique file structures (like clarte) see no change, which is the correct behavior.

### GO/NO GO criteria

| Criterion | Target | Result | Status |
|-----------|--------|--------|--------|
| Groups found on synthetic fixtures | >= 1 group of 3+ files | 2 groups (react), 5 groups (python) | PASS |
| Token savings on grouped fixtures | > 0% | 16.6% / 38.3% | PASS |
| No lost directives | all preserved | verified | PASS |
| Chokepoints preserved | all present | verified (core/database.py) | PASS |
| Fallback for ungrouped projects | graceful | verified (clarte itself) | PASS |
| Existing tests pass | all | all 13 unit + 5 eval | PASS |
| TypeScript strict mode | clean | clean | PASS |
| LLM A/B evaluation (E.2) | no regression | typified 83% vs traditional 83% (0% delta) | PASS |

**Verdict: GO**

### LLM A/B evaluation (E.2)

12 tasks across 4 categories (file-location, dependency, architecture, modification-planning) run against the python-backend fixture in both traditional and typified rendering. Model: claude-sonnet-4-20250514, temperature 0.

**3-iteration consistency run**:

| Metric | Iter 1 | Iter 2 | Iter 3 |
|--------|--------|--------|--------|
| Traditional | 83% | 83% | 83% |
| Typified | 83% | 83% | 83% |
| Delta | 0% | 0% | 0% |
| Verdict | GO | GO | GO |

Per-category worst-case delta across all 3 runs: zero in every category. Typified never lost a single task that traditional passed (36 individual task comparisons per iteration, 108 total).

Category breakdown (representative iteration):

| Category | Traditional | Typified | Delta |
|----------|------------|----------|-------|
| file-location | 3/3 | 3/3 | 0 |
| dependency | 3/3 | 3/3 | 0 |
| architecture | 3/3 | 3/3 | 0 |
| modification-planning | 1/3 | 1/3 | 0 |

Total eval cost: ~$0.56.

### Bug found and fixed during LLM eval

The initial eval run (before the instability fix) produced ITERATE verdicts: `typ-arch-2` (instability question) consistently failed in the typified condition because grouped files lost their per-file instability percentages. Route files showing "83% unstable" in the traditional table were collapsed into "4 orchestrator files in `routes/`" with no instability info.

**Fix**: `renderTypifiedKeyFiles()` now includes instability data in group descriptions when >50% of members are unstable. The route group now renders as: `4 orchestrator files in routes/: auth.py, users.py, products.py, orders.py (avg 1 importers; 83% unstable)`.

After the fix, all 3 iterations produced GO with zero regressions.

## What worked

- The `(directory, role)` grouping key is simple and effective
- Exception detection via deviation threshold correctly identifies outliers (e.g., a dashboard page among simple pages)
- The automatic fallback in `main-context.ts` means the feature is always safe to deploy
- Common trait extraction (shared deps, shared importers) adds useful pattern information
- LLM A/B eval caught a real information loss (instability data) that was then fixed

## E.3 Combo Benchmark (NO GO)

R.2 passed E.2 in isolation (0% delta, no regressions). However, when combined with R.3 (task-relevance) and R.4 (stigmergic) in the E.3 combinatorial benchmark (N=2 smoke test, temp=0.3, 30 tasks, all 8 feature combinations), the combined release (R.2+R.3+R.4) showed a slightly negative delta vs baseline. No individual combination produced a statistically significant improvement.

The user's assessment: "do no harm but it doesn't improve anything and is even slightly worse. I wouldn't ship it as-is."

**Key lesson**: Isolated E.2 evals at temp=0 mask real variance. Features that show 0% or +6% delta in isolation can interact negatively when combined. The E.3 combo benchmark at temp=0.3 is the real gate.

R.2 was merged to main briefly but reverted (`85cabd4 revert: remove R.2 snapshot typification from main`). The typification code remains on the deleted branch for reference.

## Possible future directions

- Lower the `minGroupSize` threshold for projects with smaller directories (currently 3)
- Use import-pattern similarity in addition to `(directory, role)` for more nuanced grouping
- Revisit if E.3 methodology improves or if combined with different experiments that don't interact negatively
