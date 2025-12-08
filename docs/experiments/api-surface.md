# Experiment: API Surface Section

**Branch:** `experimental/ongoing/cost-saving-sections`
**Date:** 2026-02-27
**Verdict:** NO-GO

## Theory

Agents waste tokens reading foundation files (e.g., `src/utils.ts`, `src/types.ts`) just to understand their exports. If the CLAUDE.md context included inline exported signatures for the top N hub files, agents could skip those reads entirely, saving exploration turns and input tokens.

## Implementation

Added `extractApiSurface()` to `src/snapshot.ts`: a thin wrapper around the existing tree-sitter `makeExtractor()` pipeline, scoped to specific files instead of scanning directories.

Rendered as a new "API Surface" section (P5) in `src/templates/sections/architecture.ts`:
- Selected top 5 Foundation/Utility hub files
- Called `extractApiSurface()` for those files
- Rendered compact one-liner signatures per file
- Capped at ~1200 chars total
- Used `compactSignature()` to condense multi-line signatures to single lines

Added `"api-surface"` to `SECTION_ORDER` in `main-context.ts` after `"key-files"`.

### Files modified

| File | Change |
|------|--------|
| `src/snapshot.ts` | New `extractApiSurface()` export |
| `src/templates/sections/architecture.ts` | `renderApiSurface()`, `compactSignature()`, `EXT_LANG_MAP` |
| `src/templates/main-context.ts` | Added `"api-surface"` to section order |

## Evaluation

### E.1: Deterministic (pass)

Build and all 965 tests passed. Section rendered correctly with proper formatting.

### E.2: Benchmark (2 reps, 4 tasks)

Ran alongside the Facade Map experiment (could not isolate). Combined results showed regression on 3/4 tasks vs baseline.

| Task | Baseline cost delta | Experimental cost delta | Direction |
|------|-------------------|------------------------|-----------|
| test-posts-resource:opaque | -31.8% | -18.7% | worse |
| fix-task-transition:opaque | -21.3% | -14.5% | worse |
| test-date-utils:opaque | -41.3% | -43.2% | ~same |
| fix-order-tax:opaque | -49.6% | -35.2% | worse |

## Why It Failed

The fundamental math doesn't work. The API Surface section added ~800 chars to the system prompt, which gets multiplied by the number of turns (8-14). That's 6,400-11,200 extra input chars per session. For this to break even, the agent would need to skip at least one file read per session. But agents don't work that way: they still read the actual files because they need implementation details, not just signatures. A function signature tells you what a function accepts and returns, but not how to call it correctly in context, what edge cases exist, or what the surrounding code looks like.

The section increases per-turn cost without reducing turns or exploration calls.

## Possible Future Directions

- Could work for very large foundation files (1000+ lines) where reading the file is genuinely expensive
- Would need to be gated on file size rather than hub status
- The agent would need explicit instructions like "Do NOT read this file; use the signatures below instead"
- Even then, most tasks require implementation context, not just signatures
