# Experiment: Surprise-Based Token Budget Weighting

**Branch:** `experimental/no-go/surprise-scoring`
**Date:** 2026-02-21
**Verdict:** NO GO

## Theory

When an AI coding agent receives a context snapshot, the most valuable files aren't always the most central ones. A types file imported by 30 modules is important, but the agent can often infer its shape from usage. The truly valuable context comes from files that are *structurally surprising*: files that play an unexpected role in the codebase and whose behavior can't be inferred from their surroundings.

The hypothesis: boosting token allocation for structurally anomalous files would improve the quality of context snapshots, especially under tight token budgets.

## Implementation

Added a per-file surprise multiplier (range [1.0, 2.0]) computed from four signals:

| Signal | Weight | What it detects |
|--------|--------|-----------------|
| Convention deviation | 0.20 | Files that break the project's naming convention (e.g., snake_case file in a camelCase project) |
| Role-directory mismatch | 0.30 | Foundation files in UI directories, or Orchestrator files in types/config directories |
| Structural anomaly | 0.30 | Hidden bridges (high betweenness, low authority), fragile foundations (high instability, high fan-in), cross-cutting files with low centrality, low-authority chokepoints |
| Hidden coupling | 0.20 | Files involved in structural-temporal mismatches (co-change frequently but structurally distant) |

The multiplier was applied during `applyTokenBudget`'s submodular greedy selection:

```
value = (centrality * categoryBoost * gitBoost * surpriseMultiplier) / tokens
```

### Files

- `src/surprise.ts` - signal computation (238 lines)
- `src/__tests__/surprise.test.ts` - unit tests (435 lines)
- `src/__tests__/eval/surprise-eval.test.ts` - fixture eval with GO/NO GO criteria (397 lines)
- `src/snapshot.ts` - integration point (13 lines changed)
- `src/conventions.ts` - exported `classifyFilename` for signal 1 (2 lines changed)

## What We Tested

### 1. Fixture eval (synthetic)

Ran surprise scoring on two benchmark fixtures (react-fullstack 31 files, python-backend 25 files) with enriched analysis (betweenness scores, mock conventions, mock structural mismatches).

**Result:** GO on both fixtures. Foundation files retained their rank, at least one structurally anomalous file got promoted per fixture.

### 2. Real-world A/B on Hono (306 TS files)

Ran clarte with and without surprise scoring on the Hono web framework under a tight 2000-token budget, then compared which snapshot entries were included/excluded.

### 3. LLM quality eval (Sonnet 4.6)

Gave each snapshot (WITH and WITHOUT surprise) to Sonnet 4.6 with 8 developer questions about Hono internals. Scored answers as HIGH (2), MEDIUM (1), or LOW (0) confidence.

## Results

### Formula v1: range [0.5, 2.5] (boost and penalize)

The original formula could both boost surprising files and penalize unsurprising ones. Under tight budget:

- Lost `jwt/jwt.ts` and `ipaddr.ts` (penalized below selection threshold)
- LLM eval: WITH scored 11, WITHOUT scored 13 (delta: -2)

### Formula v2: range [1.0, 2.0] (boost only, never penalize)

Changed to boost-only to eliminate the penalty regression:

- Retained `jwt/jwt.ts` (main regression fixed)
- Lost `concurrent.ts` and `ipaddr.ts` (displaced by boosted files)
- LLM eval: WITH v2 scored 11, WITHOUT scored 13 (delta: -2)

| Question | WITHOUT | WITH v1 | WITH v2 |
|----------|---------|---------|---------|
| Q1: Cookie parsing | HIGH (2) | HIGH (2) | HIGH (2) |
| Q2: URL routing | HIGH (2) | HIGH (2) | HIGH (2) |
| Q3: JWT decode | MEDIUM (1) | LOW (0) | MEDIUM (1) |
| Q4: IPv6 expansion | MEDIUM (1) | LOW (0) | LOW (0) |
| Q5: Base64 encoding | HIGH (2) | HIGH (2) | HIGH (2) |
| Q6: HTTP status types | HIGH (2) | HIGH (2) | HIGH (2) |
| Q7: HTML escaping | HIGH (2) | HIGH (2) | HIGH (2) |
| Q8: Concurrent pool | MEDIUM (1) | MEDIUM (1) | LOW (0) |
| **Total** | **13** | **11** | **11** |

### Key finding

At normal budgets (default 10K+ tokens), surprise scoring had zero effect because the budget wasn't binding; all files fit regardless of ranking. At tight budgets where it does matter, it consistently made things worse: the files it promoted were less useful than the ones they displaced.

## Why It Failed

1. **Zero-sum displacement.** Under a binding budget, boosting file A always displaces file B. The "boost-only" guarantee only means no file's *own* score decreases, but in a competitive selection, promotion and demotion are two sides of the same coin.

2. **Signals lack precision.** The four signals detect structural anomalies, but "structurally surprising" does not mean "useful for an AI agent." A hidden bridge file might be architecturally interesting but contain no types or signatures worth including in a snapshot. The signals have high recall for anomalies but low precision for usefulness.

3. **Existing ranking is already strong.** The combination of HITS authority, category boosts, and git-activity weighting already does a good job selecting the most useful files. Surprise scoring needs to beat a strong baseline, and the marginal files it promotes don't clear that bar.

## Possible Future Directions

- **Smarter signals:** Instead of structural anomaly detection, use content-aware signals (e.g., does this file define types that are used but never fully visible in the snapshot?).
- **Deficit-based boosting:** Rather than boosting "surprising" files, detect coverage gaps in the selected snapshot and fill them. This addresses the displacement problem directly.
- **User feedback loop:** Let users mark which snapshot entries were useful/useless and learn weights from that signal.
