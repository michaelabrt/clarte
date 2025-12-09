# Experiment: Context Optimization

**Branch:** `experimental/no-go/context-optimization`
**Date:** 2026-02-27
**Verdict:** NO-GO

## Theory

CLAUDE.md context is re-sent as input tokens on every API turn. Reducing token count compounds savings across all turns. Three optimizations were tested independently and in combination:

1. **Directive consolidation** - Merge per-file property facts (Foundation, chokepoint, untested, complexity, churn, risk factors) into single lines instead of 3-5 separate directives per file. Saves ~200 tokens (~7%) on Working Guidelines.
2. **Section trimming** - Push low-value sections (dead-files, chokepoints, tight-coupling, hidden-coupling, hot-files, change-coupling) above a FULL_ONLY_PRIORITY cutoff so they're excluded from default output. Saves ~600 tokens (~22%).
3. **Voice rewrite** - Change header from "This file is your starting point" to "Trust this context. Do NOT re-explore files described here." Intended to reduce redundant exploration.

Additionally, cross-cutting files were promoted from P9 to P5 (high-value type hub info), and conventions were promoted to P2 for Claude Code target.

## Implementation

### Directive consolidation
Refactored `buildDirectives()` in `src/templates/directives.ts` to use a two-phase approach:
- Phase 1: Collect per-file facts across all categories (Foundation guard, chokepoint, untested, complexity, risk flags) into a `Map<filePath, FileFacts>`
- Phase 2: Render one consolidated line per file with all facts in parenthetical tags, followed by merged advice
- Action directives (co-change, impact predictions) kept as separate lines

Example: `src/utils/logger.ts` went from 3 separate directives to 1 line:
```
`src/utils/logger.ts` (Foundation, imported by 10 files, chokepoint: separates 2 components, no tests).
Check dependents for breaking changes; refactor with extreme care; add test coverage before modifying.
```

### Section trimming
Added `FULL_ONLY_PRIORITY = 10` constant in `main-context.ts`. Sections with priority > 10 are excluded unless `--full` is passed. Bumped 8 sections to P11-P13.

### Voice rewrite
Changed header in `project-info.ts` and directive preamble in `directives.ts` to imperative WHEN-DO-WHY style.

### Files modified
- `src/templates/directives.ts` - directive consolidation, a/an grammar fix
- `src/templates/main-context.ts` - FULL_ONLY_PRIORITY mechanism
- `src/templates/sections/project-info.ts` - voice rewrite
- `src/templates/sections/dependencies.ts` - priority bumps
- `src/templates/sections/git-activity.ts` - priority bumps
- `src/templates/sections/architecture.ts` - priority bumps, key-files directive
- `src/graph/topo-order.ts` - new utility (not wired into output)

## What Was Tested

### E.1 (deterministic)
All gates passed: tsc, 965 vitest tests, 12 golden tests. Self-test on clarte showed correct consolidation.

### E.2 (isolated, 2 reps each)

**Round 1 - Full combo (all 3 optimizations):**

| Task | Cost Delta (w/ vs w/o) |
|------|----------------------|
| test-posts-resource | -24.9% |
| fix-task-transition | -19.7% |
| test-date-utils | -66.0% |
| fix-order-tax | **+16.8%** |

fix-order-tax regressed because section trimming dropped Cross-Cutting Files (which told the agent about `types/common.ts` as the type hub), and the voice told the agent not to explore beyond the (now incomplete) context.

**Round 2 - Isolated per-optimization on fix-order-tax:**

| Variant | Delta |
|---------|-------|
| Trim only | -26% |
| Voice only | -16% |
| Reorder only | -32% |
| **Combo** | **+63%** |

Each optimization helped individually, but the combination created a trap: critical type info removed + agent told not to explore = fix-test-fix spiral.

**Round 3 - After reverting voice and restoring priorities, keeping only directive consolidation:**

| Task | Baseline (main) | Fixed | Fixed vs Baseline |
|------|----------------|-------|-------------------|
| test-posts-resource | $0.348 | $0.217 | -37.8% |
| fix-task-transition | $0.171 | $0.196 | +14.9% |
| test-date-utils | $0.820 | $0.632 | -22.9% |
| fix-order-tax | $0.211 | $0.312 | **+47.6%** |

fix-order-tax still regressed vs baseline. The directive consolidation itself changes how the agent reads file relationships, and bug-fix tasks perform worse with the consolidated format.

## Why It Failed

1. **Section trimming is too blunt.** Removing entire sections loses critical signals (type hubs, coupling info) that agents use to navigate unfamiliar codebases. The budget system already handles this gracefully; a hard cutoff adds no value.

2. **"Trust this context, do NOT re-explore" backfires when context is incomplete.** Even without trimming, agents sometimes need to explore beyond what CLAUDE.md describes. The original wording ("This file is your starting point") guides without constraining.

3. **Directive consolidation changes information density in unpredictable ways.** Cramming 3-5 facts into one line may cause agents to skim rather than process each fact. The baseline's repetition (same file in multiple directives) may actually reinforce importance.

4. **Interaction effects are non-linear.** Each optimization tested fine in isolation but the combination was catastrophic. This matches prior findings (instability-feedback showed +13.3% isolated but +0% in combo).

## Possible Future Directions

- **Selective consolidation**: Only consolidate files with 4+ mentions (high redundancy), leave 2-3 mention files as separate directives
- **Cross-cutting promotion**: P9 to P5 for cross-cutting files may still be valuable, but needs isolated testing
- **Token savings via compaction, not removal**: Shorter table formats, abbreviations, or structured data instead of prose
- **Topo-ordering for co-change directives**: The utility exists but was never wired into output; could help agents modify files in correct dependency order
