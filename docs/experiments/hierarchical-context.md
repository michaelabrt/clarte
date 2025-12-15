# Experiment: Hierarchical Context in Single File

**Branch:** N/A (research only, never implemented)
**Date:** 2026-03-01
**Verdict:** NO-GO (conceptual)

## Theory

CLAUDE.md has two zones within a single file:
1. **Brief header** (~1,500 tokens): What Is This, Tech Stack, Config Constraints, top 5 Working Guidelines, Key Files
2. **Extended appendix** (~3,500+ tokens): Full tables, all directives, code snapshot, dead files, etc.

Agents always see the header. They "scroll" to the appendix only when they need detailed information. This keeps the effective context small while making everything available in one file.

## Why It Was Never Implemented

### LLMs don't scroll

The fundamental premise is flawed. LLMs process the entire context window in a single forward pass. There is no mechanism for an agent to "see only the header" and then selectively process the appendix. The entire file is in the system prompt regardless of how it's structured.

Reordering sections (putting high-value content first) has no attention-weighting effect in modern transformer architectures. The model attends to all tokens equally during self-attention.

### Prior evidence: section reordering doesn't help

The context-optimization experiment (branch `experimental/no-go/context-optimization`) tested section reordering as one of three optimizations. Results:

| Variant | fix-order-tax Delta |
|---|---|
| Reorder only | -32% |
| Trim only | -26% |
| Voice only | -16% |
| **Combo (all three)** | **+63%** |

The reorder variant showed -32% in isolation, but this was confounded with the other changes in the combo. The key lesson from that experiment was that interaction effects are non-linear: optimizations that help alone can catastrophically combine.

More importantly, the -32% from reordering was measured at only 2 reps on a single task, which is insufficient to draw conclusions. At that sample size, natural variance in agent behavior could easily produce a 32% swing.

### No way to conditionally load parts of a single file

Unlike MCP tools (which are query-driven) or per-file docs (which are separate files), a single file offers no mechanism for conditional loading. The budget system already handles size constraints by compressing or dropping low-priority sections. A hierarchical layout within the file adds complexity without adding capability.

## Possible Future Directions

None. This approach is conceptually unsound for LLM-based agents. The problem it tries to solve (reducing effective context for large repos) is better addressed by:

- **Progressive summarization**: Compress sections within the budget, rather than hiding them behind a fold
- **MCP tools**: Actual on-demand loading via query interface, where the agent controls what it receives
- **Budget system improvements**: Smarter compression strategies per section type
