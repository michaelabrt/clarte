# How It Works

Clarté runs a pipeline of static analysis steps. This document explains each one in detail.

For the summary table, see the [README](../README.md#how-it-works).

## Dependency Graph

Parses all `import`, `require` and `use` statements across your source files and builds a directed graph. This graph powers every other analysis step.

```
src/hooks/useAuth.ts  ──imports──▶  src/store/auth.ts
src/hooks/useAuth.ts  ──imports──▶  src/types.ts
src/pages/Login.tsx   ──imports──▶  src/hooks/useAuth.ts
```

**Barrel file resolution**: imports through barrel files (detected by content analysis: >50% re-export ratio) are followed through re-exports to credit the actual source files, preventing barrels from inflating centrality scores. Works with `index.ts`, `mod.ts` and any file that primarily re-exports.

**tsconfig path aliases**: specifiers like `@/utils` are resolved via `tsconfig.json` `paths`/`baseUrl` instead of being counted as external packages.

## HITS Analysis

Runs [Kleinberg's HITS algorithm](https://en.wikipedia.org/wiki/HITS_algorithm) on the import graph to separate two kinds of important files:

- **Authorities** (high authority score): files imported by many others, i.e. stable foundations like `types.ts`, `utils.ts`. Read these to understand the vocabulary.
- **Hubs** (high hub score): files that import many others, i.e. orchestration points like `index.ts`, controllers. Read these to understand the flow.

Each file is assigned a role based on its scores: **Foundation**, **Orchestrator**, **Bridge**, **Utility**, **Leaf**, or **Barrel** (re-export files). Edges are weighted by import specificity (number of named imports), with type-only imports at 0.3x weight and dynamic `import()` expressions at 0.5x weight.

## Config Constraints

Scans `tsconfig.json`, ESLint, Biome and Prettier configs to extract rules that directly affect code generation:

- TypeScript strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Linter rules (`prefer-const`, `consistent-type-imports`, `no-explicit-any`)
- Formatter settings (indent style, quotes, semicolons)

These are rendered as actionable directives: "**Must**: TypeScript strict mode, no implicit any", "**Prefer**: type-only imports". An LLM that doesn't know about `exactOptionalPropertyTypes` will write wrong code. These constraints prevent that.

## Dead File Detection

Identifies files with zero in-degree (nothing imports them), excluding known entry points like `index.ts`, `main.ts`, `app.ts`, `__init__.py` and test files. These are potential cleanup targets or files that may only be used via side effects.

## Dead Export Removal

Cross-references every named export against the import graph. If nothing in the project imports it, it's excluded from the snapshot. Library projects (detected via `main`/`exports`/`bin` fields in `package.json`) skip this filtering to preserve public API exports.

This catches leftover refactors, over-exported utilities and test-only helpers, keeping the context lean.

## Token Budgeting

Large projects may have more types and signatures than fit in the token budget. Clarté uses a greedy [knapsack](https://en.wikipedia.org/wiki/Knapsack_problem) approach that prioritizes:

1. Entries from high-centrality files (via HITS authority scores)
2. Recently active files (via git history, using a logarithmic scale)
3. Core categories (types, store shapes, component props)

Lower-priority items fill whatever budget remains.

When `--budget` is set, entire context sections are also prioritized for inclusion. Sections are included in priority order until the budget is exhausted:

- **Priority 0** (always): project purpose, key patterns, gotchas, development commands
- **Priority 1-2**: tech stack, config constraints, working guidelines, key files
- **Priority 3-5**: circular dependencies, architecture, framework hints, conventions
- **Priority 6-7**: code snapshot, call graph, hot files, change coupling
- **Priority 8-10**: test mapping, dead files, cross-cutting files, tight coupling

## Layer Detection

Classifies files into architecture layers based on directory and naming conventions:

```
types  ->  stores  ->  services  ->  hooks  ->  components  ->  pages
                                              ↑
                                            utils, config
```

The generated context includes a dependency-flow summary so agents understand how layers relate. Cross-layer violations (e.g., types importing from components) are flagged.

## Cycle Detection

Uses [Tarjan's algorithm](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm) to find groups of files that form import cycles, then reports the shortest actual cycle within each strongly connected component via BFS.

**Example:** `auth.ts -> user.ts -> permissions.ts -> auth.ts`. All three files are reported as a circular dependency cluster.

Each cycle gets a **severity score** (0-1) based on the ratio of runtime to type-only imports and a **break hint** suggesting how to resolve it (e.g., "Convert X -> Y to type-only import"). Cycles are sorted by severity so agents address the most impactful ones first.

## Instability Scoring

Computes an [instability metric](https://en.wikipedia.org/wiki/Software_package_metrics) for each file:

```
instability = outgoing imports / (outgoing + incoming imports)
```

Files with instability > 0.8 **and** at least one dependent (fanIn ≥ 1) are flagged. High instability means the file depends on many things relative to what depends on it — the Orchestrator pattern. These files are safe to change directly (few things depend on them) but fragile to breakage in their own dependencies, since a break anywhere in their large import surface cascades up to their few dependents.

## Cross-Cutting Analysis

Identifies files imported across 3 or more architectural layers. A file imported by 10 files all in `components/` is a local utility. A file imported across `components/`, `services/`, `hooks/` and `pages/` is a cross-cutting concern where changes ripple across architectural boundaries.

**Example output:**

| File | Imported By | Layers |
|------|------------|--------|
| `src/types.ts` | 20 files | types, services, hooks, components, pages |
| `src/utils.ts` | 13 files | services, hooks, components |

## Layer Consistency

Measures how well the codebase follows its own layering conventions. Performs a topological sort of detected layers, then checks whether each cross-layer import flows in the expected direction (foundational to consumer). Upward imports (e.g., types importing from services) are flagged as violations.

**Example output:**

```
Dependency direction consistency: 94% (imports flow downward)

Violations (imports flowing upward):
- `src/types/user.ts` imports from `src/services/auth.ts` (types -> services)
```

## Chokepoint Detection

Uses directed BFS reachability to find files that bridge many upstream dependents to downstream dependencies. For each candidate file, two BFS passes run on the directed import graph: reverse BFS to count transitive dependents (`upstreamCount`), forward BFS to count transitive dependencies (`downstreamCount`). A file qualifies as a chokepoint if `upstreamCount >= ceil(sqrt(N))` (adaptive threshold) and `downstreamCount >= 1`.

This replaced an earlier undirected Tarjan articulation-point approach, which overstated impact in layered architectures (a file that "separates 2 components" in the undirected view may have zero actual upstream dependents in the directed view).

**Example output:**

| File | Upstream (dependents) | Downstream (deps) |
|------|-----------------------|-------------------|
| `src/utils.ts` | 44 files | 3 files |
| `src/graph/build.ts` | 9 files | 6 files |

## Change Coupling

Analyzes 90 days of git history to find file pairs that frequently appear in the same commits.

**Example output:**

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/api/client.ts` | `src/api/types.ts` | 12 | 92% |
| `src/routes.ts` | `src/middleware.ts` | 8 | 80% |

This catches implicit dependencies that don't show up in imports. Agents know that touching one file likely means touching the other.

## Tight Coupling

Counts named imports between file pairs and flags those with 5+ shared names. This indicates strong coupling where changes to one file's exports are likely to break the other.

**Example output:**

| From | To | Imported Names |
|------|----|----------------|
| `src/index.ts` | `src/graph.ts` | 14 names |
| `src/watch.ts` | `src/graph.ts` | 13 names |

Agents are advised to consider introducing an intermediate interface if refactoring tightly coupled pairs.

## Hidden Coupling

Cross-references change coupling (git co-change data) with graph distance (BFS shortest path). File pairs that frequently change together but have no direct import path between them indicate implicit dependencies: shared schemas, duplicated logic, or missing intermediate modules.

**Example output:**

| File A | File B | Co-changes | Confidence | Graph Distance |
|--------|--------|------------|------------|----------------|
| `src/api/types.ts` | `src/hooks/useAuth.ts` | 8 | 75% | unreachable |

## Change Impact Prediction

For each hub file, predicts which files are most likely to need changes when that file is modified. Combines three signals via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

1. **Structural proximity**: BFS distance in the import graph
2. **Temporal coupling**: co-change confidence from git history
3. **Directory proximity**: shared path segments

Results are rendered as co-change directives in the working guidelines.

## Transitive Dependency Risk

Propagates code churn through the dependency graph using BFS with exponential decay. A stable file that depends on volatile files inherits transitive risk. Composite score: 30% direct volatility + 70% transitive volatility. The top risk files are flagged in directives.

## Architecture Delta

Persists analysis snapshots to `.clarte/history.json` and diffs them across runs. Tracks:

- New/demoted hub files
- New/resolved circular dependencies
- New/resurrected dead files
- New/resolved chokepoints
- Layer violation count changes

Deltas are rendered as an "Architecture Changes" section in the context file and logged during `--watch` mode.

## Architectural Fitness Functions

Checks three structural rules against the import graph and layer classification:

1. **No upward dependencies**: lower layers should not import from higher layers
2. **Test isolation**: test files should not import other test files (excluding fixtures)
3. **No layer skipping**: imports should not skip 2+ intermediate layers

Violations are rendered as directives with severity levels (error/warning).

## Git Activity

Counts commits per file over the last 90 days to surface:

- **Hot spots**: files with the most churn
- **Recently active files**: where current development is focused
- **Quiet zones**: stable code that rarely changes

## Stale Detection

Hashes all source file paths and modification times. Run `--check` to compare against the stored hash:

```bash
npx clarte --check
# exit 0 = snapshot is fresh
# exit 1 = snapshot is stale, run --refresh-snapshot
```
