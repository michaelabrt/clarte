# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 51 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/graph.ts` (Foundation, imported by 30 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (90% of the time).
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- `src/utils.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/graph.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/theme.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/index.ts` is a high-churn file (53 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (40 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/summary.ts` is a high-churn file (30 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/graph.ts` is a Foundation file with high complexity (36 exports, 2400+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` is a Orchestrator file with high complexity (0 exports, 971 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/watch.ts` is a Orchestrator file with medium complexity (3 exports, 359 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/templates/main-context.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/graph.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/detect.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/graph.ts`, also check: `src/snapshot.ts`, `src/diff.ts`, `src/monorepo-analysis.ts`, `src/refresh.ts`.
- When modifying `src/utils.ts`, also check: `src/check.ts`, `src/config-scan.ts`, `src/config.ts`, `src/conventions.ts`.
- When modifying `src/cache.ts`, also check: `src/theme.ts`, `src/types.ts`, `src/utils.ts`, `src/diff.ts`.
- When modifying `src/diff.ts`, also check: `src/theme.ts`, `src/utils.ts`, `src/animations.ts`, `src/detect.ts`.
- When modifying `src/watch.ts`, also check: `src/config.ts`, `src/detect.ts`, `src/config-scan.ts`, `src/types.ts`.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/graph.ts` (Foundation) | 30 files | stable |
| `src/index.ts` (Orchestrator) | 0 files | stable |
| `src/watch.ts` (Orchestrator) | 2 files | 82% unstable ⚠️ |
| `src/diff.ts` | 2 files | 85% unstable ⚠️ |
| `src/cache.ts` | 4 files | stable |
| `src/utils.ts` (Utility) | 33 files | stable |
| `src/__tests__/golden/golden.test.ts` | 0 files | stable |
| `src/__tests__/bench/pipeline.bench.ts` | 0 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, camelCase for files
- **Prefer**: In `src/theme.ts/`, use camelCase for constants (overrides project-wide camelCase)
- **Prefer**: In `src/templates/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 53 | 10 hours ago |
| `README.md` | 40 | 8 hours ago |
| `src/summary.ts` | 30 | 3 days ago |
| `src/templates/main-context.ts` | 28 | 10 hours ago |
| `package.json` | 26 | 8 hours ago |
| `src/snapshot.ts` | 24 | 9 hours ago |
| `src/types.ts` | 23 | 2 days ago |
| `src/graph.ts` | 21 | 8 hours ago |
| `package-lock.json` | 21 | 9 hours ago |
| `CLAUDE.md` | 18 | 8 hours ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/index.ts` | `src/summary.ts` | 19 | 42% |
| `src/index.ts` | `src/templates/main-context.ts` | 20 | 41% |
| `src/generate.ts` | `src/index.ts` | 14 | 32% |
| `src/index.ts` | `src/types.ts` | 19 | 41% |
| `package-lock.json` | `package.json` | 19 | 70% |
| `src/__tests__/hooks.test.ts` | `src/hooks.ts` | 5 | 83% |
| `src/graph.ts` | `src/snapshot.ts` | 13 | 50% |
| `src/templates/main-context.ts` | `src/types.ts` | 15 | 45% |
| `src/__tests__/git-analysis.test.ts` | `src/git-analysis.ts` | 3 | 33% |
| `src/templates/aider-context.ts` | `src/templates/main-context.ts` | 11 | 39% |

## Test Coverage Map

- **Must**: When modifying `src/graph.ts`, run its tests: `src/__tests__/bench/algorithms.bench.ts` (unit), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/bench/pipeline.bench.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/eval/benchmark.test.ts` (unit), `src/__tests__/eval/eval.test.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/golden/golden.test.ts` (unit), `src/__tests__/graph-algorithms.test.ts` (unit), `src/__tests__/graph-aliases.test.ts` (unit), `src/__tests__/graph.test.ts` (unit), `src/__tests__/integration/language-pipeline.test.ts` (integration), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (unit), `src/__tests__/summary.test.ts` (integration)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/diff.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/cache.ts`, run its tests: `src/__tests__/cache.test.ts` (unit)
- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
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
| `src/utils.ts` | 4 components | 33 files |
| `src/graph.ts` | 4 components | 30 files |
| `src/theme.ts` | 4 components | 24 files |
| `src/ast-parse.ts` | 4 components | 9 files |
| `src/git-analysis.ts` | 4 components | 4 files |
| `src/generate.ts` | 4 components | 3 files |
| `src/refresh.ts` | 4 components | 2 files |
| `src/watch.ts` | 4 components | 2 files |
| `src/hooks.ts` | 4 components | 2 files |
| `src/diff.ts` | 4 components | 2 files |

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/graph.ts` imports 19 names from `src/types.ts`
- `src/index.ts` imports 15 names from `src/graph.ts`
- `src/cache.ts` imports 15 names from `src/types.ts`
- `src/watch.ts` imports 14 names from `src/graph.ts`
- `src/__tests__/bench/pipeline.bench.ts` imports 12 names from `src/graph.ts`
- `src/__tests__/golden/golden.test.ts` imports 12 names from `src/graph.ts`
- `src/detect.ts` imports 9 names from `src/types.ts`
- `src/__tests__/cache.test.ts` imports 9 names from `src/cache.ts`
- `src/__tests__/graph-algorithms.test.ts` imports 9 names from `src/graph.ts`
- `src/templates/main-context.ts` imports 8 names from `src/types.ts`

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

<!-- clarte: generated 2026-02-23T04:33:49Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
