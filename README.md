# codebrief

Bootstrap optimized AI context files for any project. Auto-detects your tech stack, generates code snapshots, and produces config for Claude Code, Cursor, Copilot, Windsurf, Cline, Continue, Aider, and more.

![codebrief demo](demo.gif)

## Quick Start

```bash
npx codebrief
```

Run in your project root. It will:

1. **Auto-detect** your tech stack (language, framework, package manager, linter)
2. **Ask** a few questions (which AI tool, project purpose, key patterns)
3. **Scan** source files for a code snapshot (types, store shapes, component props)
4. **Generate** optimized context files for your chosen tool
5. **Show** a summary with token savings estimate

On first run, your answers are saved to `.codebrief.json` so future runs skip the prompts entirely.

## What It Does

codebrief builds a comprehensive understanding of your codebase and distills it into context files that AI agents can load instantly — eliminating the expensive exploration phase where agents read dozens of files just to understand the architecture.

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

codebrief runs a pipeline of static analysis on your codebase. Here's what each step does and why it matters.

### Mapping dependencies

**Problem:** AI agents don't know which files depend on each other, so they waste time reading unrelated code.

codebrief parses all `import`/`require`/`use` statements across your source files and builds a dependency graph. This graph powers most of the analysis below — it's how codebrief understands the structure of your project without running it.

### Ranking files by importance (PageRank)

**Problem:** In a project with hundreds of files, which ones should an agent read first?

codebrief runs the same algorithm Google uses to rank web pages — but on your import graph instead of the internet. Files that are imported by many important files get a high score. For example, your main `types.ts` or a shared `api-client.ts` would rank near the top because they sit at the center of your dependency tree. These high-centrality files are surfaced first so agents understand your architecture before diving into details.

### Removing dead exports

**Problem:** Source files often contain exported functions, types, or constants that nothing actually imports — leftover refactors, unused utilities, or over-exported modules. Including these in context wastes tokens.

codebrief cross-references every named export against the import graph. If no file in the project imports it, it's excluded from the code snapshot.

### Fitting context into a token budget

**Problem:** A full code snapshot of every type, interface, and function signature might exceed the token budget — especially in large projects.

codebrief uses a greedy knapsack approach: it prioritizes entries from the most central files, recently active files, and core categories (types, store shapes) first, then fills the remaining budget with lower-priority items. This ensures the most valuable context always makes it in, even under tight limits.

### Detecting architectural layers

**Problem:** Agents need to understand the high-level shape of a project — where the types live, where the API calls happen, where the UI components are.

codebrief classifies files into layers (types, stores, hooks, services, components, pages, utils, config) based on directory and naming conventions, then analyzes how those layers depend on each other. This gives agents a quick mental model like "services call the API, components use hooks, hooks read from stores."

### Finding circular dependencies (Tarjan's SCC)

**Problem:** Circular imports cause subtle bugs, make refactoring dangerous, and confuse AI agents trying to understand dependency flow.

codebrief uses Tarjan's algorithm to find groups of files that form import cycles. For example, if `auth.ts → user.ts → permissions.ts → auth.ts`, all three files are reported as a circular dependency cluster. This is surfaced in the context so agents avoid introducing more cycles.

### Flagging unstable files

**Problem:** Some files change frequently but are imported by many others — any modification risks breaking things across the project.

codebrief computes an instability score for each file based on how many files it imports vs. how many files import it. Files that are both highly unstable and widely depended on are flagged as risk zones — agents will know to be extra careful when modifying them.

### Detecting change coupling

**Problem:** Some files always need to change together (e.g., a component and its test, or a route and its handler) but there's no import relationship between them.

codebrief analyzes 90 days of git history to find file pairs that frequently appear in the same commits. If two files were changed together in many commits, they're reported as coupled — so agents know that touching one likely means touching the other.

### Discovering module clusters

**Problem:** Large projects have natural groupings of related files (an auth module, a payments module) but these aren't always obvious from the folder structure.

codebrief uses label propagation on the import graph: each file starts with its own label and iteratively adopts the most common label among its neighbors. Files that end up sharing a label form a natural cluster. This reveals logical modules even when the folder layout doesn't match.

### Tracking git activity

**Problem:** Agents don't know which parts of the codebase are actively being worked on vs. which are stable.

codebrief counts commits per file over the last 90 days to surface hot spots and recently active files. This helps agents understand where current development is focused.

### Detecting stale snapshots

**Problem:** After a refactor, the code snapshot in your context file may be outdated — describing types and signatures that no longer exist.

codebrief hashes all source file paths and modification times. When you run `--check`, it compares this hash against the stored one to tell you if the snapshot needs refreshing.

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
npx codebrief [directory] [options]
```

| Flag | Description |
|------|-------------|
| `directory` | Path to analyze (defaults to current directory) |
| `--force` | Overwrite existing files without asking |
| `--dry-run` | Show what would be generated without writing any files |
| `--refresh-snapshot` | Re-scan source files and update the code snapshot in your existing context file |
| `--reconfigure` | Force re-prompting even if `.codebrief.json` exists |
| `--check` | Check if the snapshot is stale (exit code 0 = fresh, 1 = stale). Designed for shell integration. |
| `--max-tokens=N` | Set the token budget for the code snapshot |

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx codebrief --refresh-snapshot
```

This auto-detects your context file (CLAUDE.md, AGENTS.md, etc.), finds the `<!-- CODE SNAPSHOT -->` markers, re-scans source files, and replaces just that section in-place.

## Shell Integration

Use `--check` to automatically detect stale snapshots when you `cd` into a project:

### zsh

```zsh
# Add to ~/.zshrc
chpwd() {
  if [[ -f .codebrief.json ]]; then
    npx --yes codebrief --check 2>/dev/null
  fi
}
```

### bash

```bash
# Add to ~/.bashrc
cd() {
  builtin cd "$@" || return
  if [[ -f .codebrief.json ]]; then
    npx --yes codebrief --check 2>/dev/null
  fi
}
```

### fish

```fish
# Add to ~/.config/fish/conf.d/codebrief.fish
function __codebrief_check --on-variable PWD
  if test -f .codebrief.json
    npx --yes codebrief --check 2>/dev/null
  end
end
```

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

Subsequent runs load this config and skip all prompts. Use `--reconfigure` to re-prompt with your saved values as defaults.

Add `.codebrief.json` to your `.gitignore` — it's a local tool config, not project documentation.

## Framework Conventions

codebrief detects specific frameworks and automatically includes relevant best practices in the generated output:

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

codebrief detects monorepo tooling and can generate per-package context files:

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
