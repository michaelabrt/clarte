# R.13: Hidden Edge Recovery (Framework DI Injection)

**Status:** Stale, not evaluated
**Branch:** `experimental/ongoing/r13-hidden-edge-recovery`

## Hypothesis

NestJS and Angular use decorator-based dependency injection (`@Module`, `@NgModule`)
that wires providers, controllers and imports via arrays invisible to static import
analysis. These "hidden edges" cause clarte to undercount in-degree for DI-wired
files, producing incorrect instability scores and missing change-coupling paths.

Injecting synthetic edges for decorator-declared dependencies should improve graph
accuracy for projects using these frameworks.

## Implementation

`src/graph/framework-edges.ts` - post-processing pass after graph construction:

- Scans `.ts` files for `@Module(...)` and `@NgModule(...)` decorators
- Extracts class names from `providers`, `controllers`, `imports`, `exports` arrays
  using balanced-bracket extraction
- Maps class names to file paths via existing import edges (reverse lookup)
- Injects synthetic `ImportEdge` records with `isFrameworkInferred: true`
- Updates `inDegree`/`directInDegree` for newly injected edges
- Skips duplicate edges; framework edges are not cached

Also includes `856609a fix: render test map for all tested files, not just hubs`.

## Why stale

Branch diverged significantly from main (~200 files changed) during the MCP server
merge and subsequent cleanup. The feature commits (2) are sound but would need
rebasing. Never reached E.2/E.3 evaluation.

## Evaluation (not run)

Would need a NestJS or Angular project in the benchmark suite to measure impact.
The TypeORM benchmark repo uses DI but not decorator-based module wiring.
