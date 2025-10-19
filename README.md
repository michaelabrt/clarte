<p align="center">
  <a href="#"><img src="logo.svg#gh-light-mode-only" width="140" alt="Clarté logo" /></a>
  <a href="#"><img src="logo-dark.svg#gh-dark-mode-only" width="140" alt="Clarté logo" /></a>
</p>
<h1 align="center">Clarté</h1>
<p align="center"><em>/klaʁ.te/</em></p>

<p align="center">
  <a href="https://github.com/michaelabrt/clarte/actions/workflows/release.yml"><img src="https://github.com/michaelabrt/clarte/actions/workflows/release.yml/badge.svg" alt="CI"></a>
    <a href="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml"><img src="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/clarte"><img src="https://img.shields.io/npm/v/clarte" alt="npm version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-blue" alt="TypeScript"></a>
  <a href="https://opensource.org/licenses/MIT"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT"></a>
</p>

Clarté is a static analysis engine. It parses your imports, builds a dependency graph, runs graph algorithms on it (HITS centrality, Tarjan's SCC, community detection, change coupling), analyzes your git history and outputs a context file that AI coding tools can read.

The problem it solves: when an AI coding agent opens a session on your project, it spends its first turns reading files, tracing imports and piecing together your architecture. Clarté does that analysis once, ahead of time. One run produces a context file with your dependency graph, key files, architectural layers and working guidelines.

```bash
npx clarte
```

## What the output contains

| Section | Example |
|---------|---------|
| Tech stack | Next.js 14 (App Router), TypeScript, Zustand, Tailwind |
| Key files | `src/types.ts` (Foundation), `src/api/client.ts` (Orchestrator) |
| Architecture layers | types -> stores -> hooks -> components -> pages |
| Working guidelines | "When modifying `src/graph.ts`, check `src/types.ts` for breaking changes" |
| Active areas | `src/auth/` changed 12 times in the last 90 days |
| Cross-cutting files | `src/types.ts` spans 5 layers; changes have wide blast radius |
| Chokepoints | `src/utils.ts` separates 3 components; no alternative paths |
| Change coupling | `routes.ts` and `middleware.ts` always change together |
| Hidden coupling | `schemas/user.ts` and `store/user.ts` co-change but have no import path |
| Tight coupling | `index.ts` imports 14 names from `graph.ts`; consider an interface |
| Dead files | Files with zero imports that may be safe to remove |
| Code snapshot | Public types, interfaces, props and function signatures |

<details>
<summary><strong>Example: generated CLAUDE.md</strong> (click to expand)</summary>

```markdown
# MyProject

> **Keep this file up to date.** When you change the architecture, add a dependency,
> create a new pattern, or learn a gotcha, update this file in the same step.

## What Is This

A mobile AI chat app connecting to OpenAI, Anthropic and Google APIs

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
4. **Generate** context files for your chosen tools
5. **Show** a summary with token estimate

Your answers are saved to `.clarte.json` so future runs skip the prompts.

## Benchmarks

We benchmark how clarte context affects AI agent performance. Same tasks, same model, with and without context. Statistical testing with Mann-Whitney U, bootstrap CIs, and Cliff's delta effect sizes.

**Claude Haiku 4.5**, 3 TypeScript fixture tasks, 7 repetitions each (127 sessions total):

| Metric | Without Context | With Context | Delta |
|--------|----------------|--------------|-------|
| Pass rate | 86% | **95%** | +9pp |
| Turns (median) | 19 | **14** | -26% (p<0.001) |
| Cost (median) | $0.35 | **$0.29** | -15% |

**How to read these numbers:**

- **Pass rate** is the main metric. A failed task wastes the entire token budget for nothing. The 9pp improvement means fewer wasted runs.
- **Turns** is the strongest statistical signal (p<0.001, medium effect size). With context, the agent explores less because it already knows where key files are and how the architecture is structured. 5 fewer median turns per task.
- **Cost** shows a modest 15% reduction. Context itself adds ~2,500 tokens to every turn, which partially offsets the savings from fewer turns. The net cost benefit is small; the real value is in pass rate and efficiency.

**Limitations:** This is one fixture (57 TypeScript files), one model (Haiku), and 3 tasks. The fix-order-tax task hit a ceiling (100% pass rate in all conditions), so the differentiation comes primarily from the two harder tasks. Larger codebases and harder tasks should show bigger gaps.

### Section ablation

To identify which sections matter, we ran an exclude-based ablation: remove one section at a time and measure the drop in pass rate.

| Removed Section | Pass Rate | Delta vs. Baseline |
|----------------|-----------|-------------------|
| _(none, full context)_ | 95% | -- |
| Key Files | 76% | **-19pp** |
| Conventions | 81% | **-14pp** |
| Test Mapping | 90% | -5pp |
| Working Guidelines | 91% | -4pp |
| _(all context removed)_ | 86% | -9pp |

**Key Files** and **Conventions** are the highest-value sections. Removing either one hurts more than removing all context entirely, suggesting the agent relies on knowing which files are central and what patterns the codebase follows.

Methodology, fixture projects, and full reports are in the [benchmark repo](https://github.com/michaelabrt/clarte-benchmark).

## Supported Languages

| Language | Import parsing | Snapshot extraction |
|----------|---------------|---------------------|
| TypeScript / JavaScript | `import`, `require` | types, interfaces, functions, components, hooks, stores (AST-based via oxc-parser) |
| Python | `import`, `from ... import` | classes (with public method signatures and docstrings), functions, type aliases |
| Go | `import` | structs, interfaces, functions, methods (grouped by receiver type) |
| Rust | `use` | structs, enums, traits, functions (with generic bounds and where clauses) |
| Java | `import` | classes, interfaces, enums, records, methods (with annotations) |

Multi-language projects are handled automatically. When a secondary language accounts for more than 15% of source files, Clarté runs import parsing and snapshot extraction for that language too and merges the results.

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

Clarté runs a pipeline of static analysis steps. Each one feeds into the next. For the details on each algorithm, see [docs/how-it-works.md](docs/how-it-works.md).

| Step | What it does | Result |
|------|-------------|--------|
| [Dependency graph](docs/how-it-works.md#dependency-graph) | Parses all `import`/`require`/`use` statements | Maps how files connect to each other |
| [HITS analysis](docs/how-it-works.md#hits-analysis) | Computes authority/hub scores, assigns roles | Surfaces foundations, orchestrators and bridges |
| [Config constraints](docs/how-it-works.md#config-constraints) | Extracts rules from tsconfig, ESLint, Biome, Prettier | Prevents wrong code from strict mode, linter rules |
| [Dead file detection](docs/how-it-works.md#dead-file-detection) | Finds files nothing imports | Highlights potential cleanup targets |
| [Dead export removal](docs/how-it-works.md#dead-export-removal) | Drops exports nothing imports | Saves tokens on unused code |
| [Token budgeting](docs/how-it-works.md#token-budgeting) | Fits the snapshot into a token limit | Keeps context files within model limits |
| [Layer detection](docs/how-it-works.md#layer-detection) | Classifies files into architecture layers | Gives agents a mental model of your project |
| [Cycle detection](docs/how-it-works.md#cycle-detection) | Finds circular import chains | Warns agents about risky dependency loops |
| [Instability scoring](docs/how-it-works.md#instability-scoring) | Flags volatile, widely-depended-on files | Tells agents where to be extra careful |
| [Cross-cutting analysis](docs/how-it-works.md#cross-cutting-analysis) | Finds files imported across 3+ layers | Warns agents about wide blast radius |
| [Layer consistency](docs/how-it-works.md#layer-consistency) | Checks import direction against layer order | Prevents new dependency violations |
| [Chokepoint detection](docs/how-it-works.md#chokepoint-detection) | Finds articulation points in the graph | Highlights irreplaceable connectors |
| [Tight coupling](docs/how-it-works.md#tight-coupling) | Counts named imports between file pairs | Highlights files that may need an interface |
| [Change coupling](docs/how-it-works.md#change-coupling) | Finds files that always change together | Prevents incomplete changes |
| [Hidden coupling](docs/how-it-works.md#hidden-coupling) | Finds co-changing files with no import path | Surfaces implicit dependencies |
| [Change impact](docs/how-it-works.md#change-impact-prediction) | Predicts which files need changes when a hub file is modified | Focuses review scope during refactoring |
| [Transitive risk](docs/how-it-works.md#transitive-dependency-risk) | Propagates volatility through the dependency graph | Flags stable files with risky dependencies |
| [Architecture delta](docs/how-it-works.md#architecture-delta) | Diffs analysis snapshots across runs | Tracks architectural drift over time |
| [Fitness functions](docs/how-it-works.md#architectural-fitness-functions) | Checks structural rules (no upward deps, test isolation, layer skips) | Prevents new architectural violations |
| [Git activity](docs/how-it-works.md#git-activity) | Surfaces recently active files | Shows where current work is focused |
| [Stale detection](docs/how-it-works.md#stale-detection) | Hashes file paths + mtimes | Tells you when to re-run |

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
| `--diff[=REF] [FILES]` | Generate focused context for changed files (vs HEAD or REF) |
| `--diff-file=PATH` | Write diff output to a file instead of stdout |
| `--refresh-snapshot` | Re-scan source files and update just the code snapshot |
| `--reconfigure` | Re-prompt even if `.clarte.json` exists |
| `--check` | Check if the snapshot is stale via hash comparison (exit 0 = fresh, 1 = stale) |
| `--check=timestamp` | Timestamp-only staleness check, no file hashing (for shell hooks) |
| `--max-tokens=N` | Set the token budget for the code snapshot |
| `--budget=N` | Set token budget for the context file (prioritized sections) |
| `--full` | Disable token budget (include all sections) |
| `--include=a,b` | Always include these sections (comma-separated IDs) |
| `--exclude=a,b` | Exclude these sections entirely |
| `--format=json` | Output full analysis as structured JSON to stdout |
| `--generate-skills` | Generate Claude Code skill files |
| `--init-hook` | Install git pre-commit hook for automatic snapshot freshness validation |
| `--watch` | Watch for file changes and re-analyze continuously |
| `-v, --verbose` | Show detailed progress output |

### Diff Mode

Generate focused context for just the files you changed:

```bash
npx clarte --diff              # diff against HEAD
npx clarte --diff=main         # diff against a specific ref
npx clarte --diff src/foo.ts   # diff context for specific files
```

Outputs to stdout by default (use `--diff-file=PATH` for file output). For each changed file, the diff includes:

- **Risk annotations**: file role, dependent count and impact warnings
- **Temporal coupling**: files that frequently co-change but aren't in the current diff
- **Cycle context**: circular dependencies involving changed files, with break hints
- **Scoped directives**: architectural guidelines filtered to the changed files only

### Print Mode

Output a compact, token-budgeted architectural summary to stdout. Designed for session hooks:

```bash
npx clarte print                    # Default 5000-token budget
npx clarte print --max-tokens=2000  # Constrained budget
```

Silent no-op when no `.clarte.json` exists, so it's safe to install globally. Automatically detects if a Clarté MCP server is running and emits minimal output to avoid redundancy.

### Hook Installation

One-command setup for Claude Code session hooks:

```bash
npx clarte hooks install    # Add SessionStart + PreCompact hooks
npx clarte hooks uninstall  # Remove clarte hooks
```

This configures `~/.claude/settings.json` so that `clarte print` runs automatically at session start and before context compaction, keeping the agent's architectural context current.

### Watch Mode

Run continuous analysis in a terminal tab while you develop:

```bash
npx clarte --watch          # Watch and re-analyze on file changes
npx clarte --watch -v       # Verbose output
```

On each source file change (debounced 500ms), Clarté rebuilds the import graph incrementally and runs the full analysis pipeline. Architecture deltas (new hub files, resolved cycles, new dead files) are logged as they're detected.

### Context Splitting

For large projects (150+ source files or 8000+ estimated context tokens), Clarté automatically splits context into tiered files:

- **Root context file**: project overview, tech stack, key files, architecture layers, development commands. Links to per-directory files.
- **Per-directory context files**: placed in `.clarte/context/`. Each contains local hub files, dependency patterns, test coverage and related directories.

Monorepo projects are excluded (they already get per-package context).

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx clarte --refresh-snapshot
```

This finds the `<!-- CODE SNAPSHOT -->` markers in your context file, re-scans source files and replaces just that section.

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

Clarté includes an MCP server that exposes architectural analysis as live, queryable tools. Instead of reading a static context file, agents can query specific data mid-session.

### Setup

Add to your Claude Code settings (`~/.claude/settings.json`):

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

When the MCP server is active, `clarte print` automatically detects it and emits minimal output to avoid redundancy.

## Config File

On first run, Clarté saves your answers to `.clarte.json`:

```json
{
  "_version": 2,
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

Clarté detects your framework and includes relevant conventions in the output:

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

Also supports: Fastify, Hono, Angular, Svelte, Prisma, Drizzle, Tailwind CSS, Electron, SQLAlchemy, Celery and more.

## Monorepo Support

Clarté detects monorepo tooling and can generate per-package context files:

- **pnpm workspaces** (`pnpm-workspace.yaml`)
- **Turborepo** (`turbo.json`)
- **Nx** (`nx.json`)

When detected, you'll be asked if you want per-package files. Each package gets its own scoped context with that package's dependencies, frameworks and code snapshot.

Cross-package import analysis detects encapsulation violations (imports that bypass a package's public API) and computes per-package centrality to identify key files within each package.

## Working Guidelines

The generated context includes a **Working Guidelines** section with analysis-derived directives. These aren't informational; each one tells the agent what to do differently:

- **Foundation file guards**: "When modifying `src/graph.ts` (imported by 23 files), check dependents for breaking changes"
- **Chokepoint warnings**: "`src/types.ts` is a structural chokepoint (separates 3 components). Refactor with extreme care."
- **Co-change reminders**: "When modifying `src/graph.ts`, also check: `src/print.ts`, `src/cache.ts`"
- **Circular dependency hints**: "Convert X -> Y to type-only import" (with severity ranking)
- **Complexity warnings**: files with high export counts or line counts get "read thoroughly before modifying" directives
- **Test reminders**: hub files missing test coverage are flagged

Guidelines are refreshed on every run. The `--budget` flag controls how many fit within the token limit.

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
