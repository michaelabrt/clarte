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
| Architecture | services → hooks → components → pages |
| Active areas | `src/auth/` changed 12 times in the last 90 days |
| Cross-cutting | `src/types.ts` spans 5 layers; changes have wide blast radius |
| Chokepoints | `src/utils.ts` separates 3 components; no alternative paths |
| Coupled files | `routes.ts` and `middleware.ts` always change together |
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

types → stores → hooks → components → pages

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/app/chat/page.tsx` | 14 | 2 days ago |
| `src/lib/api-client.ts` | 11 | 3 days ago |

<!-- ... more sections: change coupling, module clusters, dead files, gotchas -->
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
| TypeScript / JavaScript | `import`, `require` | types, interfaces, functions, components, hooks, stores |
| Python | `import`, `from ... import` | classes (BaseModel, TypedDict, dataclass, Enum), functions, type aliases |
| Go | `import` | - |
| Rust | `use` | - |
| Java | `import` | - |

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
| [Change coupling](#change-coupling) | Finds files that always change together | Prevents incomplete changes |
| [Module clustering](#module-clustering) | Groups related files into logical modules | Reveals structure beyond folder layout |
| [Git activity](#git-activity) | Surfaces recently active files | Shows where current work is focused |
| [Stale detection](#stale-detection) | Hashes file paths + mtimes | Tells you when to re-run |

### Dependency Graph

Parses all `import`, `require`, and `use` statements across your source files and builds a directed graph. This graph powers every other analysis step.

```
src/hooks/useAuth.ts  ──imports──▶  src/store/auth.ts
src/hooks/useAuth.ts  ──imports──▶  src/types.ts
src/pages/Login.tsx   ──imports──▶  src/hooks/useAuth.ts
```

**Barrel file resolution**: imports from `index.ts` barrel files are followed through re-exports to credit the actual source files, preventing barrel files from inflating centrality scores.

**tsconfig path aliases**: specifiers like `@/utils` are resolved via `tsconfig.json` `paths`/`baseUrl` instead of being counted as external packages.

### HITS Analysis

Runs [Kleinberg's HITS algorithm](https://en.wikipedia.org/wiki/HITS_algorithm) on the import graph to separate two kinds of important files:

- **Authorities** (high authority score): files imported by many others, i.e. stable foundations like `types.ts`, `utils.ts`. Read these to understand the vocabulary.
- **Hubs** (high hub score): files that import many others, i.e. orchestration points like `index.ts`, controllers. Read these to understand the flow.

Each file is assigned a role based on its scores: **Foundation**, **Orchestrator**, **Bridge**, **Utility**, or **Leaf**. Edges are weighted by import specificity (number of named imports) and type-only imports contribute less weight (0.3x).

### Config Constraints

Scans `tsconfig.json`, ESLint, Biome, and Prettier configs to extract rules that directly affect code generation:

- TypeScript strict flags (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`)
- Linter rules (`prefer-const`, `consistent-type-imports`, `no-explicit-any`)
- Formatter settings (indent style, quotes, semicolons)

These are rendered as actionable directives: "**Must**: TypeScript strict mode, no implicit any", "**Prefer**: type-only imports". An LLM that doesn't know about `exactOptionalPropertyTypes` will write wrong code. These constraints prevent that.

### Dead File Detection

Identifies files with zero in-degree (nothing imports them), excluding known entry points like `index.ts`, `main.ts`, `app.ts`, `__init__.py`, and test files. These are potential cleanup targets or files that may only be used via side effects.

### Dead Export Removal

Cross-references every named export against the import graph. If nothing in the project imports it, it's excluded from the snapshot.

This catches leftover refactors, over-exported utilities, and test-only helpers, keeping the context lean.

### Token Budgeting

Large projects may have more types and signatures than fit in the token budget. Clarté uses a greedy [knapsack](https://en.wikipedia.org/wiki/Knapsack_problem) approach that prioritizes:

1. Entries from high-centrality files (via HITS authority scores)
2. Recently active files (via git history, using a logarithmic scale)
3. Core categories (types, store shapes, component props)

Lower-priority items fill whatever budget remains.

### Layer Detection

Classifies files into architecture layers based on directory and naming conventions:

```
types  →  stores  →  services  →  hooks  →  components  →  pages
                                              ↑
                                            utils, config
```

The generated context includes a dependency-flow summary so agents understand how layers relate. Cross-layer violations (e.g., types importing from components) are flagged.

### Cycle Detection

Uses [Tarjan's algorithm](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm) to find groups of files that form import cycles, then reports the shortest actual cycle within each strongly connected component via BFS.

**Example:** `auth.ts → user.ts → permissions.ts → auth.ts`. All three files are reported as a circular dependency cluster. Agents are warned to avoid deepening the cycle.

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

### Module Clustering

Uses deterministic [label propagation](https://en.wikipedia.org/wiki/Label_propagation_algorithm) on the import graph to discover natural groupings. Each file starts with its own label and iteratively adopts the most common label among its neighbors. Running Clarté twice on the same codebase produces identical community groupings.

This reveals logical boundaries (auth module, payments module, settings module) even when the folder layout doesn't reflect them.

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
| `--refresh-snapshot` | Re-scan source files and update just the code snapshot |
| `--reconfigure` | Re-prompt even if `.clarte.json` exists |
| `--check` | Check if the snapshot is stale via hash comparison (exit 0 = fresh, 1 = stale) |
| `--check=timestamp` | Timestamp-only staleness check, no file hashing (for shell hooks) |
| `--max-tokens=N` | Set the token budget for the code snapshot |
| `--generate-skills` | Generate Claude Code skill files |
| `-v, --verbose` | Show detailed progress output |

### Diff Mode

Generate focused context for just the files you changed:

```bash
npx clarte --diff         # diff against main
npx clarte --diff=develop # diff against a specific branch
```

This gets changed files from `git diff`, expands to 1-hop neighbors in the import graph, includes test files that cover changed files, and outputs a compact markdown summary to stdout. Useful before every LLM session to give the agent targeted context.

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

## License

[MIT](LICENSE)
