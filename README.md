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

### Refreshing Snapshots

After a refactor, update just the code snapshot without re-generating the entire file:

```bash
npx context-pilot --refresh-snapshot
```

This auto-detects your context file (CLAUDE.md, AGENTS.md, etc.), finds the `<!-- CODE SNAPSHOT -->` markers, re-scans source files, and replaces just that section in-place.

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
