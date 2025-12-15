# Experiment: Per-File Docs

**Branch:** `experimental/no-go/per-file-docs`
**Date:** 2026-03-01
**Verdict:** NO-GO

## Theory

For large repos (50k+ LOC), CLAUDE.md exceeds the token budget and sections get dropped. Per-file docs provide an alternative delivery mechanism: write file-specific architectural context to `.clarte/docs/<filepath>.md` files that agents can read on demand. This keeps CLAUDE.md compact while making detailed guidance available for files the agent actually touches.

Two variants were tested:
1. **With deduplication**: Remove sections from CLAUDE.md that are now covered by per-file docs (test-mapping, chokepoints, tight-coupling, cross-cutting, change-coupling)
2. **Without deduplication**: Keep CLAUDE.md intact, add per-file docs as supplemental context

## Implementation

### Per-file doc generation (`src/per-file-docs.ts`)

Files qualify for per-file docs based on a composite score (need 2+ points):
- High fan-in (imported by 5+ files)
- Structural risk (chokepoint or cross-cutting)
- High instability (>0.8)
- Change coupling (confidence >= 0.3)
- Tight coupling (many shared exports)
- Circular dependency membership
- High centrality (betweenness >0.3 or authority >=0.1)
- Has tests
- Named role (Orchestrator or Foundation)

Each per-file doc contains: role/metrics header, dependents list, test files, co-change partners, tight coupling info, risk factors, and actionable guidelines.

### CLAUDE.md deduplication

When per-file docs are enabled, these sections are removed from CLAUDE.md:
- test-mapping, chokepoints, tight-coupling, cross-cutting, change-coupling
- Working Guidelines directives that are covered per-file (co-change hints, test commands, refactor warnings)

Hidden-coupling is preserved because it involves non-source files (e.g., `package-lock.json`).

### Files modified
- `src/per-file-docs.ts` - per-file doc generation with composite scoring
- `src/persist.ts` - file persistence to `.clarte/docs/`
- `src/analysis-graph.ts` - serializable analysis graph for MCP/per-file queries
- `src/templates/directives.ts` - dedup filtering of Working Guidelines
- `src/templates/main-context.ts` - per-file docs integration, section filtering
- `src/generate.ts` - pipeline integration

## What Was Tested

### E.1 (deterministic)
All gates passed: tsc, vitest, golden tests. Self-test on clarte showed per-file docs generated for ~15 qualifying files.

### E.2 (3 reps x 4 opaque tasks x 3 conditions)

**Pass rates:**

| Task | per-file-docs | with-context | without-context |
|---|---|---|---|
| add-pagination | 33% | 67% | 100% |
| fix-task-transition | 100% | 100% | 100% |
| test-date-utils | 100% (1 rep) | 100% (1 rep) | 100% |
| fix-order-tax | 100% (1 rep) | no data | 100% |

**Cost/turns (medians):**

| Condition | Cost | Turns |
|---|---|---|
| per-file-docs | $0.42 | 11 |
| with-context | $0.52 | 13 |
| without-context | $0.67 | 14.5 |

Per-file-docs was cheaper and faster, but had the worst pass rate.

### Overconfidence investigation

Deep analysis of the add-pagination failures revealed a consistent pattern across ALL benchmark runs (Feb 18 through Mar 1):

| Condition | Uses write() | Pass Rate |
|---|---|---|
| Any clarte context | 0% (never) | 33-67% |
| without-context | 100% (always 1-2 writes) | 100% |

The failing sessions pass 3/4 evaluators (tests pass, test count met, types check). They only fail the content-match evaluator checking for `listUsers|cursor|pagination` in `src/resources/users.ts`.

**Root cause**: Agents with architectural context modify the existing `list()` method (convention-respecting) rather than adding a new `listUsers()` method (prompt-literal). They use parameter names like `after` instead of `cursor`. The implementation is correct (tests pass) but the evaluator checks naming, not behavior.

This is an evaluator fragility issue, not a context harm issue. Context causes architecturally-sound convention-following, which is desirable behavior.

## Why It Failed

### 1. Deduplication removed too much from CLAUDE.md
- 5 sections removed entirely
- 10+ directive categories removed from Working Guidelines
- Cross-file relationships (co-change hints, lag coupling) lost. These can't be expressed per-file because they describe relationships between file pairs.

### 2. Per-file docs require extra turns with no compensating benefit
- CLAUDE.md directives are always-visible, prompt-cached at 90% discount (zero extra turns)
- Per-file docs require the agent to: (a) know which file to check, (b) read the doc file, (c) process it. Each step costs a turn.
- The extra turns to read per-file docs cost more than the tokens saved by deduplication

### 3. Chicken-and-egg: agents need context to know what context to request
- Per-file docs are useful AFTER the agent knows which file it's working on
- But by that point, the agent has already read the source file and started editing
- The guidance in per-file docs (dependents, tests, co-change partners) is most useful BEFORE the agent starts, which is exactly when CLAUDE.md provides it

### 4. Repo pollution
- Writing `.md` files alongside source code clutters the user's repository
- Requires `.gitignore` entries or `.clarte/` directory convention
- Creates maintenance burden (stale docs if analysis isn't re-run)

## Possible Future Directions

- **MCP-based on-demand context**: Serve the same information via MCP tools instead of files. No repo pollution, query-driven, but requires MCP support and careful design to avoid extra turns. Clarte already had MCP tools (blast_radius, test_map, hidden_couplings, check_change) but they were consistently worse in benchmarks. Needs deep design work before re-implementing.
- **Progressive summarization**: Instead of offloading sections to per-file docs, compress them within CLAUDE.md. A 10-row table becomes top-3 + summary line. No extra files, no extra turns.
- **Instruction tuning**: Add a directive like "Always read a file's full content before editing it" to shift agent behavior without changing context structure. Worth an A/B test.
