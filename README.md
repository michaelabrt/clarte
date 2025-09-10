# context-pilot

Bootstrap optimized AI context files for any project. Auto-detects your tech stack, generates code snapshots, and produces config for Claude Code, Cursor, Copilot, Windsurf, Cline, Continue, Aider, and more.

![context-pilot demo](demo.gif)

## Quick Start

```bash
npx context-pilot
```

Run in your project root. It will:

1. **Auto-detect** your tech stack (language, framework, package manager, linter)
2. **Ask** a few questions (which AI tool, project purpose, key patterns)
3. **Scan** source files for a code snapshot (types, store shapes, component props)
4. **Generate** optimized context files for your chosen tool
5. **Show** a summary with token savings estimate

On first run, your answers are saved to `.context-pilot.json` so future runs skip the prompts entirely.

## What It Does

context-pilot builds a comprehensive understanding of your codebase and distills it into context files that AI agents can load instantly — eliminating the expensive exploration phase where agents read dozens of files just to understand the architecture.

The generated context includes:

- **Tech stack summary** with detected frameworks, versions, and usage counts
- **Code snapshot** of all public types, interfaces, function signatures, and component props
- **Key files** ranked by centrality (PageRank) with stability warnings
- **Architecture layers** showing dependency flow
- **Change coupling** — file pairs that frequently change together
- **Circular dependencies** detected via Tarjan's SCC algorithm
- **Module clusters** — automatically detected groups of related files
- **Git activity** — recently active files and churn patterns
- **Framework conventions** — best practices for your specific stack

## How It Works

context-pilot runs a pipeline of static analysis algorithms on your codebase:

1. **Import graph construction** — Parses all source files to extract import/require/use statements and builds a directed graph of internal dependencies.

2. **PageRank centrality** — Runs PageRank on the import graph to identify the most structurally important files. High-centrality files are the "hubs" that agents should read first.

3. **Dead export filtering** — Cross-references named exports against import edges to identify exports that no file in the project actually uses. These are excluded from code snapshots to reduce noise.

4. **Token budgeting (greedy knapsack)** — Fits the code snapshot within a configurable token budget by prioritizing entries from high-centrality files, recently active files, and core categories (types, stores).

5. **Hub file identification** — Ranks files by a combination of centrality score, in-degree (imported-by count), and out-degree (import count).

6. **Architectural layer detection** — Classifies files into layers (types, stores, hooks, services, components, pages, utils, config) based on directory patterns and analyzes cross-layer imports.

7. **Circular dependency detection (Tarjan's SCC)** — Finds all strongly connected components in the import graph. Every SCC with more than one file is a circular dependency cluster. This is more thorough than simple DFS cycle detection — it finds ALL maximal cycles in O(V+E).

8. **Instability analysis (Robert C. Martin)** — Computes `instability = fanOut / (fanIn + fanOut)` for each file. Files with high instability (>70%) and many dependents (fanIn >= 3) are flagged as risk zones — they have high blast radius when changed.

9. **Change coupling detection** — Analyzes 90 days of git history to find file pairs that frequently appear in the same commits. Uses co-occurrence counting with Jaccard-like confidence metrics. Pairs with >= 3 co-changes and >= 50% confidence are reported.

10. **Community/cluster detection (Label Propagation)** — Each file starts with a unique label and iteratively adopts the most common label among its import-graph neighbors. After convergence, files sharing a label form a natural module cluster. Groups of 3+ files are reported.

11. **Git activity analysis** — Counts commits per file over the last 90 days to identify hot spots and recently active files.

12. **Staleness detection** — Hashes all source file paths and modification times. Compares against the stored hash to detect when the snapshot needs refreshing.

## Supported Tools

| Tool | Files Generated |
|------|----------------|
| Claude Code | `CLAUDE.md` |
| Cursor | `CLAUDE.md` + `.cursor/rules/*.md` (glob-scoped) |
| OpenCode | `AGENTS.md` |
| GitHub Copilot | `.github/copilot-instructions.md` |
| Windsurf | `.windsurfrules` |
| Cline | `.clinerules` |
| Continue.dev | `.continuerules` |
| Aider | `.aider.conf.yml` |
| Generic | `CONTEXT.md` |

## Options

```bash
npx context-pilot [directory] [options]
```

| Flag | Description |
|------|-------------|
| `directory` | Path to analyze (defaults to current directory) |
| `--force` | Overwrite existing files without asking |
| `--dry-run` | Show what would be generated without writing any files |
| `--refresh-snapshot` | Re-scan source files and update the code snapshot in your existing context file |
| `--reconfigure` | Force re-prompting even if `.context-pilot.json` exists |
| `--check` | Check if the snapshot is stale (exit code 0 = fresh, 1 = stale). Designed for shell integration. |
| `--max-tokens=N` | Set the token budget for the code snapshot |

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx context-pilot --refresh-snapshot
```

This auto-detects your context file (CLAUDE.md, AGENTS.md, etc.), finds the `<!-- CODE SNAPSHOT -->` markers, re-scans source files, and replaces just that section in-place.

## Shell Integration

Use `--check` to automatically detect stale snapshots when you `cd` into a project:

### zsh

```zsh
# Add to ~/.zshrc
chpwd() {
  if [[ -f .context-pilot.json ]]; then
    npx --yes context-pilot --check 2>/dev/null
  fi
}
```

### bash

```bash
# Add to ~/.bashrc
cd() {
  builtin cd "$@" || return
  if [[ -f .context-pilot.json ]]; then
    npx --yes context-pilot --check 2>/dev/null
  fi
}
```

### fish

```fish
# Add to ~/.config/fish/conf.d/context-pilot.fish
function __context_pilot_check --on-variable PWD
  if test -f .context-pilot.json
    npx --yes context-pilot --check 2>/dev/null
  end
end
```

## Config File

On first run, context-pilot saves your answers to `.context-pilot.json`:

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

Subsequent runs load this config and skip all prompts. Use `--reconfigure` to re-prompt with your saved values as defaults.

Add `.context-pilot.json` to your `.gitignore` — it's a local tool config, not project documentation.

## Framework Conventions

context-pilot detects specific frameworks and automatically includes relevant best practices in the generated output:

- **Next.js** — App Router vs Pages Router patterns, server components, route handlers
- **Express** — middleware chain, error handling, router organization
- **FastAPI** — dependency injection, Pydantic models, async endpoints
- **Django** — apps structure, models-views-templates, migrations
- **NestJS** — modules, controllers, providers, guards
- **SvelteKit** — load functions, form actions, server routes
- **Expo / React Native** — routing, native modules, platform-specific files
- **Vue / Nuxt** — Composition API, auto-imports, data fetching
- And more: Fastify, Hono, Angular, Svelte, Prisma, Drizzle, Tailwind CSS, Electron

## Monorepo Support

context-pilot detects monorepo tooling and can generate per-package context files:

- **pnpm workspaces** (`pnpm-workspace.yaml`)
- **Turborepo** (`turbo.json`)
- **Nx** (`nx.json`)

When a monorepo is detected, you'll be asked if you want per-package context files. Each package gets its own scoped context with that package's specific dependencies, frameworks, and code snapshot.

## Living Documents

Generated files include maintenance directives telling your AI agent to keep them up to date as the project evolves. The code snapshot section is marked with HTML comments so it's clear what to refresh after refactors.

## Development

```bash
npm install
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run typecheck  # Type-check without emitting
```
