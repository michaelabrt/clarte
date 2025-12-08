# Experiment: Facade Map Section

**Branch:** `experimental/ongoing/cost-saving-sections`
**Date:** 2026-02-27
**Verdict:** NO-GO

## Theory

When a file is a barrel/index re-export file, agents waste a read on it before discovering they need the actual implementation files. A "Facade Map" section showing which barrel files route to which implementation files would let agents skip the barrel and go directly to source.

## Implementation

Exposed `barrelExportMap` (already computed in `graph-build.ts` but discarded) on the `ImportGraph` type. The map tracks named exports (`barrel -> { exportName -> sourceFile }`) and star exports (`barrel -> Set<sourceFile>`).

Changes:
- Added `barrelExportMap` field to `ImportGraph` in `types.ts`
- Attached `barrelMap` to the graph return in `graph-build.ts` when barrels exist
- Added serialization/deserialization in `cache.ts` (bumped cache version 2 -> 3)
- Rendered as a "Facade Map" table (P6) in `dependencies.ts`
- Added to section order in `main-context.ts`

### Files modified

| File | Change |
|------|--------|
| `src/types.ts` | Added `barrelExportMap` to `ImportGraph` |
| `src/graph-build.ts` | Attach `barrelMap` to graph return |
| `src/cache.ts` | Version bump 2->3, serialize/deserialize barrel export map |
| `src/templates/sections/dependencies.ts` | `renderFacadeMap()`, accept optional `ImportGraph` param |
| `src/templates/main-context.ts` | Added `"facade-map"` to section order, pass graph |
| `src/__tests__/cache.test.ts` | Updated version constant |

## Evaluation

### E.1: Deterministic (pass)

Build and all 965 tests passed. Section rendered correctly for projects with barrel files.

### E.2: Benchmark (2 reps, 4 tasks)

Ran alongside the API Surface experiment (could not isolate). Combined results showed regression on 3/4 tasks.

See api-surface.md for the full results table.

## Why It Failed

Two problems:

1. **Noise for small projects.** On the benchmark fixtures, only one barrel file was detected (from a test fixture's monorepo subfolder). The section rendered a single irrelevant row, adding tokens without any chance of being useful.

2. **Agents don't read barrel files anyway.** The import graph already resolves barrel re-exports, so the edges in the graph (and the directives derived from them) already point at the real implementation files. The Facade Map is solving a problem that the barrel resolution in `graph-build.ts` already solved at the graph level.

The section adds per-turn token cost for information the agent never acts on.

## Possible Future Directions

- Could be valuable for large monorepos with many barrel files (e.g., packages/core/index.ts re-exporting 20+ modules)
- Would need to be gated on barrel count (e.g., only render when >= 3 barrels exist)
- Even then, the value is questionable since the import graph already routes through barrels
- The underlying data plumbing (`barrelExportMap` on `ImportGraph`) could be useful for other purposes (e.g., better code snapshot filtering)
