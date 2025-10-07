<h1 align="center">Clarté</h1>
<p align="center"><em>/klaʁ.te/</em></p>

<p align="center">
  <a href="https://github.com/michaelabrt/clarte/actions/workflows/release.yml"><img src="https://github.com/michaelabrt/clarte/actions/workflows/release.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml"><img src="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/clarte"><img src="https://img.shields.io/npm/v/clarte" alt="npm version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-blue" alt="TypeScript"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

<p align="center"><strong>First light on your codebase.</strong></p>

AI coding agents spend their first few minutes reading files, tracing imports, and piecing together your architecture. **Clarté** does that work once, ahead of time, and hands the agent a single context file so it can start writing useful code immediately.

```bash
npx clarte
```

## Benchmarks

Independent benchmarks on [clarte-benchmark](https://github.com/michaelabrt/clarte-benchmark) measure the impact of Clarte-generated context on AI coding agent performance. Identical tasks run with and without context, compared via statistical testing (Mann-Whitney U, bootstrap confidence intervals, Cliff's delta effect sizes).

**Results (Claude Sonnet 4.5, small TypeScript utility library):**

| Metric | Without Context | With Context | Delta |
|--------|----------------|--------------|-------|
| Cost (median) | $0.1321 | $0.0706 | **-46.5%** |
| Duration (median) | 36.0s | 27.9s | **-22.6%** |
| Input tokens (median) | 35,298 | 16,138 | **-54.3%** |
| Turns (median) | 8.5 | 6 | **-29.4%** |
| Pass rate | 100% | 100% | 0.0pp |

See the [benchmark repo](https://github.com/michaelabrt/clarte-benchmark) for methodology, fixture projects, and full statistical analysis.

## Before & After

Without Clarté, a typical AI agent session starts like this:

```
Agent: Let me explore the project structure...
Agent: Reading src/index.ts...
Agent: Reading src/types.ts...
Agent: Reading src/utils/api-client.ts...
Agent: Reading src/store/auth.ts...
Agent: Now I understand the architecture. Let me start working...
```

With Clarté, the agent already knows:

| What | Example |
|------|---------|
| Tech stack | Next.js 14 (App Router), TypeScript, Zustand, Tailwind |
| Key files | `src/types.ts` (Foundation), `src/api/client.ts` (Orchestrator) |
| Architecture | services -> hooks -> components -> pages |
| Working guidelines | "When modifying `src/graph.ts`, check `src/types.ts` for breaking changes" |
| Active areas | `src/auth/` changed 12 times in the last 90 days |
| Cross-cutting | `src/types.ts` spans 5 layers; changes have wide blast radius |
| Chokepoints | `src/utils.ts` separates 3 components; no alternative paths |
| Coupled files | `routes.ts` and `middleware.ts` always change together |
| Hidden coupling | `schemas/user.ts` and `store/user.ts` co-change but have no import path |
| Tight coupling | `index.ts` imports 14 names from `graph.ts`; consider an interface |
| Dead files | Files with zero imports that may be safe to remove |
| Code snapshot | All public types, interfaces, props, and function signatures |

<details>
<summary><strong>Example: generated CLAUDE.md</strong> (click to expand)</summary>

```markdown
# MyProject

> **Keep this file up to date.** When you change the architecture, add a dependency,
> create a new pattern, or learn a gotcha, update this file in the same step.

## What Is This

A mobile AI chat app connecting to OpenAI, Anthropic, and Google APIs

## Tech Stack

- **Next.js** 14.1.0 (used in 34 files)
- **TypeScript**
- **Prisma** (used in 8 files)
- **Tailwind CSS** (used in 22 files)
- **npm** (package manager)

## Code Snapshot

<!-- CODE SNAPSHOT (auto-generated) -->

### Core Types

‍```ts
export interface User {  // imported by 12 files
  id: string;
  email: string;
  role: "admin" | "user";
}

export type APIResponse<T> = {  // imported by 8 files
  data: T;
  error?: string;
}
‍```

### Key Functions

‍```ts
export async function fetchChat(chatId: string): Promise<Chat>  // imported by 6 files

export function useAuth(): AuthContext  // imported by 9 files
‍```

<!-- /CODE SNAPSHOT -->

## Key Files

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/types.ts` (Foundation) | 18 files | stable |
| `src/lib/api-client.ts` (Bridge) | 12 files | stable |
| `src/store/auth.ts` (Utility) | 9 files | stable |

## Architecture

types -> stores -> hooks -> components -> pages

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/app/chat/page.tsx` | 14 | 2 days ago |
| `src/lib/api-client.ts` | 11 | 3 days ago |

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/lib/api-client.ts` (Foundation, imported by 12 files),
  check dependents for breaking changes.
- `src/types.ts` is a structural chokepoint (separates 3 components).
  Refactor with extreme care.
- When modifying `src/lib/api-client.ts`, also check: `src/hooks/useAuth.ts`,
  `src/store/auth.ts`.

<!-- ... more sections: change coupling, dead files, gotchas -->
```

</details>

## Quick Start

Run in your project root:

```bash
npx clarte
```

Clarté will:

1. **Detect** your tech stack (language, framework, package manager, linter)
2. **Ask** a few questions (which AI tool(s), project purpose, key patterns)
3. **Scan** source files for a code snapshot (types, store shapes, component props)
4. **Generate** optimized context files for your chosen tools
5. **Show** a summary with token savings estimate

Your answers are saved to `.clarte.json` so future runs skip the prompts.

## Supported Languages

| Language | Import parsing | Snapshot extraction |
|----------|---------------|---------------------|
| TypeScript / JavaScript | `import`, `require` | types, interfaces, functions, components, hooks, stores (AST-based via oxc-parser) |
| Python | `import`, `from ... import` | classes (with public method signatures and docstrings), functions, type aliases |
| Go | `import` | structs, interfaces, functions, methods (grouped by receiver type) |
| Rust | `use` | structs, enums, traits, functions (with generic bounds and where clauses) |
| Java | `import` | classes, interfaces, enums, records, methods (with annotations) |

## Supported Tools

Clarté can generate context files for multiple tools at once.

| Tool | Generated file | Docs |
|------|---------------|------|
| Claude Code | `CLAUDE.md` | [claude.ai/docs](https://docs.anthropic.com/en/docs/claude-code/memory#claudemd-files) |
| Cursor | `CLAUDE.md` + `.cursor/rules/*.md` | [cursor.com/docs](https://docs.cursor.com/context/rules-for-ai) |
| OpenCode | `AGENTS.md` | [opencode.ai](https://opencode.ai/) |
| GitHub Copilot | `.github/copilot-instructions.md` | [docs.github.com](https://docs.github.com/en/copilot/customizing-copilot/adding-repository-custom-instructions-for-github-copilot) |
| Windsurf | `.windsurfrules` | [windsurf.com](https://docs.windsurf.com/windsurf/memories#rules) |
| Cline | `.clinerules` | [cline.bot](https://docs.cline.bot/improving-your-workflow/cline-rules) |
| Continue.dev | `.continuerules` | [continue.dev/docs](https://docs.continue.dev/customize/deep-dives/rules) |
| Aider | `.aider.conf.yml` | [aider.chat](https://aider.chat/docs/config/adir_conf.html) |
| Generic | `CONTEXT.md` | - |

## How It Works

Clarté runs a pipeline of static analysis steps:

| Step | How | Result |
|------|-----|--------|
| [Dependency graph](#dependency-graph) | Parses all `import`/`require`/`use` statements | Maps how files connect to each other |
| [Deep analysis](#deep-analysis) | Loads TypeScript type checker (opt-in) | Inferred return types and function call graphs |
| [HITS analysis](#hits-analysis) | Computes authority/hub scores, assigns roles | Surfaces foundations, orchestrators, and bridges |
| [Config constraints](#config-constraints) | Extracts rules from tsconfig, ESLint, Biome, Prettier | Prevents wrong code from strict mode, linter rules |
| [Dead file detection](#dead-file-detection) | Finds files nothing imports | Highlights potential cleanup targets |
| [Dead export removal](#dead-export-removal) | Drops exports nothing imports | Saves tokens on unused code |
| [Token budgeting](#token-budgeting) | Fits the snapshot into a token limit | Keeps context files within model limits |
| [Layer detection](#layer-detection) | Classifies files into architecture layers | Gives agents a mental model of your project |
| [Cycle detection](#cycle-detection) | Finds circular import chains | Warns agents about risky dependency loops |
| [Instability scoring](#instability-scoring) | Flags volatile, widely-depended-on files | Tells agents where to be extra careful |
| [Cross-cutting analysis](#cross-cutting-analysis) | Finds files imported across 3+ layers | Warns agents about wide blast radius |
| [Layer consistency](#layer-consistency) | Checks import direction against layer order | Prevents new dependency violations |
| [Chokepoint detection](#chokepoint-detection) | Finds articulation points in the graph | Highlights irreplaceable connectors |
| [Tight coupling](#tight-coupling) | Counts named imports between file pairs | Highlights files that may need an interface |
| [Change coupling](#change-coupling) | Finds files that always change together | Prevents incomplete changes |
| [Hidden coupling](#hidden-coupling) | Finds co-changing files with no import path | Surfaces implicit dependencies |
| [Change impact](#change-impact-prediction) | Predicts which files need changes when a hub file is modified | Focuses review scope during refactoring |
| [Transitive risk](#transitive-dependency-risk) | Propagates volatility through the dependency graph | Flags stable files with risky dependencies |
| [Architecture delta](#architecture-delta) | Diffs analysis snapshots across runs | Tracks architectural drift over time |
| [Fitness functions](#architectural-fitness-functions) | Checks structural rules (no upward deps, test isolation, layer skips) | Prevents new architectural violations |
| [Git activity](#git-activity) | Surfaces recently active files | Shows where current work is focused |
| [Stale detection](#stale-detection) | Hashes file paths + mtimes | Tells you when to re-run |

### Dependency Graph

Parses all `import`, `require`, and `use` statements across your source files and builds a directed graph. This graph powers every other analysis step.

```
src/hooks/useAuth.ts  ──imports──▶  src/store/auth.ts
src/hooks/useAuth.ts  ──imports──▶  src/types.ts
src/pages/Login.tsx   ──imports──▶  src/hooks/useAuth.ts
```

**Barrel file resolution**: imports through barrel files (detected by content analysis: >50% re-export ratio) are followed through re-exports to credit the actual source files, preventing barrels from inflating centrality scores. Works with `index.ts`, `mod.ts`, and any file that primarily re-exports.

**tsconfig path aliases**: specifiers like `@/utils` are resolved via `tsconfig.json` `paths`/`baseUrl` instead of being counted as external packages.

### HITS Analysis

Runs [Kleinberg's HITS algorithm](https://en.wikipedia.org/wiki/HITS_algorithm) on the import graph to separate two kinds of important files:

- **Authorities** (high authority score): files imported by many others, i.e. stable foundations like `types.ts`, `utils.ts`. Read these to understand the vocabulary.
- **Hubs** (high hub score): files that import many others, i.e. orchestration points like `index.ts`, controllers. Read these to understand the flow.

Each file is assigned a role based on its scores: **Foundation**, **Orchestrator**, **Bridge**, **Utility**, **Leaf**, or **Barrel** (re-export files). Edges are weighted by import specificity (number of named imports), with type-only imports at 0.3x weight and dynamic `import()` expressions at 0.5x weight.

### Config Constraints

Scans `tsconfig.json`, ESLint, Biome, and Prettier configs to extract rules that directly affect code generation:

- TypeScript strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Linter rules (`prefer-const`, `consistent-type-imports`, `no-explicit-any`)
- Formatter settings (indent style, quotes, semicolons)

These are rendered as actionable directives: "**Must**: TypeScript strict mode, no implicit any", "**Prefer**: type-only imports". An LLM that doesn't know about `exactOptionalPropertyTypes` will write wrong code. These constraints prevent that.

### Dead File Detection

Identifies files with zero in-degree (nothing imports them), excluding known entry points like `index.ts`, `main.ts`, `app.ts`, `__init__.py`, and test files. These are potential cleanup targets or files that may only be used via side effects.

### Dead Export Removal

Cross-references every named export against the import graph. If nothing in the project imports it, it's excluded from the snapshot. Library projects (detected via `main`/`exports`/`bin` fields in `package.json`) skip this filtering to preserve public API exports.

This catches leftover refactors, over-exported utilities, and test-only helpers, keeping the context lean.

### Token Budgeting

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

### Layer Detection

Classifies files into architecture layers based on directory and naming conventions:

```
types  ->  stores  ->  services  ->  hooks  ->  components  ->  pages
                                              ↑
                                            utils, config
```

The generated context includes a dependency-flow summary so agents understand how layers relate. Cross-layer violations (e.g., types importing from components) are flagged.

### Cycle Detection

Uses [Tarjan's algorithm](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm) to find groups of files that form import cycles, then reports the shortest actual cycle within each strongly connected component via BFS.

**Example:** `auth.ts -> user.ts -> permissions.ts -> auth.ts`. All three files are reported as a circular dependency cluster.

Each cycle gets a **severity score** (0-1) based on the ratio of runtime to type-only imports, and a **break hint** suggesting how to resolve it (e.g., "Convert X -> Y to type-only import"). Cycles are sorted by severity so agents address the most impactful ones first.

### Instability Scoring

Computes an [instability metric](https://en.wikipedia.org/wiki/Software_package_metrics) for each file:

```
instability = outgoing imports / (outgoing + incoming imports)
```

Files that are both highly unstable (many outgoing deps) **and** widely depended on (many incoming deps) are flagged as risk zones. Generated context includes interpretive explanations so agents understand what the scores mean.

### Cross-Cutting Analysis

Identifies files imported across 3 or more architectural layers. A file imported by 10 files all in `components/` is a local utility. A file imported across `components/`, `services/`, `hooks/`, and `pages/` is a cross-cutting concern where changes ripple across architectural boundaries.

**Example output:**

| File | Imported By | Layers |
|------|------------|--------|
| `src/types.ts` | 20 files | types, services, hooks, components, pages |
| `src/utils.ts` | 13 files | services, hooks, components |

### Layer Consistency

Measures how well the codebase follows its own layering conventions. Performs a topological sort of detected layers, then checks whether each cross-layer import flows in the expected direction (foundational to consumer). Upward imports (e.g., types importing from services) are flagged as violations.

**Example output:**

```
Dependency direction consistency: 94% (imports flow downward)

Violations (imports flowing upward):
- `src/types/user.ts` imports from `src/services/auth.ts` (types -> services)
```

### Chokepoint Detection

Uses [Tarjan's algorithm](https://en.wikipedia.org/wiki/Biconnected_component) to find articulation points: files whose removal would disconnect parts of the import graph. These are fundamentally different from hub files: a hub may have redundant paths around it, but a chokepoint has no alternative paths.

**Example output:**

| File | Separates | Imported By |
|------|-----------|-------------|
| `src/utils.ts` | 3 components | 13 files |
| `src/graph.ts` | 2 components | 6 files |

### Change Coupling

Analyzes 90 days of git history to find file pairs that frequently appear in the same commits.

**Example output:**

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/api/client.ts` | `src/api/types.ts` | 12 | 92% |
| `src/routes.ts` | `src/middleware.ts` | 8 | 80% |

This catches implicit dependencies that don't show up in imports. Agents know that touching one file likely means touching the other.

### Tight Coupling

Counts named imports between file pairs and flags those with 5+ shared names. This indicates strong coupling where changes to one file's exports are likely to break the other.

**Example output:**

| From | To | Imported Names |
|------|----|----------------|
| `src/index.ts` | `src/graph.ts` | 14 names |
| `src/brief.ts` | `src/graph.ts` | 13 names |

Agents are advised to consider introducing an intermediate interface if refactoring tightly coupled pairs.

### Hidden Coupling

Cross-references change coupling (git co-change data) with graph distance (BFS shortest path). File pairs that frequently change together but have no direct import path between them indicate implicit dependencies: shared schemas, duplicated logic, or missing intermediate modules.

**Example output:**

| File A | File B | Co-changes | Confidence | Graph Distance |
|--------|--------|------------|------------|----------------|
| `src/api/types.ts` | `src/hooks/useAuth.ts` | 8 | 75% | unreachable |

### Change Impact Prediction

For each hub file, predicts which files are most likely to need changes when that file is modified. Combines three signals via [Reciprocal Rank Fusion](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf):

1. **Structural proximity**: BFS distance in the import graph
2. **Temporal coupling**: co-change confidence from git history
3. **Directory proximity**: shared path segments

Results are rendered as co-change directives in the working guidelines.

### Transitive Dependency Risk

Propagates code churn through the dependency graph using BFS with exponential decay. A stable file that depends on volatile files inherits transitive risk. Composite score: 30% direct volatility + 70% transitive volatility. The top risk files are flagged in directives.

### Architecture Delta

Persists analysis snapshots to `.clarte/history.json` and diffs them across runs. Tracks:

- New/demoted hub files
- New/resolved circular dependencies
- New/resurrected dead files
- New/resolved chokepoints
- Layer violation count changes

Deltas are rendered as an "Architecture Changes" section in the context file and logged during `--watch` mode.

### Architectural Fitness Functions

Checks three structural rules against the import graph and layer classification:

1. **No upward dependencies**: lower layers should not import from higher layers
2. **Test isolation**: test files should not import other test files (excluding fixtures)
3. **No layer skipping**: imports should not skip 2+ intermediate layers

Violations are rendered as directives with severity levels (error/warning).

### Git Activity

Counts commits per file over the last 90 days to surface:

- **Hot spots**: files with the most churn
- **Recently active files**: where current development is focused
- **Quiet zones**: stable code that rarely changes

### Stale Detection

Hashes all source file paths and modification times. Run `--check` to compare against the stored hash:

```bash
npx clarte --check
# exit 0 = snapshot is fresh
# exit 1 = snapshot is stale, run --refresh-snapshot
```

## User Section Preservation

Clarté preserves your manual additions across regenerations. Wrap custom content with markers:

```markdown
<!-- clarte:user-start -->
## My Custom Notes

These notes will survive the next `npx clarte` run.
<!-- clarte:user-end -->
```

Marked sections are anchored to the nearest preceding `## Header` and reinserted at the same position when the file is regenerated.

## Options

```bash
npx clarte [directory] [options]
```

| Flag | Description |
|------|-------------|
| `directory` | Path to analyze (defaults to `.`) |
| `-h, --help` | Show help message |
| `-V, --version` | Show version number |
| `--force` | Overwrite existing files without asking |
| `--dry-run` | Preview what would be generated |
| `--diff[=base]` | Generate focused context for changed files only (default base: `main`) |
| `--diff-file=PATH` | Write diff output to a file instead of stdout |
| `--refresh-snapshot` | Re-scan source files and update just the code snapshot |
| `--reconfigure` | Re-prompt even if `.clarte.json` exists |
| `--check` | Check if the snapshot is stale via hash comparison (exit 0 = fresh, 1 = stale) |
| `--check=timestamp` | Timestamp-only staleness check, no file hashing (for shell hooks) |
| `--max-tokens=N` | Set the token budget for the code snapshot |
| `--budget=N` | Set token budget for the context file (prioritized sections) |
| `--format=json` | Output full analysis as structured JSON to stdout |
| `--generate-skills` | Generate Claude Code skill files |
| `--deep` | Run TypeScript type checker for inferred return types and call graphs |
| `--init-hook` | Install git pre-commit hook for automatic snapshot freshness validation |
| `--watch` | Watch for file changes and re-analyze continuously |
| `-v, --verbose` | Show detailed progress output |

### Diff Mode

Generate focused context for just the files you changed:

```bash
npx clarte --diff         # diff against main
npx clarte --diff=develop # diff against a specific branch
```

Outputs to stdout by default (use `--diff-file=PATH` for file output). For each changed file, the diff includes:

- **Risk annotations**: file role, dependent count, and impact warnings
- **Temporal coupling**: files that frequently co-change but aren't in the current diff
- **Cycle context**: circular dependencies involving changed files, with break hints
- **Scoped directives**: architectural guidelines filtered to the changed files only

### Brief Mode

Output a compact, token-budgeted architectural summary to stdout, designed for AI tool session hooks:

```bash
npx clarte brief                    # Default 3000-token budget
npx clarte brief --max-tokens=1500  # Constrained budget
```

Silent no-op when no `.clarte.json` exists, making it safe to install globally. Automatically detects if a Clarte MCP server is running and emits minimal output in that case.

### Hook Installation

One-command setup for Claude Code session hooks:

```bash
npx clarte hooks install    # Add SessionStart + PreCompact hooks
npx clarte hooks uninstall  # Remove clarte hooks
```

This configures `~/.claude/settings.json` so that `clarte brief` runs automatically at session start and before context compaction, keeping the agent informed about your architecture.

### Watch Mode

Run continuous analysis in a terminal tab while you develop:

```bash
npx clarte --watch          # Watch and re-analyze on file changes
npx clarte --watch -v       # Verbose output
```

On each source file change (debounced 500ms), Clarte rebuilds the import graph incrementally and runs the full analysis pipeline. Architecture deltas (new hub files, resolved cycles, new dead files, etc.) are logged as they are detected. Agent sessions started via `clarte brief` hooks will always see current data.

### Deep Analysis

Run the TypeScript type checker for richer context:

```bash
npx clarte --deep
```

When your project has TypeScript as a dev dependency, `--deep` loads it from `node_modules` and adds:

- **Inferred return types**: Functions without explicit return type annotations get their inferred types added to the snapshot
- **Function call graph**: Shows which exported functions call which others, surfacing internal dependencies not visible in the import graph

Gracefully falls back to parser-only output if TypeScript is not installed or the project is not TypeScript-based.

### Context Splitting

For large projects (150+ source files or 8000+ estimated context tokens), Clarte automatically splits context into tiered files:

- **Root context file**: Project overview, tech stack, key files, architecture layers, development commands. Links to per-directory files.
- **Per-directory context files**: Placed in `.clarte/context/`. Each contains local hub files, dependency patterns, test coverage, and related directories.

This keeps each context file focused and within useful token budgets. Monorepo projects are excluded (they already get per-package context).

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx clarte --refresh-snapshot
```

This finds the `<!-- CODE SNAPSHOT -->` markers in your context file, re-scans source files, and replaces just that section.

## Shell Integration

Automatically detect stale snapshots when you `cd` into a project. These hooks run in pure shell (no Node.js boot), so they add zero latency to your prompt:

<details>
<summary><strong>zsh</strong></summary>

```zsh
# Add to ~/.zshrc
chpwd() {
  if [[ -f .clarte.json ]]; then
    local ts days stale_days
    ts=$(command grep -o '"snapshotGeneratedAt":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*$')
    [[ -z "$ts" ]] && return
    stale_days=$(command grep -o '"staleDays":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*$')
    : "${stale_days:=7}"
    days=$(( ($(date +%s) - ts / 1000) / 86400 ))
    (( days > stale_days )) && echo "clarte: snapshot is ${days}d old. Run: npx clarte --refresh-snapshot"
  fi
}
```

</details>

<details>
<summary><strong>bash</strong></summary>

```bash
# Add to ~/.bashrc
cd() {
  builtin cd "$@" || return
  if [[ -f .clarte.json ]]; then
    local ts days stale_days
    ts=$(command grep -o '"snapshotGeneratedAt":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*$')
    [[ -z "$ts" ]] && return
    stale_days=$(command grep -o '"staleDays":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*$')
    : "${stale_days:=7}"
    days=$(( ($(date +%s) - ts / 1000) / 86400 ))
    (( days > stale_days )) && echo "clarte: snapshot is ${days}d old. Run: npx clarte --refresh-snapshot"
  fi
}
```

</details>

<details>
<summary><strong>fish</strong></summary>

```fish
# Add to ~/.config/fish/conf.d/clarte.fish
function __clarte_check --on-variable PWD
  if test -f .clarte.json
    set -l ts (command grep -o '"snapshotGeneratedAt":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*\$')
    test -z "$ts"; and return
    set -l stale_days (command grep -o '"staleDays":[0-9]*' .clarte.json 2>/dev/null | command grep -o '[0-9]*\$')
    test -z "$stale_days"; and set stale_days 7
    set -l days (math "( "(date +%s)" - $ts / 1000) / 86400")
    test $days -gt $stale_days; and echo "clarte: snapshot is "$days"d old. Run: npx clarte --refresh-snapshot"
  end
end
```

</details>

> **Tip:** Set `"staleDays": 14` in `.clarte.json` to customize the threshold. For CI/pre-commit use the hash-based `--check` instead.

## MCP Server

Clarte includes an MCP (Model Context Protocol) server that exposes architectural analysis as live, queryable tools. Instead of reading a static context file, agents can query specific architectural data mid-session.

### Setup

Add the following to your Claude Code settings (`~/.claude/settings.json`):

```json
{
  "mcpServers": {
    "clarte": {
      "command": "npx",
      "args": ["clarte-mcp"]
    }
  }
}
```

The server runs the full analysis pipeline on startup, then serves queries via stdio transport.

### Available Tools

| Tool | Parameters | Description |
|------|-----------|-------------|
| `get_hub_files` | `limit?, min_centrality?` | Top files by HITS authority with role, centrality, import counts |
| `get_file_info` | `path` | Full analysis for a single file: role, imports, importers, layer, tests, coupling partners |
| `what_imports` | `path` | Files that import the given file (reverse dependency lookup) |
| `what_does_import` | `path` | Files the given path imports (forward dependency lookup) |
| `find_circular_deps` | `involving?` | Circular dependencies, optionally filtered to a specific file |
| `get_layers` | (none) | Architectural layers with dependency flow and consistency score |
| `get_layer_for` | `path` | Which architectural layer a file belongs to |
| `get_related_tests` | `path` | Test files associated with a given source file |
| `get_change_partners` | `path` | Files that frequently co-change with the given file |
| `get_architecture_summary` | `max_tokens?` | Token-budgeted text summary of the project architecture |

When the MCP server is active, `clarte brief` automatically detects it and emits minimal output to avoid redundancy.

## Config File

On first run, Clarté saves your answers to `.clarte.json`:

```json
{
  "_version": 1,
  "ides": ["cursor", "copilot"],
  "projectPurpose": "A mobile AI chat app...",
  "keyPatterns": "Zustand slices for state...",
  "gotchas": "Never use FadeIn/FadeOut...",
  "generateSnapshot": true,
  "snapshotPaths": [],
  "stackCorrections": "",
  "generatePerPackage": false
}
```

Subsequent runs load this config and skip all prompts. Use `--reconfigure` to re-prompt.

Additional options:

| Field | Description |
|-------|-------------|
| `analysisDays` | Git history window in days (default: 90) |
| `staleDays` | Days before snapshot is considered stale in `--check=timestamp` (default: 7) |
| `sectionOrder` | Custom ordering of context sections; prefix with `-` to exclude a section |
| `layers` | Custom architectural layer patterns (see below) |

### Custom Layer Patterns

Projects using non-standard architectures (hexagonal, clean architecture, DDD) can define custom layer patterns:

```json
{
  "layers": [
    { "name": "domain", "pattern": "domain/" },
    { "name": "infrastructure", "pattern": "infra(structure)?/" },
    { "name": "adapters", "pattern": "adapters?/" },
    { "name": "ports", "pattern": "ports?/" }
  ]
}
```

Custom patterns are matched as regex and take priority over the built-in patterns (`types`, `stores`, `hooks`, `services`, `components`, `pages`, `utils`, `config`).

Add `.clarte.json` to your `.gitignore`. It's local tool config, not project docs.

## Framework Conventions

Clarté detects your framework and includes relevant best practices:

| Framework | What's included |
|-----------|----------------|
| Next.js | App Router vs Pages Router, server components, route handlers |
| Express | Middleware chain, error handling, router organization |
| FastAPI | Dependency injection, Pydantic models, async endpoints |
| Django | Apps structure, models-views-templates, migrations |
| Flask | Application factory, blueprints, extensions |
| NestJS | Modules, controllers, providers, guards |
| SvelteKit | Load functions, form actions, server routes |
| Expo / React Native | Routing, native modules, platform-specific files |
| Vue / Nuxt | Composition API, auto-imports, data fetching |

Also supports: Fastify, Hono, Angular, Svelte, Prisma, Drizzle, Tailwind CSS, Electron, SQLAlchemy, Celery, and more.

## Monorepo Support

Clarté detects monorepo tooling and can generate per-package context files:

- **pnpm workspaces** (`pnpm-workspace.yaml`)
- **Turborepo** (`turbo.json`)
- **Nx** (`nx.json`)

When detected, you'll be asked if you want per-package files. Each package gets its own scoped context with that package's dependencies, frameworks, and code snapshot.

Cross-package import analysis detects encapsulation violations (imports that bypass a package's public API) and computes per-package centrality to identify key files within each package.

## Working Guidelines

The generated context file includes a **Working Guidelines** section with actionable, analysis-derived directives. These are not informational metrics; each one tells the agent what to do differently:

- **Foundation file guards**: "When modifying `src/graph.ts` (imported by 23 files), check dependents for breaking changes"
- **Chokepoint warnings**: "`src/types.ts` is a structural chokepoint (separates 3 components). Refactor with extreme care."
- **Co-change reminders**: "When modifying `src/graph.ts`, also check: `src/brief.ts`, `src/cache.ts`"
- **Circular dependency hints**: "Convert X -> Y to type-only import" (with severity ranking)
- **Complexity warnings**: Files with high export counts or line counts get "read thoroughly before modifying" directives
- **Test reminders**: Hub files missing test coverage are flagged with their test coverage map

Guidelines are refreshed on every run. The `--budget` flag controls how many fit within the token limit; they are prioritized at level 2 (high).

## Multi-Language Projects

Clarte automatically detects projects using multiple languages and analyzes each independently. When a secondary language accounts for more than 15% of source files, it runs import parsing and snapshot extraction for that language too. Import graphs are merged, and the snapshot includes entries from all detected languages.

For example, a TypeScript frontend + Python backend project will analyze both languages in a single run, producing a unified context file.

## Living Documents

Generated files include maintenance directives telling your AI agent to keep them up to date. The code snapshot section uses HTML comment markers (`<!-- CODE SNAPSHOT -->`) so it's clear what to refresh after refactors. Custom sections wrapped in `<!-- clarte:user-start -->` / `<!-- clarte:user-end -->` markers are preserved across regenerations.

## Development

```bash
npm install
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run typecheck  # Type-check without emitting
npm test           # Run tests with vitest
```

For benchmarks measuring the impact of generated context on AI agent performance, see [clarte-benchmark](https://github.com/michaelabrt/clarte-benchmark).

## License

[MIT](LICENSE)
