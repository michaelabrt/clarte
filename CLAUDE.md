# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 53 files)
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

- When modifying `src/utils.ts` (Foundation, imported by 45 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (91% of the time).
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- `src/__tests__/golden/fixtures/ts-bottleneck/src/core/router.ts` is a structural chokepoint (separates 7 components). Refactor with extreme care.
- `src/utils.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/theme.ts` is a structural chokepoint (separates 5 components). Refactor with extreme care.
- `src/index.ts` is a high-churn file (63 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (41 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/templates/main-context.ts` is a high-churn file (37 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/index.ts` is an Orchestrator file with high complexity (0 exports, 479 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/utils.ts` is a Foundation file with medium complexity (11 exports, 134 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/run-analysis.ts` is an Orchestrator file with high complexity (2 exports, 433 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/templates/main-context.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/snapshot.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/generate.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/run-analysis.ts` has multiple risk factors (no tests, tightly coupled). Add tests and Consider extracting an interface.
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/utils.ts`, also check: `src/cache.ts`, `src/centrality.ts`, `src/change-impact.ts`, `src/check.ts`.
- When modifying `src/types.ts`, also check: `src/index.ts`, `src/templates/main-context.ts`, `src/__tests__/ast-parity.test.ts`, `src/cache.ts`.
- When modifying `src/generate.ts`, also check: `src/detect.ts`, `src/index.ts`, `src/snapshot.ts`, `src/animations.ts`.
- When modifying `src/diff.ts`, also check: `src/animations.ts`, `src/cache.ts`, `src/config.ts`, `src/detect.ts`.
- When modifying `src/watch.ts`, also check: `src/cache.ts`, `src/config-scan.ts`, `src/config.ts`, `src/conventions.ts`.
- `src/snapshot.ts` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.
- `src/templates/main-context.ts` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.
- `src/import-resolution.ts` is a flow bottleneck (many import paths pass through it). Consider splitting if it grows further.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/index.ts` (Orchestrator) | 0 files | stable |
| `src/utils.ts` (Foundation) | 45 files | stable |
| `src/run-analysis.ts` (Orchestrator) | 1 file | 96% unstable ⚠️ |
| `src/watch.ts` (Orchestrator) | 2 files | 91% unstable ⚠️ |
| `src/diff.ts` (Orchestrator) | 2 files | 89% unstable ⚠️ |
| `src/refresh.ts` | 2 files | stable |
| `src/generate.ts` | 3 files | stable |
| `src/types.ts` (Utility) | 97 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, UPPER_SNAKE_CASE for constants
- **Prefer**: In `src/parsers/`, use kebab-case for files
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getOrSet`)
- **Prefer**: Use `is`/`has` prefixes for boolean-returning functions (e.g., `isTestFile`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first, alphabetical within groups

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 63 | 17 minutes ago |
| `README.md` | 41 | 2 days ago |
| `src/templates/main-context.ts` | 37 | 28 minutes ago |
| `src/summary.ts` | 33 | 28 minutes ago |
| `src/snapshot.ts` | 32 | 10 minutes ago |
| `package.json` | 30 | 8 hours ago |
| `src/types.ts` | 28 | 2 days ago |
| `CLAUDE.md` | 26 | 35 hours ago |
| `package-lock.json` | 24 | 8 hours ago |
| `src/detect.ts` | 20 | 17 minutes ago |

## Test Coverage Map

- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/diff.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/refresh.ts`, run its tests: `src/__tests__/refresh.test.ts` (unit)
- **Must**: When modifying `src/generate.ts`, run its tests: `src/__tests__/generate.test.ts` (unit), `src/__tests__/user-sections.test.ts` (unit)
- **Must**: When modifying `src/types.ts`, run its tests: `src/__tests__/ast-parity.test.ts` (integration), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/budget.test.ts` (integration), `src/__tests__/cache.test.ts` (unit), `src/__tests__/change-impact.test.ts` (unit), `src/__tests__/check.test.ts` (unit), `src/__tests__/claude-skills.test.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/config.test.ts` (unit), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/cursor-rules.test.ts` (unit), `src/__tests__/delta.test.ts` (unit), `src/__tests__/detect.test.ts` (unit), `src/__tests__/directives.test.ts` (unit), `src/__tests__/eval/betweenness-real-projects.test.ts` (integration), `src/__tests__/eval/fixtures.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/framework-hints.test.ts` (unit), `src/__tests__/generate.test.ts` (unit), `src/__tests__/golden/golden.test.ts` (integration), `src/__tests__/graph-algorithms.test.ts` (integration), `src/__tests__/integration/language-pipeline.test.ts` (integration), `src/__tests__/monorepo-analysis.test.ts` (unit), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/prompts.test.ts` (unit), `src/__tests__/serialize.test.ts` (unit), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-scan-paths.test.ts` (unit), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (integration), `src/__tests__/summary.test.ts` (unit), `src/__tests__/template-customization.test.ts` (integration), `src/__tests__/test-map.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/animations.ts`, `src/detect-frameworks.ts`, `src/ignore-patterns.ts`, `src/detect-languages.ts`, `src/parsers/snapshot-go.ts`, `src/parsers/ts-imports.ts`, `src/templates/sections/architecture.ts`, `src/templates/sections/dependencies.ts`, `src/templates/sections/git-activity.ts`, `src/templates/sections/project-info.ts`, `src/cli-check.ts`, `src/detect-monorepo.ts`, `src/parsers/go-imports.ts`, `src/parsers/java-imports.ts`, `src/parsers/python-imports.ts`
  (7 more untested files)
- **Prefer**: Follow existing test patterns in `src/__tests__/golden/golden.test.ts` (most comprehensive test file)
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
docs/
scripts/
src/
  __tests__/
```

## Cross-Cutting Files

These files are imported across multiple architectural layers. Changes here have wide blast radius.

| File | Imported By | Layers |
|------|------------|--------|
| `src/__tests__/golden/fixtures/ts-layered/types/index.ts` | 6 files | services, types, utils |

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

<!-- Sections omitted to fit token budget: code-snapshot, change-coupling, dead-files, chokepoints, tight-coupling, hidden-coupling. Run clarte --full for full output. -->

<!-- clarte: generated 2026-02-28T06:11:39Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
