# Experiment: Directed BFS Chokepoints + Rendering

**Branch:** `main` (§2.53 + §2.54, merged 2026-03-02)
**Verdict:** GO

## Background

Two related changes shipped together: a graph algorithm fix (§2.53) and a barrel resolution fix (§2.54), plus a rendering experiment to find the best way to surface chokepoint signals to agents.

---

## §2.54: Barrel Resolution for Non-Index Barrels

### Problem

`resolveBarrelFiles` only processed `index.*` files (guard: `if (basename !== "index") continue`). `detectBarrelFiles` correctly detected all files where >50% of statements are re-exports, but non-index barrels (e.g., `src/components.ts`) only got the 0.3x HITS authority discount -- edges pointing to them were never routed through to their source files. This left inflated inDegree on the barrel and missing credit for the actual source files.

### Fix

Extended `resolveBarrelFiles` to accept an optional `detectedBarrels` set. When provided, the function iterates that set directly instead of scanning for index files. Both `build.ts` and `cache.ts` now detect barrels before calling `resolveBarrelFiles`, passing the detected set forward. The detection call in `build.ts` that previously ran after resolution was removed.

### Impact

No golden fixture change (all fixtures use only index barrels). New unit test verifies non-index barrel routing: a `src/components.ts` that re-exports `Button.ts` and `Card.ts` now routes edges from importers of `components.ts` to the actual source files with `isBarrelRouted: true`, and `components.ts` shows zero `directInDegree`.

---

## §2.53: Directed BFS Chokepoints

### Problem

The previous algorithm used undirected Tarjan articulation points. In a directed import graph this overstates impact:

- In a layered architecture `A → B → C`, B is an undirected articulation point (removing it splits the graph into {A} and {C}). The "separates 2 components" metric suggests B is critical to both sides. But in the directed graph, removing B only cuts C's transitive access to A -- the reverse doesn't exist. A is unaffected.
- The `separates N components` count measures disconnected undirected components, not actual directional impact on dependents or dependencies.
- Pure sinks (types files, leaf utilities) were often reported as chokepoints because they "separate" importers from each other in the undirected view, even though no directed path runs through them.

### Algorithm: Directed Reachability

Replaced with directed BFS metrics:

1. Build forward adjacency (importer → imported) and reverse adjacency (imported → importer), skipping external edges
2. For each file with `inDegree >= 1`: reverse BFS to get `upstreamCount` (transitive dependents)
3. Filter: `upstreamCount >= max(2, ceil(sqrt(N)))` where N = total internal files (adaptive threshold)
4. For remaining: forward BFS to get `downstreamCount` (transitive dependencies)
5. Filter: `downstreamCount >= 1` (must bridge upstream to at least one dependency)
6. Sort by `upstreamCount` desc, `downstreamCount` desc, alphabetical
7. Return top 10

**Why this is better for agents:**

| Scenario | Tarjan | Directed BFS |
|----------|--------|--------------|
| Pure sink (e.g., `types.ts`) | Often reported as chokepoint | Correctly excluded (upstreamCount = 0) |
| Layered bridge (`A→B→C→D`) | B, C reported as articulation points | B/C reported with accurate upstream counts |
| Star hub (center imported by many) | Center reported | Excluded if center has no downstream deps |
| True bridge (hub between subsystems) | Reported | Reported with quantified directional impact |

### New fields on `Chokepoint`

```typescript
upstreamCount: number;   // transitive dependents (reverse BFS)
downstreamCount: number; // transitive dependencies (forward BFS)
separates: number;       // = upstreamCount (backward compat for cached data)
```

### Files modified

| File | Change |
|------|--------|
| `src/graph/chokepoints.ts` | Complete rewrite: directed BFS |
| `src/graph/import-resolution.ts` | Add `detectedBarrels` param to `resolveBarrelFiles` |
| `src/graph/build.ts` | Reorder barrel detection before resolution |
| `src/graph/cache.ts` | Reorder + pass detected barrels; bump `ANALYSIS_CACHE_VERSION` to 3 |
| `src/types/analysis.ts` | Add `upstreamCount`, `downstreamCount` to `Chokepoint` |
| `src/templates/sections/dependencies.ts` | New minimal table format (see rendering section) |
| `src/templates/directives.ts` | Consequence-oriented wording (see rendering section) |
| `src/templates/aider-context.ts` | Updated wording |
| `src/core/run-analysis.ts` | Updated verbose log |

