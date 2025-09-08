# context-pilot

Bootstrap optimized AI context files for any project. Auto-detects your tech stack, generates code snapshots, and produces config for Claude Code, Cursor, or OpenCode.

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

## What It Generates

| Tool | Files |
|------|-------|
| Claude Code | `CLAUDE.md` |
| Cursor | `CLAUDE.md` + `.cursor/rules/*.md` (glob-scoped) |
| OpenCode | `AGENTS.md` |
| Generic | `CONTEXT.md` |

## Options

```bash
npx context-pilot [directory] [--force]
```

- `directory` — path to analyze (defaults to current directory)
- `--force` — overwrite existing files without asking

## Living Documents

Generated files include maintenance directives telling your AI agent to keep them up to date as the project evolves. The code snapshot section is marked with HTML comments so it's clear what to refresh after refactors.

## Development

```bash
npm install
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run typecheck  # Type-check without emitting
```
