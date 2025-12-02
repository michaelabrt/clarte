# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 57 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/utils.ts` (Foundation, imported by 34 files), check dependents for breaking changes.
- When modifying `src/graph-analysis.ts` (Foundation, imported by 6 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (90% of the time).
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- `src/__tests__/golden/fixtures/ts-bottleneck/src/core/router.ts` is a structural chokepoint (separates 7 components). Refactor with extreme care.
- `src/utils.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/theme.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/graph-analysis.ts` (imported by 6 files) has no tests. Add test coverage before modifying.
- `src/index.ts` is a high-churn file (57 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (40 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/templates/main-context.ts` is a high-churn file (32 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/index.ts` is a Orchestrator file with high complexity (0 exports, 1000+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/graph-analysis.ts` is a Foundation file with high complexity (17 exports, 1200+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/detect.ts` is a Utility file with high complexity (6 exports, 899 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/detect.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/graph-analysis.ts` has multiple risk factors (no tests, tightly coupled). Add tests and Consider extracting an interface.
- `src/graph-build.ts` has multiple risk factors (no tests, tightly coupled). Add tests and Consider extracting an interface.
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/utils.ts`, also check: `src/cache.ts`, `src/check.ts`, `src/config-scan.ts`, `src/config.ts`.
- When modifying `src/graph-analysis.ts`, also check: `src/types.ts`, `src/centrality.ts`, `src/theme.ts`, `src/diff.ts`.
- When modifying `src/detect.ts`, also check: `src/types.ts`, `src/utils.ts`, `src/ast-parse.ts`, `src/diff.ts`.
- When modifying `src/theme.ts`, also check: `src/animations.ts`, `src/cache.ts`, `src/diff.ts`, `src/utils.ts`.
- When modifying `src/config.ts`, also check: `src/types.ts`, `src/utils.ts`, `src/ast-parse.ts`, `src/cache.ts`.
- `src/templates/main-context.ts` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/index.ts` (Orchestrator) | 0 files | stable |
| `src/utils.ts` (Foundation) | 34 files | stable |
| `src/graph-analysis.ts` (Foundation) | 6 files | stable |
| `src/detect.ts` (Utility) | 10 files | stable |
| `src/theme.ts` (Utility) | 24 files | stable |
| `src/watch.ts` | 2 files | 85% unstable ⚠️ |
| `src/config.ts` (Utility) | 5 files | stable |
| `src/delta.ts` (Utility) | 4 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, UPPER_SNAKE_CASE for constants
- **Prefer**: In `src/templates/`, use kebab-case for files
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 57 | 2 minutes ago |
| `README.md` | 40 | 3 days ago |
| `src/templates/main-context.ts` | 32 | 2 minutes ago |
| `src/summary.ts` | 31 | 2 minutes ago |
| `src/graph.ts` | 27 | 5 minutes ago |
| `src/snapshot.ts` | 26 | 2 minutes ago |
| `src/types.ts` | 26 | 70 minutes ago |
| `package.json` | 26 | 3 days ago |
| `CLAUDE.md` | 24 | 10 hours ago |
| `package-lock.json` | 21 | 3 days ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Jaccard |
|--------|--------|------------|---------|
| `src/index.ts` | `src/summary.ts` | 20 | 41% |
| `src/index.ts` | `src/templates/main-context.ts` | 24 | 45% |
| `src/generate.ts` | `src/index.ts` | 15 | 31% |
| `src/index.ts` | `src/types.ts` | 20 | 38% |
| `src/graph.ts` | `src/snapshot.ts` | 14 | 42% |
| `src/graph.ts` | `src/types.ts` | 13 | 36% |
| `package-lock.json` | `package.json` | 19 | 70% |
| `src/__tests__/hooks.test.ts` | `src/hooks.ts` | 5 | 83% |
| `src/templates/main-context.ts` | `src/types.ts` | 16 | 41% |
| `src/generate.ts` | `src/templates/main-context.ts` | 11 | 31% |

## Test Coverage Map

- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Must**: When modifying `src/detect.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/detect.test.ts` (unit)
- **Must**: When modifying `src/theme.ts`, run its tests: `src/__tests__/theme.test.ts` (unit)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/config.ts`, run its tests: `src/__tests__/config.test.ts` (unit)
- **Must**: When modifying `src/delta.ts`, run its tests: `src/__tests__/delta.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/graph-analysis.ts`, `src/graph-build.ts`, `src/centrality.ts`, `src/graph-cycles.ts`, `src/animations.ts`, `src/import-resolution.ts`
- **Prefer**: Follow existing test patterns in `src/__tests__/code-quality.test.ts` (most comprehensive test file)
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
src/
  __tests__/
scripts/
docs/
```

## Dead Files

Files not imported by any other source file. Candidates for removal or missing entry points.

- `scripts/copy-wasm.js`

## Cross-Cutting Files

These files are imported across multiple architectural layers. Changes here have wide blast radius.

| File | Imported By | Layers |
|------|------------|--------|
| `src/__tests__/golden/fixtures/ts-layered/types/index.ts` | 6 files | services, types, utils |

## Architectural Chokepoints

Files whose removal would disconnect parts of the codebase. Refactor with extreme care.

| File | Separates | Imported By |
|------|-----------|-------------|
| `src/__tests__/golden/fixtures/ts-bottleneck/src/core/router.ts` | 7 components | 4 files |
| `src/utils.ts` | 5 components | 34 files |
| `src/theme.ts` | 5 components | 24 files |
| `src/graph.ts` | 5 components | 22 files |
| `src/ast-parse.ts` | 5 components | 12 files |
| `src/git-analysis.ts` | 5 components | 4 files |
| `src/generate.ts` | 5 components | 3 files |
| `src/watch.ts` | 5 components | 2 files |
| `src/refresh.ts` | 5 components | 2 files |
| `src/hooks.ts` | 5 components | 2 files |

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/cache.ts` imports 15 names from `src/types.ts`
- `src/graph-analysis.ts` imports 15 names from `src/types.ts`
- `src/graph-build.ts` imports 14 names from `src/import-resolution.ts`
- `src/__tests__/golden/golden.test.ts` imports 13 names from `src/graph.ts`
- `src/index.ts` imports 12 names from `src/graph-analysis.ts`
- `src/__tests__/bench/pipeline.bench.ts` imports 12 names from `src/graph.ts`
- `src/watch.ts` imports 11 names from `src/graph-analysis.ts`
- `src/cache.ts` imports 9 names from `src/import-resolution.ts`
- `src/detect.ts` imports 9 names from `src/types.ts`
- `src/__tests__/cache.test.ts` imports 9 names from `src/cache.ts`

## Hidden Coupling

File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).

| File A | File B | Co-changes | Confidence | Graph Distance |
|--------|--------|------------|------------|----------------|
| `package-lock.json` | `package.json` | 19 | 70% | unreachable |

## Key Patterns

- angular commit style

## Development

```bash
npm install
npm run dev
```

```bash
npm run test
```

```bash
npm run build
```

<!-- Sections omitted to fit token budget: code-snapshot. Run clarte --full for full output. -->

<!-- clarte: generated 2026-02-25T23:19:36Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
