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
npx context-pilot [directory] [--force] [--dry-run]
```

- `directory` — path to analyze (defaults to current directory)
- `--force` — overwrite existing files without asking
- `--dry-run` — show what would be generated without writing any files

## Living Documents

Generated files include maintenance directives telling your AI agent to keep them up to date as the project evolves. The code snapshot section is marked with HTML comments so it's clear what to refresh after refactors.

## Development

```bash
npm install
npm run build      # Build with tsup
npm run dev        # Watch mode
npm run typecheck  # Type-check without emitting
```
