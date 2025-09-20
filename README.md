# codebrief

Give your AI agent full project context, without the warm-up.

![codebrief demo](demo.gif)

AI coding agents spend their first few minutes reading files, tracing imports, and piecing together your architecture. **codebrief** does that work once, ahead of time, and hands the agent a single context file so it can start writing useful code immediately.

```bash
npx codebrief
```

## Before & After

Without codebrief, a typical AI agent session starts like this:

```
Agent: Let me explore the project structure...
Agent: Reading src/index.ts...
Agent: Reading src/types.ts...
Agent: Reading src/utils/api-client.ts...
Agent: Reading src/store/auth.ts...
Agent: Now I understand the architecture. Let me start working...
```

With codebrief, the agent already knows:

| What | Example |
|------|---------|
| Tech stack | Next.js 14 (App Router), TypeScript, Zustand, Tailwind |
| Key files | `src/types.ts` (highest centrality), `src/api/client.ts` |
| Architecture | services → hooks → components → pages |
| Active areas | `src/auth/` changed 12 times in the last 90 days |
| Coupled files | `routes.ts` and `middleware.ts` always change together |
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
| `src/types.ts` | 18 files | stable |
| `src/lib/api-client.ts` | 12 files | stable |
| `src/store/auth.ts` | 9 files | stable |

## Architecture

‍```
┌──────────────┐    ┌──────────────┐
│    types      │    │   services    │
└──────────────┘    └──────────────┘
        │                    │
        ▼                    ▼
┌──────────────┐    ┌──────────────┐
│    hooks      │    │  components   │
└──────────────┘    └──────────────┘
‍```

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/app/chat/page.tsx` | 14 | 2 days ago |
| `src/lib/api-client.ts` | 11 | 3 days ago |

<!-- ... more sections: change coupling, module clusters, gotchas -->
```

</details>

## Quick Start

Run in your project root:

```bash
npx codebrief
```

codebrief will:

1. **Detect** your tech stack (language, framework, package manager, linter)
2. **Ask** a few questions (which AI tool, project purpose, key patterns)
3. **Scan** source files for a code snapshot (types, store shapes, component props)
4. **Generate** an optimized context file for your chosen tool
5. **Show** a summary with token savings estimate

Your answers are saved to `.codebrief.json` so future runs skip the prompts.

## Supported Tools

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

codebrief runs a pipeline of static analysis steps. Here's a quick overview:

