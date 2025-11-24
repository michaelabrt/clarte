# Experiment: Content Deduplication

**Branch:** `experimental/ongoing/content-dedup`
**Date:** 2026-02-23
**Verdict:** NO-GO

## Theory

When clarte generates a CLAUDE.md, the same file paths appear across multiple sections: a file like `src/graph.ts` might be listed in Key Files (P2), Working Guidelines (P2), Recently Active Files (P7), Change Coupling (P7), Chokepoints (P9), and Tight Coupling (P10). Each mention consumes tokens. A post-render deduplication pass could remove redundant file path mentions from lower-priority sections, saving tokens without losing information (since the file is already referenced in higher-priority sections).

The hypothesis: removing redundant rows from P3+ sections reduces noise and context size, allowing either more content to fit within budget or a smaller, more focused context for the LLM.

## Implementation

Added `deduplicateSections()` to `src/templates/main-context.ts`:

1. Scan P0-P2 sections, collect all file paths into a "seen" set
2. Process P3+ sections in priority order
3. For each table row or bullet item, extract file paths
4. Remove the row if ALL paths in it are already "seen"
5. Add surviving paths to the "seen" set (accumulates across priorities)
6. Drop sections entirely when all data rows are removed
7. Recalculate token estimates for modified sections

Skip list: sections with unique structural data are never deduped (circular-deps, test-mapping, dead-files).

Called in `buildMainContext()` for both --full mode and budget mode, before budget allocation.

### Files modified

| File | Change |
|------|--------|
| `src/templates/main-context.ts` | `deduplicateSections()` + helpers (`extractFilePaths`, `removeRedundantRows`, `isTableSeparator`) |
| `src/__tests__/p3-quickwins.test.ts` | 9 unit tests for dedup logic |
| `src/__tests__/budget.test.ts` | Comment acknowledging dedup behavior |

## Evaluation

### E.1: Deterministic tests (15/15 pass)

9 unit tests covering: core dedup logic, P0-P2 protection, section dropping, skip-list, ALL-paths requirement, cross-priority accumulation, non-data section preservation, token recalculation.

### Round 1: Aggressive dedup (skip list: circular-deps, test-mapping, dead-files only)

Context size reduction: **-22.9%** (10,851 -> 8,362 bytes, 778 token savings).

Sections heavily affected:
- Recently Active Files: 9/10 rows removed
- Change Coupling: entire section removed (all 10 rows)
- Hidden Coupling: entire section removed
- Chokepoints: 8/10 rows removed
- Tight Coupling: 9/10 rows removed

#### E.2 (temp=0, 1 iteration, 6 tasks)

| Arm | Pass rate | Cost |
|-----|-----------|------|
| Baseline (no dedup) | 6/6 (100%) | $0.12 |
| Deduped | 3/6 (50%) | $0.10 |
| **Delta** | **-50%** | |

**Verdict: FAIL.** All 3 info-retention tasks regressed; all 3 reasoning tasks passed.

The dedup removed section-specific metadata that the LLM actually uses:
- dd-1 REGRESS: Hidden Coupling section fully removed. LLM can't identify package-lock.json/package.json as hidden coupling.
- dd-2 REGRESS: Tight Coupling rows removed. LLM can't report graph.ts/types.ts imports 19 names.
- dd-3 REGRESS: Chokepoint rows removed. LLM can't report utils.ts has 33 importers.

**Root cause**: The dedup treats a file path mention as "seen" regardless of context. But `src/graph.ts` in working-guidelines ("high churn, tightly coupled") carries different information than `src/graph.ts imports 19 names from src/types.ts` in tight-coupling. The file is "seen" but the per-section metadata is unique.

### Round 2: Conservative dedup (expanded skip list)

Added relationship sections to skip list: change-coupling, hidden-coupling, tight-coupling, chokepoints. These all carry per-pair metadata (confidence %, import counts, component counts) not captured in higher-priority sections.

Context size reduction: **-3.4%** (10,851 -> 10,483 bytes, 115 token savings). Remaining savings come only from hot-files rows (single-file listings where the file already appears in working-guidelines with the same churn data).

#### E.2 (temp=0, 1 iteration, 6 tasks)

| Arm | Pass rate | Cost |
|-----|-----------|------|
| Baseline | 6/6 (100%) | $0.12 |
| Deduped | 6/6 (100%) | $0.11 |
| **Delta** | **0%** | |

**Verdict: PASS** (non-inferiority confirmed, but no positive signal).

#### E.3-lite (temp=0.3, 2 iterations, 10 tasks)

| Arm | Iter 1 | Iter 2 | Aggregate | Cost |
|-----|--------|--------|-----------|------|
| Baseline | 10/10 | 10/10 | 20/20 (100%) | $0.33 |
| Deduped | 10/10 | 9/10 | 19/20 (95%) | $0.32 |
| **Delta** | **0%** | **-10%** | **-5%** | |

Per-category: dedup 9/10 (-1), architecture 10/10 (0). One flaky regression on dd-3 (utils.ts importer count) in iteration 2 only.

**Verdict: Technically PASS** (both iterations >= -10%, none < -15%), but no positive signal and a negative aggregate delta.

### Total eval cost

| Eval | Cost |
|------|------|
| E.2 round 1 (aggressive) | $0.22 |
| E.2 round 2 (conservative) | $0.23 |
| E.3-lite (conservative) | $0.65 |
| **Total** | **$1.10** |

## Why NO-GO

1. **Negligible savings.** After protecting relationship sections (which carry unique metadata), only 3.4% of tokens are saved (115 tokens on clarte). Not worth the complexity.
2. **Negative delta.** E.3 showed -5% aggregate with a regression. "Passing non-inferiority" with no upside is not enough to ship.
3. **The problem doesn't exist.** The working-guidelines section (P2) already mentions most important files. The redundancy is minimal after that, and what remains (relationship metadata) is unique per section.
4. **Budget system already handles this.** The priority-based budget allocation drops lowest-priority sections when space is tight. Dedup is solving the same problem with more complexity.

## Lessons learned

- **"Technically passes the gate" is not GO.** A feature must show clear positive value, not just non-inferiority with negligible savings. The -5% delta and 3.4% savings are a no-go signal even if the thresholds are technically met.
- **File path dedup loses metadata.** A file appearing in multiple sections is not truly redundant; each section carries different metadata (churn count vs coupling confidence vs component count). Dedup by file path is too coarse.
- **Run the aggressive version first.** The initial -50% regression on the aggressive skip list was the most informative result. It immediately showed which sections carry irreplaceable metadata, saving time on the iterative approach.
- **Self-referential evals have ceiling effects.** Clarte's own CLAUDE.md is small enough that both arms hit 100% on most tasks. Testing on a larger project where dedup has more material impact would give a cleaner signal, but the fundamental problem (negligible savings after protecting relationship sections) would remain.

## Possible future directions

- **Budget-aware dedup**: Only dedup as a compression strategy when sections are about to be dropped for budget. Shrink before you cut.
- **Metadata merging**: Instead of removing rows, merge per-section metadata into the highest-priority mention (e.g., annotate key-files rows with churn counts from hot-files).
- **Neither may be worth the complexity.** The priority/budget system already handles space pressure well.
