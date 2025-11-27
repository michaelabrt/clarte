# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 55 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/graph.ts` (Foundation, imported by 31 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (90% of the time).
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- `src/__tests__/golden/fixtures/ts-bottleneck/src/core/router.ts` is a structural chokepoint (separates 7 components). Refactor with extreme care.
- `src/utils.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/graph.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/index.ts` is a high-churn file (55 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (40 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/templates/main-context.ts` is a high-churn file (30 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/graph.ts` is a Foundation file with high complexity (36 exports, 2400+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` is a Orchestrator file with high complexity (0 exports, 1000+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/watch.ts` is a Orchestrator file with high complexity (3 exports, 375 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/graph.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/detect.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/graph.ts`, also check: `src/types.ts`, `src/snapshot.ts`, `src/cache.ts`, `src/ast-parse.ts`.
- When modifying `src/cache.ts`, also check: `src/ast-parse.ts`, `src/graph.ts`, `src/types.ts`, `src/utils.ts`.
- When modifying `src/diff.ts`, also check: `src/theme.ts`, `src/utils.ts`, `src/cache.ts`, `src/graph.ts`.
- When modifying `src/watch.ts`, also check: `src/graph.ts`, `src/cache.ts`, `src/config.ts`, `src/theme.ts`.
- When modifying `src/index.ts`, also check: `src/generate.ts`, `src/types.ts`, `src/summary.ts`, `src/templates/main-context.ts`.
- `src/templates/main-context.ts` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/graph.ts` (Foundation) | 31 files | stable |
| `src/index.ts` (Orchestrator) | 0 files | stable |
| `src/watch.ts` (Orchestrator) | 2 files | 82% unstable ⚠️ |
| `src/diff.ts` | 2 files | 85% unstable ⚠️ |
| `src/cache.ts` | 4 files | stable |
| `src/__tests__/golden/golden.test.ts` | 0 files | stable |
| `src/__tests__/bench/pipeline.bench.ts` | 0 files | stable |
| `src/__tests__/graph-algorithms.test.ts` | 0 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, camelCase for files
- **Prefer**: In `src/templates/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 55 | 3 minutes ago |
| `README.md` | 40 | 2 days ago |
| `src/templates/main-context.ts` | 30 | 3 minutes ago |
| `src/summary.ts` | 30 | 4 days ago |
| `package.json` | 26 | 2 days ago |
| `src/snapshot.ts` | 25 | 15 hours ago |
| `src/types.ts` | 24 | 15 hours ago |
| `src/graph.ts` | 23 | 3 minutes ago |
| `CLAUDE.md` | 21 | 2 hours ago |
| `package-lock.json` | 21 | 2 days ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Jaccard |
|--------|--------|------------|---------|
| `src/index.ts` | `src/summary.ts` | 19 | 40% |
| `src/index.ts` | `src/templates/main-context.ts` | 22 | 43% |
| `src/generate.ts` | `src/index.ts` | 15 | 33% |
| `src/graph.ts` | `src/snapshot.ts` | 14 | 50% |
| `src/index.ts` | `src/types.ts` | 19 | 39% |
| `package-lock.json` | `package.json` | 19 | 70% |
| `src/__tests__/hooks.test.ts` | `src/hooks.ts` | 5 | 83% |
| `src/graph.ts` | `src/types.ts` | 12 | 39% |
| `src/templates/main-context.ts` | `src/types.ts` | 15 | 42% |
| `src/generate.ts` | `src/templates/main-context.ts` | 11 | 33% |

## Test Coverage Map

- **Must**: When modifying `src/graph.ts`, run its tests: `src/__tests__/bench/algorithms.bench.ts` (unit), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/bench/pipeline.bench.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/eval/benchmark.test.ts` (unit), `src/__tests__/eval/betweenness-real-projects.test.ts` (integration), `src/__tests__/eval/eval.test.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/golden/golden.test.ts` (unit), `src/__tests__/graph-algorithms.test.ts` (unit), `src/__tests__/graph-aliases.test.ts` (unit), `src/__tests__/graph.test.ts` (unit), `src/__tests__/integration/language-pipeline.test.ts` (integration), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (unit), `src/__tests__/summary.test.ts` (integration)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/diff.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/cache.ts`, run its tests: `src/__tests__/cache.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/animations.ts`, `src/templates/framework-hints.ts`
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
| `src/utils.ts` | 5 components | 33 files |
| `src/graph.ts` | 5 components | 31 files |
| `src/theme.ts` | 5 components | 24 files |
| `src/ast-parse.ts` | 5 components | 10 files |
| `src/git-analysis.ts` | 5 components | 4 files |
| `src/generate.ts` | 5 components | 3 files |
| `src/watch.ts` | 5 components | 2 files |
| `src/refresh.ts` | 5 components | 2 files |
| `src/hooks.ts` | 5 components | 2 files |

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/graph.ts` imports 19 names from `src/types.ts`
- `src/cache.ts` imports 15 names from `src/types.ts`
- `src/index.ts` imports 15 names from `src/graph.ts`
- `src/watch.ts` imports 14 names from `src/graph.ts`
- `src/__tests__/golden/golden.test.ts` imports 13 names from `src/graph.ts`
- `src/__tests__/bench/pipeline.bench.ts` imports 12 names from `src/graph.ts`
- `src/cache.ts` imports 9 names from `src/graph.ts`
- `src/detect.ts` imports 9 names from `src/types.ts`
- `src/__tests__/cache.test.ts` imports 9 names from `src/cache.ts`
- `src/__tests__/graph-algorithms.test.ts` imports 9 names from `src/graph.ts`

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

<!-- clarte: generated 2026-02-24T09:24:58Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
