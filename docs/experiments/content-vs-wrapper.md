# Experiment: R.5 - Content vs Wrapper

**Status:** Done (2026-03-04). The "detailed tasks hurt" finding was resolved by [on-demand delivery](on-demand-delivery.md), which skips pre-flight when the prompt already names file paths. The "opaque tasks help" finding motivated [R.20](bm25-retrieval.md) (BM25F targeting).
**Branch:** `experimental/no-go/content-vs-wrapper`

## Context

Full CLAUDE.md generation is the core product: static analysis rendered as
structured context for AI coding agents. But does the content itself help, or
does the mere presence of a context file (the "wrapper") do most of the work?

181 sessions across 3 repos. Tested with Sonnet and Haiku.

## Method

Four experimental conditions:

| Condition | Description |
|-----------|-------------|
| Full context | Complete CLAUDE.md with all sections |
| Hooks | Full context + behavioral hooks |
| No context | No CLAUDE.md at all |
| Placebo | One line: "A TypeScript project. Tests use vitest." |

The placebo condition was the key innovation: it carries zero architectural
information but still triggers Claude Code's system prompt framing
("Contents of .../clarte.md").

After the main benchmark, an ablation study removed individual sections from
the full context to identify which carry value.

### Task types

- **Detailed tasks**: well-specified, file targets named or obvious from the
  description. Agent can self-localize.
- **Opaque tasks**: vague bug reports, no file targets mentioned. Agent must
  discover which files to change.

## Results

### Main benchmark

| Condition | Detailed tasks (turns) | Opaque tasks (turns) |
|-----------|----------------------|---------------------|
| Full context | +12% vs placebo | -14% vs placebo |
| Placebo | baseline | baseline |
| No context | +8% vs placebo | +22% vs placebo |

Full context added +24.5% more processing overhead than placebo on detailed tasks.

### Wrapper effect

The system prompt wrapper "Contents of .../clarte.md (project instructions,
checked into the codebase)" suppresses the agent's discovery phase. When Claude
Code sees this header, it skips the initial "let me explore the project"
sequence. This saves 1-2 turns regardless of what follows the header.

Placebo inherits this wrapper effect with zero content overhead.

### Ablation

Removed one section at a time from full context. Three sections carry
measurable value:

| Section | Effect when removed |
|---------|-------------------|
| Working Guidelines | +2-3 turns on tasks touching flagged files |
| Key Files | +1-2 turns on architectural questions |
| Change Coupling | +1 turn on multi-file edits |

All other sections (architecture, conventions, hot files, chokepoints, tight
coupling, dead files, cross-cutting) showed no measurable effect when removed
individually.

## Insight

The wrapper IS the confidence signal. "Contents of CLAUDE.md" tells the agent
"this project is understood, start working" - the content behind that header
matters only when the task is genuinely ambiguous.

On detailed tasks, full context is information overload. The agent reads
coupling pairs, chokepoints and directives it doesn't need, burning turns on
files outside the task scope.

On opaque tasks, the three valuable sections (guidelines, key-files,
change-coupling) provide routing hints the agent cannot derive from the
codebase alone.

This result reframes the product: context generation should be minimal by
default, with full output reserved for monorepo or opaque-task scenarios.