| Step | What it does | Why it matters |
|------|-------------|----------------|
| [Dependency graph](#dependency-graph) | Parses all `import`/`require`/`use` statements | Maps how files connect to each other |
| [PageRank](#pagerank) | Ranks files by structural importance | Surfaces the files an agent should read first |
| [Dead export removal](#dead-export-removal) | Drops exports nothing imports | Saves tokens on unused code |
| [Token budgeting](#token-budgeting) | Fits the snapshot into a token limit | Keeps context files within model limits |
| [Layer detection](#layer-detection) | Classifies files into architecture layers | Gives agents a mental model of your project |
| [Cycle detection](#cycle-detection) | Finds circular import chains | Warns agents about risky dependency loops |
| [Instability scoring](#instability-scoring) | Flags volatile, widely-depended-on files | Tells agents where to be extra careful |
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

### PageRank

Runs the [PageRank algorithm](https://en.wikipedia.org/wiki/PageRank) on the import graph. The same algorithm Google uses to rank web pages. Files imported by many important files score highest.

**Example:** In a typical project, `types.ts` or `api-client.ts` often ranks #1 because most of the codebase depends on them. These high-centrality files appear first in the generated context so agents understand foundational code before details.

### Dead Export Removal

Cross-references every named export against the import graph. If nothing in the project imports it, it's excluded from the snapshot.

This catches leftover refactors, over-exported utilities, and test-only helpers, keeping the context lean.

### Token Budgeting

Large projects may have more types and signatures than fit in the token budget. codebrief uses a greedy [knapsack](https://en.wikipedia.org/wiki/Knapsack_problem) approach that prioritizes:

1. Entries from high-centrality files (via PageRank)
2. Recently active files (via git history)
3. Core categories (types, store shapes, component props)

Lower-priority items fill whatever budget remains.

### Layer Detection

Classifies files into architecture layers based on directory and naming conventions:

```
types  →  stores  →  services  →  hooks  →  components  →  pages
                                              ↑
                                            utils, config
```

The generated context includes a dependency-flow summary so agents understand how layers relate (e.g., "services call the API, components use hooks, hooks read from stores").

### Cycle Detection

Uses [Tarjan's algorithm](https://en.wikipedia.org/wiki/Tarjan%27s_strongly_connected_components_algorithm) to find groups of files that form import cycles.

**Example:** `auth.ts → user.ts → permissions.ts → auth.ts`. All three files are reported as a circular dependency cluster. Agents are warned to avoid deepening the cycle.

### Instability Scoring

Computes an [instability metric](https://en.wikipedia.org/wiki/Software_package_metrics) for each file:

```
instability = outgoing imports / (outgoing + incoming imports)
```

Files that are both highly unstable (many outgoing deps) **and** widely depended on (many incoming deps) are flagged as risk zones.

### Change Coupling

Analyzes 90 days of git history to find file pairs that frequently appear in the same commits.

**Example output:**

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/api/client.ts` | `src/api/types.ts` | 12 | 92% |
| `src/routes.ts` | `src/middleware.ts` | 8 | 80% |

This catches implicit dependencies that don't show up in imports. Agents know that touching one file likely means touching the other.

### Module Clustering

Uses [label propagation](https://en.wikipedia.org/wiki/Label_propagation_algorithm) on the import graph to discover natural groupings. Each file starts with its own label and iteratively adopts the most common label among its neighbors. Files sharing a label form a module cluster.

This reveals logical boundaries (auth module, payments module, settings module) even when the folder layout doesn't reflect them.

### Git Activity

Counts commits per file over the last 90 days to surface:

- **Hot spots**: files with the most churn
- **Recently active files**: where current development is focused
- **Quiet zones**: stable code that rarely changes

### Stale Detection

Hashes all source file paths and modification times. Run `--check` to compare against the stored hash:

```bash
npx codebrief --check
# exit 0 = snapshot is fresh
# exit 1 = snapshot is stale, run --refresh-snapshot
```

## Options

```bash
npx codebrief [directory] [options]
```

| Flag | Description |
|------|-------------|
| `directory` | Path to analyze (defaults to `.`) |
| `-h, --help` | Show help message |
| `-V, --version` | Show version number |
| `--force` | Overwrite existing files without asking |
| `--dry-run` | Preview what would be generated |
| `--refresh-snapshot` | Re-scan source files and update just the code snapshot |
| `--reconfigure` | Re-prompt even if `.codebrief.json` exists |
| `--check` | Check if the snapshot is stale via hash comparison (exit 0 = fresh, 1 = stale) |
| `--check=timestamp` | Timestamp-only staleness check — instant, no file hashing (for shell hooks) |
| `--max-tokens=N` | Set the token budget for the code snapshot |
| `--generate-skills` | Generate Claude Code skill files |
| `-v, --verbose` | Show detailed progress output |

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx codebrief --refresh-snapshot
```

This finds the `<!-- CODE SNAPSHOT -->` markers in your context file, re-scans source files, and replaces just that section.

## Shell Integration

Automatically detect stale snapshots when you `cd` into a project. These hooks run in pure shell (no Node.js boot), so they add zero latency to your prompt:

<details>
<summary><strong>zsh</strong></summary>

```zsh
# Add to ~/.zshrc
chpwd() {
  if [[ -f .codebrief.json ]]; then
    local ts days stale_days
    ts=$(command grep -o '"snapshotGeneratedAt":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*$')
    [[ -z "$ts" ]] && return
    stale_days=$(command grep -o '"staleDays":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*$')
    : "${stale_days:=7}"
    days=$(( ($(date +%s) - ts / 1000) / 86400 ))
    (( days > stale_days )) && echo "codebrief: snapshot is ${days}d old. Run: npx codebrief --refresh-snapshot"
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
  if [[ -f .codebrief.json ]]; then
    local ts days stale_days
    ts=$(command grep -o '"snapshotGeneratedAt":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*$')
    [[ -z "$ts" ]] && return
    stale_days=$(command grep -o '"staleDays":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*$')
    : "${stale_days:=7}"
    days=$(( ($(date +%s) - ts / 1000) / 86400 ))
    (( days > stale_days )) && echo "codebrief: snapshot is ${days}d old. Run: npx codebrief --refresh-snapshot"
  fi
}
```

</details>

<details>
<summary><strong>fish</strong></summary>

```fish
# Add to ~/.config/fish/conf.d/codebrief.fish
function __codebrief_check --on-variable PWD
  if test -f .codebrief.json
    set -l ts (command grep -o '"snapshotGeneratedAt":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*\$')
    test -z "$ts"; and return
    set -l stale_days (command grep -o '"staleDays":[0-9]*' .codebrief.json 2>/dev/null | command grep -o '[0-9]*\$')
    test -z "$stale_days"; and set stale_days 7
    set -l days (math "( "(date +%s)" - $ts / 1000) / 86400")
    test $days -gt $stale_days; and echo "codebrief: snapshot is "$days"d old. Run: npx codebrief --refresh-snapshot"
  end
end
```

</details>

> **Tip:** Set `"staleDays": 14` in `.codebrief.json` to customize the threshold. For CI/pre-commit use the hash-based `--check` instead.

## Config File

On first run, codebrief saves your answers to `.codebrief.json`:

```json
{
  "_version": 1,
  "ide": "cursor",
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

Add `.codebrief.json` to your `.gitignore`. It's local tool config, not project docs.

## Framework Conventions

codebrief detects your framework and includes relevant best practices:

| Framework | What's included |
|-----------|----------------|
| Next.js | App Router vs Pages Router, server components, route handlers |
| Express | Middleware chain, error handling, router organization |
| FastAPI | Dependency injection, Pydantic models, async endpoints |
| Django | Apps structure, models-views-templates, migrations |
| NestJS | Modules, controllers, providers, guards |
| SvelteKit | Load functions, form actions, server routes |
| Expo / React Native | Routing, native modules, platform-specific files |
| Vue / Nuxt | Composition API, auto-imports, data fetching |

Also supports: Fastify, Hono, Angular, Svelte, Prisma, Drizzle, Tailwind CSS, Electron, and more.

## Monorepo Support

codebrief detects monorepo tooling and can generate per-package context files:

- **pnpm workspaces** (`pnpm-workspace.yaml`)
- **Turborepo** (`turbo.json`)
- **Nx** (`nx.json`)

When detected, you'll be asked if you want per-package files. Each package gets its own scoped context with that package's dependencies, frameworks, and code snapshot.

## Living Documents

Generated files include maintenance directives telling your AI agent to keep them up to date. The code snapshot section uses HTML comment markers (`<!-- CODE SNAPSHOT -->`) so it's clear what to refresh after refactors.

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
