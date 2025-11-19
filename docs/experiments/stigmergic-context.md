# R.4 Stigmergic Context Experiment

**Branch**: `experimental/go/release-1.1.0` (deleted)
**Status**: NO GO (passed E.2 isolated eval with +6%, failed E.3 combo benchmark)
**Date**: 2026-02-21

## Theory

The Code Snapshot section currently renders full type/function signatures in code blocks (declarative: "this file contains X"). The hypothesis: replacing non-type entries with compact procedural pointers saves 30%+ tokens without losing useful information, because agents read the actual files when they need to modify them. Types and interfaces stay inline since agents reference their shapes constantly and cannot infer them without reading the file.

The term "stigmergic" comes from stigmergy (indirect coordination through environment modification). Instead of giving the agent full signatures, we leave compact pointers that guide the agent to the right file when it needs details.

## Implementation

### Two-tier rendering

1. **Declarative tier** (types, interfaces): Full signatures in code blocks, unchanged from current rendering via `renderCategoryTypified()`.

2. **Pointer tier** (functions, hooks, components, stores): Compact markdown table with three columns: File, Exports (compressed one-line signatures), Imported by.

### Signature compression

The `compressSignature()` function strips language-specific declaration prefixes:
- JS/TS: `export async function fetchUser(id: string): Promise<User>` becomes `fetchUser(id: string): Promise<User>`
- Python: `async def get_user(db: AsyncSession, user_id: int) -> User:` becomes `get_user(db: AsyncSession, user_id: int) -> User`
- Go: `func NewServer(cfg Config) *Server` becomes `NewServer(cfg Config) *Server`
- Rust: `pub async fn handle_request(req: Request) -> Response` becomes `handle_request(req: Request) -> Response`

### Exemplar collapsing

Hub files (imported by 4+ files) always get individual table rows. For the remaining low-importance files, directories with 3+ such files are collapsed into a single line: `**N [category] in dir/** (e.g. most-imported-file)`. The most-imported file in the group is chosen as the exemplar. This preserves navigational value for the most central files while compressing the long tail.

### Opt-in toggle

Activated via `CLARTE_STIGMERGIC=1` environment variable. The same entries are extracted and budget-filtered; only the rendering changes.

## Files modified

| File | Change |
|------|--------|
| `src/snapshot.ts` | Added `renderStigmergicSnapshot()`, `compressSignature()`, `renderPointerTable()`, `renderMultiLangStigmergicSnapshot()`. Added `stigmergic` param to `generateSnapshot()`. |
| `src/index.ts` | Read `CLARTE_STIGMERGIC` env var, pass to `generateSnapshot()`. |
| `src/__tests__/eval/stigmergic-eval.test.ts` | Eval test with synthetic fixtures for both rendering modes. |
| `src/__tests__/eval/stigmergic-benchmark.test.ts` | Real-world benchmark running on the clarte project itself. |

## Results

### Token comparison (synthetic fixtures)

| Fixture | Regular | Stigmergic | Total savings | Pointer-tier savings |
|---------|---------|------------|---------------|---------------------|
| react-fullstack | 988 tokens | 625 tokens | 36.7% | 45.0% |
| python-backend | 943 tokens | 421 tokens | 55.4% | 71.7% |

### Token comparison (real-world: clarte project)

| Metric | Value |
|--------|-------|
| Source files | 109 |
| Import graph edges | 491 |
| Snapshot entries | 166 (51 types, 115 pointer) |
| Regular tokens | 4,820 |
| Stigmergic tokens | 1,935 |
| **Total savings** | **59.9%** |
| **Pointer-tier savings** | **79.1%** |

### GO/NO GO criteria

| Criterion | Target | Result | Status |
|-----------|--------|--------|--------|
| Pointer-tier token reduction | >= 30% | 45.0% / 71.7% (synthetic), 79.1% (real) | PASS |
| Types/interfaces preserved | identical | verified | PASS |
| Directory coverage | all represented | verified | PASS |
| Existing tests pass | all | all | PASS |
| TypeScript strict mode | clean | clean | PASS |
| LLM A/B evaluation (E.2) | no regression | stigmergic 78% vs regular 67% (+11%) | PASS |

**Verdict: GO**

### LLM A/B evaluation (E.2)

18 tasks across 6 categories (file-location, dependency, type-understanding, architecture, modification-planning, code-generation) run against full CLAUDE.md in both regular and stigmergic rendering. Model: claude-sonnet-4-20250514, temperature 0.

**3-iteration consistency run** (calibrated tasks):

| Metric | Iter 1 | Iter 2 | Iter 3 |
|--------|--------|--------|--------|
| Regular | 78% | 78% | 78% |
| Stigmergic | 83% | 83% | 83% |
| Delta | +6% | +6% | +6% |
| Verdict | GO | GO | GO |

Per-category worst-case delta across all 3 runs: no category ever regressed. Stigmergic consistently won the `arch-3` task (directory comprehension) and never lost a task that regular passed.

Category breakdown (representative iteration):

| Category | Regular | Stigmergic | Delta |
|----------|---------|------------|-------|
| file-location | 3/3 | 3/3 | 0 |
| dependency | 3/3 | 3/3 | 0 |
| type-understanding | 0/3 | 0/3 | 0 |
| architecture | 2/3 | 3/3 | +1 |
| modification-planning | 3/3 | 3/3 | 0 |
| code-generation | 3/3 | 3/3 | 0 |

Across 5 total runs (2 initial + 3 consistency), stigmergic never lost a single task that regular passed (90 individual task comparisons). Total eval cost: ~$5.

**Negative control**: a deliberately degraded context (snapshot + key files + chokepoints stripped) scored 50-72% vs 72-78% regular, correctly producing NO_GO/ITERATE verdicts. This confirms the eval harness has discriminative power and would catch real regressions.

## What worked

- Markdown tables are dramatically more token-efficient than code blocks for function signatures
- Exemplar collapsing provides excellent compression for directories with many similar exports (e.g., route handlers, service methods)
- The two-tier split correctly preserves the high-value type information while compressing the lower-value function signatures
- LLMs perform at least as well (slightly better) with compact pointer-tier tables as with full code blocks

## E.3 Combo Benchmark (NO GO)

R.4 passed E.2 in isolation with a +6% delta (stigmergic 83% vs regular 78%). However, when combined with R.2 (typification) and R.3 (task-relevance) in the E.3 combinatorial benchmark (N=2 smoke test, temp=0.3, 30 tasks, all 8 feature combinations), the combined release showed a slightly negative delta vs baseline. No individual combination or the full triple produced a statistically significant improvement.

**Key lesson**: R.4's +6% isolated gain at temp=0 was a false positive. At temp=0.3 with real variance, the signal disappeared. Isolated evals at temp=0 are necessary but not sufficient; they can overstate improvement because near-deterministic outputs mask the noise floor. The E.3 combo benchmark at temp=0.3 is the real gate.

The stigmergic code remains on the deleted branch for reference.

## Possible future directions

- Revisit stigmergic rendering as a standalone experiment (without R.2/R.3) under E.3 conditions
- Adaptive tier selection: automatically promote frequently-accessed functions back to declarative tier based on usage patterns
- Tighten the type-understanding eval tasks (0/3 both conditions due to strict keyword matching, not a format issue)
