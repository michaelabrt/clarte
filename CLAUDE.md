# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

Architecture intelligence engine for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 68 files)
- **TypeScript**
- **Biome** (linter/formatter)
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`
- **Prefer**: no unused variables (enforced by `correctness.noUnusedVariables`)
- **Style**: 2-space, double quotes, semicolons (Biome)

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/utils.ts` (Foundation, imported by 50 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (92% of the time).
- When modifying `src/types/graph.ts`, note that 140 files transitively depend on it -- API changes will cascade to all upstream dependents.
- When modifying `src/types/output.ts`, note that 139 files transitively depend on it -- API changes will cascade to all upstream dependents.
- When modifying `src/types/config.ts`, note that 139 files transitively depend on it -- API changes will cascade to all upstream dependents.
- `src/index.ts` is a high-churn file (78 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (55 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/templates/main-context.ts` is a high-churn file (42 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/modes/generate.ts` is an Orchestrator file with high complexity (2 exports, 402 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/utils.ts` is a Foundation file with medium complexity (11 exports, 134 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/core/run-analysis.ts` is an Orchestrator file with high complexity (2 exports, 435 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `package-lock.json`, you'll likely need to also update `package.json` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/utils.ts`, also check: `src/__tests__/code-quality.test.ts`, `src/__tests__/config-scan.test.ts`, `src/__tests__/conventions.test.ts`, `src/__tests__/diff-mode.test.ts`.
- When modifying `src/theme.ts`, also check: `src/__tests__/animations.test.ts`, `src/index.ts`, `src/__tests__/cli-args.test.ts`, `src/errors.ts`.
- When modifying `src/core/run-analysis.ts`, also check: `src/__tests__/animations.test.ts`, `src/__tests__/ast-parity.test.ts`, `src/__tests__/budget.test.ts`, `src/__tests__/run-analysis.test.ts`.
- When modifying `src/core/generate.ts`, also check: `src/__tests__/animations.test.ts`, `src/__tests__/ast-parity.test.ts`, `src/__tests__/budget.test.ts`, `src/__tests__/cache.test.ts`.
- When modifying `src/modes/diff.ts`, also check: `src/__tests__/diff-mode.test.ts`, `src/__tests__/animations.test.ts`, `src/__tests__/diff-relevance.test.ts`, `src/__tests__/ast-parity.test.ts`.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/modes/generate.ts` (Orchestrator) | 2 files | 90% unstable ⚠️ |
| `src/utils.ts` (Foundation) | 50 files | stable |
| `src/core/run-analysis.ts` (Orchestrator) | 3 files | 88% unstable ⚠️ |
| `src/modes/watch.ts` (Orchestrator) | 2 files | 92% unstable ⚠️ |
| `src/modes/diff.ts` (Orchestrator) | 3 files | 85% unstable ⚠️ |
| `src/modes/refresh.ts` (Orchestrator) | 2 files | stable |
| `src/theme.ts` (Utility) | 37 files | stable |
| `src/core/generate.ts` | 3 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `config` -> `hooks` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types, config -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, UPPER_SNAKE_CASE for constants, camelCase for files
- **Prefer**: In `src/`, use camelCase for constants (overrides project-wide camelCase)
- **Prefer**: In `src/parsers/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getOrSet`)
- **Prefer**: Use `is`/`has` prefixes for boolean-returning functions (e.g., `isTestFile`)
- **Prefer**: Named exports (no default exports)
- **Style**: Uses barrel files (1 index re-export files)
- **Style**: Import ordering: external-first

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 78 | 20 hours ago |
| `README.md` | 55 | 2 minutes ago |
| `src/templates/main-context.ts` | 42 | 20 hours ago |
| `package.json` | 33 | 32 hours ago |
| `src/types.ts` | 31 | 19 hours ago |
| `CLAUDE.md` | 28 | 3 days ago |
| `package-lock.json` | 26 | 32 hours ago |
| `src/templates/aider-context.ts` | 19 | 2 minutes ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Jaccard |
|--------|--------|------------|---------|
| `src/index.ts` | `src/templates/main-context.ts` | 29 | 39% |
| `src/index.ts` | `src/types.ts` | 22 | 31% |
| `package-lock.json` | `package.json` | 23 | 70% |
| `src/templates/main-context.ts` | `src/types.ts` | 18 | 37% |
| `package.json` | `tsup.config.ts` | 10 | 31% |

## Test Coverage Map

- **Must**: When modifying `src/modes/generate.ts`, run its tests: `src/__tests__/generate-mode.test.ts` (unit)
- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/diff-mode.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Must**: When modifying `src/core/run-analysis.ts`, run its tests: `src/__tests__/run-analysis.test.ts` (unit)
- **Must**: When modifying `src/modes/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/modes/diff.ts`, run its tests: `src/__tests__/diff-mode.test.ts` (integration), `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/modes/refresh.ts`, run its tests: `src/__tests__/refresh.test.ts` (unit)
- **Must**: When modifying `src/theme.ts`, run its tests: `src/__tests__/animations.test.ts` (unit), `src/__tests__/theme.test.ts` (unit)
- **Must**: When modifying `src/core/generate.ts`, run its tests: `src/__tests__/generate.test.ts` (unit), `src/__tests__/user-sections.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/cli/ci.ts`, `src/graph/data.ts`, `src/parsers/snapshot-go.ts`, `src/parsers/ts-imports.ts`, `src/cli/check.ts`, `src/parsers/go-imports.ts`, `src/parsers/java-imports.ts`, `src/parsers/python-imports.ts`, `src/parsers/rust-imports.ts`, `src/parsers/snapshot-java.ts`, `src/parsers/snapshot-python.ts`, `src/parsers/snapshot-rust.ts`, `src/parsers/snapshot-ts.ts`, `src/templates/sections/architecture.ts`, `src/templates/sections/dependencies.ts`
  (2 more untested files)
- **Prefer**: Follow existing test patterns in `src/__tests__/golden/golden.test.ts` (most comprehensive test file)
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
docs/
scripts/
src/
  __tests__/
  config/
  hooks/
  types/
```

## Dead Files

Files not imported by any other source file. Candidates for removal or missing entry points.

- `scripts/copy-wasm.js`
- `src/config/scan-rules.ts`
- `src/conventions/naming.ts`
- `src/graph/persist.ts`
- `src/types.ts`

## Cross-Cutting Files

These files are imported across multiple architectural layers. Changes here have wide blast radius.

| File | Imported By | Layers |
|------|------------|--------|
| `src/__tests__/golden/fixtures/ts-layered/types/index.ts` | 6 files | services, types, utils |

## Architectural Chokepoints

Files that bridge many upstream dependents to downstream dependencies. Changes to their exports will cascade.

| File | Upstream (dependents) | Downstream (deps) |
|------|-----------------------|-------------------|
| `src/types/graph.ts` | 140 files | 1 files |
| `src/types/output.ts` | 139 files | 4 files |
| `src/types/config.ts` | 139 files | 1 files |
| `src/types/index.ts` | 138 files | 7 files |
| `src/graph/centrality.ts` | 48 files | 9 files |
_...and 86 more_

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/graph/cache.ts` imports 15 names from `src/types/index.ts` (15 type-only)
- `src/graph/cache.ts` imports 14 names from `src/graph/import-resolution.ts`
- `src/graph/build.ts` imports 13 names from `src/graph/import-resolution.ts`
- `src/types/output.ts` imports 10 names from `src/types/analysis.ts` (10 type-only)
- `src/__tests__/cache.test.ts` imports 9 names from `src/graph/cache.ts`
- `src/__tests__/utils.test.ts` imports 8 names from `src/utils.ts`
- `src/__tests__/budget.test.ts` imports 7 names from `src/types/index.ts` (7 type-only)
- `src/__tests__/git-analysis.test.ts` imports 7 names from `src/git/analysis.ts`
- `src/core/generate.ts` imports 7 names from `src/types/index.ts` (7 type-only)
- `src/modes/generate.ts` imports 7 names from `src/types/index.ts` (7 type-only)

## Hidden Coupling

File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).

| File A | File B | Co-changes | Confidence | Graph Distance |
|--------|--------|------------|------------|----------------|
| `package-lock.json` | `package.json` | 23 | 70% | unreachable |

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

Linter: **biome**

After significant changes, use `/check` to verify no architectural regressions.

<!-- Sections omitted to fit token budget: code-snapshot. Run clarte --full for full output. -->

<!-- clarte: generated 2026-03-02T22:45:41Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
