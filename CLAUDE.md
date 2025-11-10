# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 42 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/graph.ts` (Foundation, imported by 27 files), check dependents for breaking changes.
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- When modifying `package-lock.json`, also check `package.json` (89% of the time).
- When modifying `src/graph.ts`, also check `src/snapshot.ts` (80% of the time).
- `src/types.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/graph.ts` is a structural chokepoint (separates 3 components). Refactor with extreme care.
- `src/utils.ts` is a structural chokepoint (separates 2 components). Refactor with extreme care.
- `src/index.ts` is a high-churn file (38 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (34 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/summary.ts` is a high-churn file (23 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/graph.ts` is a Foundation file with high complexity (46 exports, 2900+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` is a Orchestrator file with high complexity (3 exports, 1400+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/print.ts` is a Orchestrator file with high complexity (1 exports, 187 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/summary.ts` has multiple risk factors (high churn, no tests). Add tests and before making large changes.
- `src/graph.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/detect.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/snapshot.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/graph.ts`, also check: `src/snapshot.ts`, `src/cache.ts`, `src/utils.ts`, `src/types.ts`.
- When modifying `src/utils.ts`, also check: `src/cache.ts`, `src/check.ts`, `src/graph.ts`, `src/config-scan.ts`.
- When modifying `src/cache.ts`, also check: `src/graph.ts`, `src/utils.ts`, `src/types.ts`, `src/mcp-server.ts`.
- When modifying `src/watch.ts`, also check: `src/graph.ts`, `src/cache.ts`, `src/config-scan.ts`, `src/detect.ts`.
- When modifying `src/print.ts`, also check: `src/graph.ts`, `src/cache.ts`, `src/detect.ts`, `src/config-scan.ts`.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/graph.ts` (Foundation) | 27 files | stable |
| `src/index.ts` (Orchestrator) | 1 file | 96% unstable ⚠️ |
| `src/print.ts` (Orchestrator) | 2 files | 86% unstable ⚠️ |
| `src/watch.ts` (Orchestrator) | 2 files | 82% unstable ⚠️ |
| `src/mcp-server.ts` (Orchestrator) | 1 file | 90% unstable ⚠️ |
| `src/utils.ts` (Utility) | 33 files | stable |
| `src/cache.ts` | 5 files | stable |
| `src/__tests__/bench/pipeline.bench.ts` | 0 files | stable |

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, camelCase for constants, camelCase for files
- **Prefer**: In `src/templates/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 38 | 21 minutes ago |
| `README.md` | 34 | 31 minutes ago |
| `src/summary.ts` | 23 | 14 minutes ago |
| `src/templates/main-context.ts` | 22 | 31 minutes ago |
| `package.json` | 22 | 13 hours ago |
| `src/types.ts` | 21 | 2 days ago |
| `package-lock.json` | 19 | 33 hours ago |
| `src/snapshot.ts` | 19 | 2 days ago |
| `src/graph.ts` | 17 | 2 days ago |
| `CLAUDE.md` | 14 | 31 minutes ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/index.ts` | `src/summary.ts` | 14 | 39% |
| `src/index.ts` | `src/templates/main-context.ts` | 17 | 44% |
| `src/index.ts` | `src/types.ts` | 18 | 49% |
| `src/__tests__/hooks.test.ts` | `src/hooks.ts` | 4 | 100% |
| `src/generate.ts` | `src/index.ts` | 13 | 37% |
| `package-lock.json` | `package.json` | 17 | 74% |
| `src/graph.ts` | `src/snapshot.ts` | 12 | 60% |
| `src/templates/main-context.ts` | `src/types.ts` | 14 | 48% |
| `src/__tests__/git-analysis.test.ts` | `src/git-analysis.ts` | 3 | 33% |
| `src/index.ts` | `src/snapshot.ts` | 12 | 31% |

## Test Coverage Map

- **Must**: When modifying `src/graph.ts`, run its tests: `src/__tests__/bench/algorithms.bench.ts` (unit), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/bench/pipeline.bench.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/eval/eval.test.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/graph-algorithms.test.ts` (unit), `src/__tests__/graph-aliases.test.ts` (unit), `src/__tests__/graph.test.ts` (unit), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-oxc.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (unit)
- **Must**: When modifying `src/index.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/print.ts`, run its tests: `src/__tests__/print.test.ts` (unit)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/mcp-server.ts`, run its tests: `src/__tests__/mcp-server.test.ts` (unit)
- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-oxc.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Must**: When modifying `src/cache.ts`, run its tests: `src/__tests__/cache.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/animations.ts`, `src/prompts.ts`, `src/refresh.ts`, `src/summary.ts`, `src/templates/cursor-rules.ts`, `src/templates/framework-hints.ts`, `src/theme.ts`
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
src/
  __tests__/
docs/
```

## Architectural Chokepoints

Files whose removal would disconnect parts of the codebase. Refactor with extreme care.

| File | Separates | Imported By |
|------|-----------|-------------|
| `src/types.ts` | 4 components | 60 files |
| `src/graph.ts` | 3 components | 27 files |
| `src/utils.ts` | 2 components | 33 files |
| `src/git-analysis.ts` | 2 components | 5 files |
| `src/cache.ts` | 2 components | 5 files |
| `src/watch.ts` | 2 components | 2 files |
| `src/print.ts` | 2 components | 2 files |
| `src/generate.ts` | 2 components | 2 files |
| `src/hooks.ts` | 2 components | 2 files |
| `src/deep-analysis.ts` | 2 components | 2 files |

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/graph.ts` imports 20 names from `src/types.ts`
- `src/index.ts` imports 14 names from `src/graph.ts`
- `src/mcp-server.ts` imports 13 names from `src/graph.ts`
- `src/print.ts` imports 13 names from `src/graph.ts`
- `src/watch.ts` imports 13 names from `src/graph.ts`
- `src/__tests__/bench/pipeline.bench.ts` imports 12 names from `src/graph.ts`
- `src/mcp-server.ts` imports 9 names from `src/types.ts`
- `src/__tests__/graph-algorithms.test.ts` imports 9 names from `src/graph.ts`
- `src/__tests__/mcp-server.test.ts` imports 9 names from `src/mcp-server.ts`
- `src/detect.ts` imports 9 names from `src/types.ts`

## Hidden Coupling

File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).

| File A | File B | Co-changes | Confidence | Graph Distance |
|--------|--------|------------|------------|----------------|
| `package-lock.json` | `package.json` | 17 | 74% | unreachable |

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

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
