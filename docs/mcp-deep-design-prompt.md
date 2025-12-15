# MCP Deep Design Prompt

Use this prompt in a fresh Claude session to design the MCP tool architecture for clarte.

---

## Prompt

I'm working on **clarte**, an architecture intelligence engine for AI coding agents. It analyzes codebases and generates context files (`.claude/rules/clarte.md`) that help agents understand project structure, conventions, coupling, test coverage, etc.

### The scaling problem

For large repos (50k+ LOC), the context file exceeds the token budget (~5,000 tokens) and sections get dropped. We need agents to access detailed architectural context **on demand** without bloating the static context file.

### MCP as the solution

We want to add MCP (Model Context Protocol) tools that let agents query clarte's analysis graph for specific information. The static context file provides orientation; MCP tools provide on-demand detail.

### What already exists

**Analysis graph** (`.clarte/graph.json`): Serialized snapshot containing:
- FileNode records: role (Orchestrator/Foundation/Utility), authority, hubScore, betweenness, instability, importedByCount, importsCount, hasTests, testFiles, isChokepoint, separatesComponents, isCrossCutting, layerSpread, layers
- Import/importedBy adjacency lists
- Chokepoints, cross-cutting files, tight couplings, change couplings, structural mismatches
- Test mapping (source file -> test files)
- Layer violations and circular deps
- Change impact predictions

**Previous MCP tools** (implemented twice, consistently underperformed in benchmarks):
1. `clarte_blast_radius` - dependency impact for a file
2. `clarte_test_map` - prioritized test files for changes
3. `clarte_hidden_couplings` - non-obvious coupling detection
4. `clarte_check_change` - validate adding a new import

**Why previous attempts failed** (both times):
- Each MCP tool call costs a full agent turn (re-sends entire conversation, ~50-100k tokens)
- Agents didn't know WHEN to call the tools (chicken-and-egg: need context to know what context to request)
- Tool responses were verbose, adding noise to the conversation
- The information was already available in the static context file, so MCP tools were redundant turns
- No benchmark framework support for testing MCP interactions

### Constraints from our experiments

These are hard-won lessons. Do not violate them:

1. **Turn count is the real cost driver, not context size.** The static context file is prompt-cached (90% discount). Each extra agent turn re-sends full history (~50-100k tokens). A 10-turn task costs ~500k-1M input tokens; the context file is <1% after caching. Never add turns to save context tokens.

2. **Never remove information from the static context to "push" it to MCP.** The per-file-docs experiment proved this: deduplicating sections from the context file to avoid redundancy with MCP lost cross-file relationships and caused agents to spend extra turns without compensating benefit.

3. **Interaction effects are non-linear.** Optimizations that test fine individually can catastrophically combine. Always test combinations.

4. **Context causes convention-following behavior.** Agents with architectural context modify existing code patterns rather than following task prompts literally. This is generally desirable but means MCP responses must not add conflicting architectural signals.

5. **Agents with context use edit() exclusively; without context they mix edit() and write().** This is a structural property of having ANY architectural context, not specific to any section.

### What the MCP tools need to solve

The ONLY valid use case for MCP tools is providing information that:
- (a) Would NOT fit in the static context file at the current budget, AND
- (b) Is specifically needed for the current task, AND
- (c) Cannot be discovered by the agent reading source files (or would cost more turns to discover)

### Your task

Design a comprehensive MCP tool architecture for clarte. For each proposed tool:

1. **Name and purpose** - what it does, in one sentence
2. **When an agent would call it** - the specific scenario where this saves turns vs. not having it
3. **Input parameters** - what the agent provides
4. **Output format** - what comes back (keep it concise; verbose responses waste tokens)
5. **Why it can't be in the static context** - what makes this on-demand rather than static
6. **Turn-cost analysis** - honest assessment of whether this saves more turns than it costs
7. **Risk of regression** - can this tool cause worse behavior? How?

Also design:
- **Discovery mechanism**: How does the agent know these tools exist and when to use them? (The static context file should hint at available tools without being redundant.)
- **Response format conventions**: How to keep MCP responses concise enough to not bloat the conversation.
- **Benchmarking strategy**: How to test MCP tools given that the current benchmark framework doesn't support MCP. Propose a concrete approach.
- **Staleness handling**: The analysis graph can go stale. How do tools handle this?

### What NOT to propose

- Tools that duplicate information already in the static context file
- Tools that require multiple sequential calls (multi-turn MCP workflows)
- Tools that return large tables or verbose output
- Replacing the static context file with MCP (the static file must remain the primary delivery mechanism)

### Output format

Write a detailed design document with:
1. Tool inventory (each tool with the 7-point analysis above)
2. Discovery mechanism design
3. Response format spec
4. Benchmarking strategy
5. Implementation plan (files to create/modify, dependencies, phasing)
6. Risk analysis (what could go wrong, mitigations)

Be adversarial with yourself. For each tool, argue against it. Only include tools that survive the argument.
