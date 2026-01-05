# Experiment: MCP Tools for Graph Context Delivery

**Branch:** `experimental/ongoing/mcp-tools`
**Date:** 2026-03-01
**Verdict:** NO-GO (MCP tools), GO (hooks for Sonnet+, cursor rules)

## Theory

Graph data (betweenness, chokepoints, co-change, transitive tests) is valuable for agent navigation. The main context file includes top-level summaries, but per-file graph data can't all fit in a static file. Hypothesis: exposing graph data via MCP tools lets agents query on-demand when working with specific files.

Three delivery mechanisms were tested:
1. **MCP tools** (agent-initiated): `clarte_inspect` and `clarte_impact` tools the agent can call voluntarily
2. **Claude Code hooks** (automatic): `PreToolUse` hook injects graph context whenever the agent reads a file
3. **Cursor rules** (automatic): `.mdc` files with glob patterns deliver per-directory graph context

## Implementation

### V1-V3: MCP Server

Built an MCP server (`src/mcp/server.ts`) with two tools:

- `clarte_inspect <path>`: Returns file role, betweenness, chokepoint status, co-change partners, transitive test coverage
- `clarte_impact <path>`: Returns predicted impact (dependents, downstream files, recommended review scope)

Iterated through three versions:
- V1: Basic tool with verbose output
- V2: Compact output format, added impact tool
- V3: Added hints in CLAUDE.md working guidelines: "For files not listed in Key Files, query `clarte_inspect <path>` for graph-derived context"

### Hooks (Claude Code PreToolUse)

Built a `PreToolUse` hook that fires on every `Read` tool call:
- Reads `context-map.json` (pre-computed graph data for significant files)
- Matches the file being read against the map
- Returns `additionalContext` JSON that Claude Code appends to the Read result
- Files qualify if: betweenness > 10%, or chokepoint, or has co-change partners, or has transitive integration tests

### Cursor Rules (per-directory .mdc)

Built `buildGraphContextRules()` that groups qualifying files by directory and generates `.cursor/rules/graph-<dir>.md` files with glob patterns. Same qualification thresholds as hooks. Capped at 10 rules.

### Files modified

| File | Change |
|------|--------|
| `src/mcp/server.ts` | MCP server with inspect/impact tools (deleted) |
| `src/mcp/tools.ts` | Tool handlers (deleted) |
| `src/mcp/formatters.ts` | Output formatters (deleted) |
| `src/hooks/generate-hooks.ts` | Hook file generation + SessionStart model gate |
| `src/hooks/context-map.ts` | Shared graph data formatting |
| `src/templates/cursor-rules.ts` | Per-directory graph context rules |
| `src/core/generate.ts` | Wiring for cursor rules |

## Evaluation

### MCP Tools: 0% voluntary adoption

Across 11 benchmark sessions (Sonnet 4.6, temp=0), agents never called `clarte_inspect` or `clarte_impact` voluntarily. Not once. This held true across:
- Tasks where graph context would have helped (modifying chokepoint files)
- Tasks where the CLAUDE.md hint explicitly suggested using the tool
- Different tool description phrasings

The failure mode is fundamental: agents don't call optional tools. They read files, write code, and run tests. Adding more tools to the available set doesn't change agent behavior.

### Hooks: Model-dependent results

Ran E.3 benchmarks (temp=0.3) on 3 tasks across 2 models.

**Haiku 4.5** (3 tasks x 3 reps):

| Task | Baseline turns | With hooks | Delta |
|------|---------------|------------|-------|
| bug-fix-retry | 7 | 9.7 | **+39%** |
| test-notification | 9 | 10 | **+11%** |
| fix-order-tax | 12 | 16 | **+33%** |

**Sonnet 4.6** (3 tasks x 2 reps):

| Task | Baseline turns | With hooks | Delta |
|------|---------------|------------|-------|
| bug-fix-retry | 8.5 | 7.5 | **-12%** |
| test-notification | 12.5 | 12 | **-4%** |
| fix-order-tax | 9 | 5.5 | **-39%** |

### Root cause of Haiku regression

Investigation showed 19/57 files (33%) in the ecommerce-api fixture get context injected. Each injection is 5-13 tokens. The problem is behavioral, not token cost:

- Haiku follows breadcrumbs: when context mentions co-change partners ("also check src/orders/tax.ts"), Haiku reads those files even when not needed
- Haiku becomes more cautious with "important" files: extra verification reads, more conservative edits
- Sonnet filters this as background information and stays focused on the task

### Model gate solution

Added a `SessionStart` hook that checks the model name. When the model contains "haiku", it writes `CLARTE_HOOKS_DISABLED=1` to `CLAUDE_ENV_FILE`. The `PreToolUse` hook checks this env var and exits early if set.

## Why NO-GO (MCP tools)

1. **0% adoption.** Agents never call optional tools. This is a fundamental behavioral constraint, not a tool design issue.
2. **Push beats pull.** Automatic delivery (hooks, rules) works; agent-initiated queries don't.
3. **Complexity cost.** The MCP server added `@modelcontextprotocol/sdk` as a dependency and a separate build entry point for zero benefit.

## Why GO (hooks for Sonnet+)

1. **Clear positive signal.** Sonnet showed -12% to -39% turn reduction across all 3 tasks.
2. **Model gate prevents harm.** Haiku regression (+11% to +39%) is fully mitigated by the SessionStart gate.
3. **Non-critical path.** Hooks are generated alongside context files. Failures are silently caught.

## Lessons learned

- **Agents don't call optional tools.** This is the single most important finding. Don't build features that require agents to voluntarily adopt new behaviors. Push context to them instead.
- **Model capability matters for context injection.** Sonnet can filter signal from noise in injected context; Haiku cannot. Any per-file context delivery needs model gating.
- **SessionStart + CLAUDE_ENV_FILE is the right gating mechanism.** It runs once per session, persists the decision, and the PreToolUse hook can check it with zero overhead.

## Future directions

- Run full E.3 (7+ reps per task) on Sonnet to confirm statistical significance
- Investigate per-file delivery for other IDEs as they add hook support
- Cursor rules are shipped without model gating since the delivery mechanism is different (glob-matched rules vs per-file injection)
