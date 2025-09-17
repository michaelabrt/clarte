# Context-pilot

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.

## What Is This

This project is actually the repository which hosts the tool you are running, so the goal is to optimize context usage and cost, while enhancing AI's capabilities.

## Tech Stack

- **Vitest** 4.0.18 (used in 5 files)
- **TypeScript**
- **npm** (package manager)

## Project Structure

```
src/
  __tests__/
scripts/
```

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 10 | 2 minutes ago |
| `src/types.ts` | 8 | 2 minutes ago |
| `src/templates/main-context.ts` | 6 | 2 minutes ago |
| `package.json` | 5 | 2 minutes ago |
| `src/generate.ts` | 5 | 2 minutes ago |
| `README.md` | 5 | 11 minutes ago |
| `src/snapshot.ts` | 5 | 17 minutes ago |
| `src/templates/cursor-rules.ts` | 4 | 2 minutes ago |
| `src/summary.ts` | 4 | 2 minutes ago |
| `src/detect.ts` | 4 | 17 minutes ago |

## Change Coupling

Files that frequently change together. Consider whether they should be colocated or decoupled.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/index.ts` | `src/types.ts` | 8 | 80% |
| `README.md` | `src/generate.ts` | 4 | 80% |
| `src/templates/main-context.ts` | `src/types.ts` | 6 | 75% |
| `src/detect.ts` | `src/templates/cursor-rules.ts` | 3 | 75% |
| `src/snapshot.ts` | `src/summary.ts` | 3 | 75% |
| `src/templates/cursor-rules.ts` | `src/templates/main-context.ts` | 4 | 67% |
| `README.md` | `src/templates/main-context.ts` | 4 | 67% |
| `src/detect.ts` | `src/templates/main-context.ts` | 4 | 67% |
| `src/generate.ts` | `src/templates/main-context.ts` | 4 | 67% |
| `package-lock.json` | `package.json` | 3 | 60% |

## Development

```bash
npm install
npm run dev
```