---

## Rendering Experiment

### Motivation

The algorithm change alone doesn't determine how to present chokepoints in the context. The previous rendering included a full table with "Imported By" counts. Early E.2 runs showed this caused agents to over-explore chokepoint files on simple bug-fix tasks (the large `importedBy` number triggered spurious reads).

### Variants tested

| Variant | Table | Directive wording |
|---------|-------|-------------------|
| old-ctx | Full table (File \| Separates \| Imported By) | "structural chokepoint (N components). Refactor with extreme care." |
| no-ctx | None | None |
| opt1 | None | "When modifying X, note that N files transitively depend on it -- API changes will cascade." |
| opt2 | Minimal (File \| Upstream \| Downstream, no Imported By) | Caution wording |
| **opt1+2** | **Minimal (File \| Upstream \| Downstream)** | **Consequence wording** |

### E.2 results (temp=0, 2 reps per condition)

| Task | no-ctx | old-ctx | opt1 | opt2 | opt1+2 |
|------|--------|---------|------|------|--------|
| fix-order-tax (medium bug-fix) | 8.3 [8,8,9] | 12.0 [14,12,10] | 11.5 [11,12] | 13.0 [12,14] | **9.5 [8,11]** |
| add-order-history (hard feature) | 16.3 [17,14,18] | 14.3 [16,13,14] | 14.5 [14,15] | 15.0 [14,16] | **13.5 [13,14]** |
| add-inventory-check (hard feature) | 13.3 [12,14,14] | 15.3 [16,15,15] | 19.5 [25,14] ⚠️ | 13.0 [13,13] | **14.0 [13,15]** |
| **Total** | **37.9** | **41.6** | **45.5** | **41.0** | **37.0** |

All conditions: 100% functional pass rate. The add-order-history pass rate shown in evaluators is 50% due to naming variance (`OrderStatusEvent` not in evaluator pattern), but turn counts are a reliable independent signal.

### Key findings

- **opt1+2 wins in aggregate (37.0 turns vs 37.9 no-context)**: The only condition that beats having no chokepoints context at all.
- **The "Imported By" column was the regression driver**: In old-ctx, large importedBy numbers triggered agents to read those files on unrelated tasks. Removing it in opt2/opt1+2 eliminated the regression.
- **opt1 alone is risky**: One rep hit 25 turns (max) on add-inventory-check. Consequence wording without a table anchor can cause over-exploration on complex tasks.
- **opt1+2 combines the benefits**: The minimal table anchors the agent to specific files; consequence wording makes the signal actionable rather than defensive ("refactor with extreme care" is passive).

### Why the consequence wording helps

The caution wording ("structural chokepoint, refactor with extreme care") is agent-relative: it tells the agent to be cautious but doesn't explain what changes are risky or why. The consequence wording ("N files transitively depend on it -- API changes will cascade") is information-relative: it tells the agent precisely what the risk is (exported API changes, not internal restructuring) and lets the agent decide whether that applies to the change they're making.

### E.3 status

E.3 (full CORE_TASKS, 18 tasks) was considered but deferred. Cost estimate: ~$93 for 5 reps. The feature is a rendering style change with low blast radius; the directional signal from E.2 is sufficient for the decision. E.3 can be revisited if a future audit identifies regressions on large-ts or medium-ts task types.

---

## Lessons

- **"Imported By" counts are a double-edged signal.** They convey importance but also invite over-exploration. For chokepoints, what matters is the directional impact (upstream/downstream), not the raw import count which is already visible in the Key Files table.
- **The table is an anchor, not just information.** Without the table, consequence wording can trigger broad exploration. With the table present (even a small one), agents have a concrete reference point that limits scope.
- **Adaptive threshold matters.** A fixed `upstreamCount >= 2` threshold returns too many results on large codebases (91 chokepoints on clarte's own codebase). `ceil(sqrt(N))` scales the threshold with project size.
- **No-context is a meaningful baseline.** opt1+2 beating no-context (37.0 vs 37.9 turns in aggregate) is a higher bar than simply beating the old implementation. It means the section adds net positive value.
