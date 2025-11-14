# Context Selection Research Roadmap

> Techniques from information theory, network science, cognitive science, compression theory, cartography, and decision theory that could fundamentally change how Clarte selects and ranks what goes into the context file.
>
> **Core invariant**: Given a codebase of arbitrary size, produce the most useful compressed representation under a token budget. "Useful" means: maximally reduces the AI agent's uncertainty about what to do when it encounters a task.
>
> **Key reframe**: The current approach treats context generation as *describing the codebase*. But the actual objective is *maximally reducing agent decision uncertainty*. A perfect description might waste tokens on things the agent could infer, while missing things that are genuinely unpredictable. Every technique below follows from this distinction.

---

## Priority Levels

| Level | Meaning |
|-------|---------|
| **P0** | Implement first, highest expected impact, validates the research direction |
| **P1** | Implement second, strong theoretical basis, clear path to integration |
| **P2** | Worth exploring after P0/P1 show results |
| **P3** | Speculative but potentially transformative; park until core techniques prove out |

---

## Evaluation Strategy

> Before implementing anything, we need a lightweight way to detect genuine improvement. Not statistically significant benchmarks; just enough signal for GO/NO GO decisions after 1-2 runs.

### E.1 Quick Eval Protocol

**Effort**: ~2 hours. **Prerequisite for all P0/P1 items.**

Use the existing eval framework (§3.13, §3.61 in ROADMAP.md) as the foundation. Extend it with:

1. **Token efficiency metric**: For each eval fixture, measure `(actionable directives produced) / (tokens consumed)`. A technique that produces the same directives in fewer tokens, or more directives in the same tokens, wins.

2. **Counterfactual test**: For each candidate context element, run the eval with and without it. If removing it doesn't change which directives fire, the element is wasted tokens. Count wasted tokens per technique.

3. **A/B fixture comparison**: Generate context for the 2 existing benchmark fixtures (React fullstack 31 files, Python backend 25 files) using both the current pipeline and the experimental technique. Diff the outputs. Manually inspect: did the experimental version capture something important that the current version missed? Did it drop something important?

4. **GO/NO GO criteria**:
   - GO: Produces measurably better output (more actionable directives, fewer wasted tokens, or captures information the current pipeline misses) on at least 1 of 2 fixtures, without degrading the other.
   - NO GO: No measurable difference, or degrades output on either fixture.

---

## Dependency Graph

```
E.1 Quick Eval Protocol ──► all P0/P1 items (prerequisite)

R.1 Surprise-Based Selection ──► independent (new scoring signal)
R.2 Cartographic Typification ──► independent (new rendering strategy)
R.3 Information Bottleneck ──► R.1 (surprise scores feed task-aware weighting)
R.4 Stigmergic Context ──► independent (new content type: exploration guidance)

R.5 Renormalization ──► R.2 (multi-scale depends on typification working)
R.6 Value of Information ──► R.1 + R.3 (needs surprise + task model as inputs)
R.7 Observability ──► independent (new graph algorithm)
R.8 Compressive Sensing ──► R.2 + R.5 (needs sparse basis identification)
R.9 Holographic Principle ──► R.1 (interface-vs-implementation depends on surprise)
```

---

## P0 -- Implement First

### R.1 Surprise-Based Selection

**Source field**: Predictive coding (neuroscience), information theory.
**Effort**: ~4 hours. **Impact**: Could eliminate 30-50% of wasted tokens by not describing what the agent already knows.

**The idea**: Run a lightweight code model (or heuristic proxy) over each file/function. Measure its *surprisal*: how unexpected is this code given the agent's prior knowledge? High-surprise code needs more context tokens; low-surprise code (boilerplate, standard patterns) can be summarized or omitted.

**Why this is different from current scoring**: Current heuristics (import count, centrality, churn) measure *structural importance*. Surprise measures *informational importance from the agent's perspective*. A file imported by 50 others might be completely standard (low surprise, low context value), while an obscure config file with unusual conventions (high surprise) might be critical per token.

**Implementation approach** (no LLM calls, stays deterministic):
1. Use Clarte's existing convention inference as the baseline "model." Files that perfectly follow detected conventions get low surprise scores.
2. Measure deviation from conventions: unusual naming patterns, unexpected import structures, non-standard file organization.
3. Measure structural surprise: files whose role (per HITS) doesn't match their directory location, files with unexpected dependency patterns (high fan-in from unrelated modules).
4. Combine into a `surpriseScore` per file (0-1). Use it as a multiplier on the existing token budget allocation.

**What changes in the output**: Files that follow conventions perfectly get less space (or just a mention). Files that break conventions, have unusual structure, or behave unexpectedly get more detailed descriptions. The total token count stays the same; the allocation shifts toward genuinely informative content.

**Risk**: The heuristic proxy might not correlate well with actual agent confusion. Mitigate by validating against eval fixtures.

**GO/NO GO signal**: Generate context for both fixtures with and without surprise-based reweighting. If the reweighted version allocates more tokens to the files that the eval framework flags as important (hub files, chokepoints), it's a GO.

---

### R.2 Cartographic Typification

**Source field**: Cartographic generalization (map-making science).
**Effort**: ~3 hours. **Impact**: Could reduce token usage 20-40% for repetitive codebases without losing information.

**The idea**: When a codebase has many similar files (30 API route handlers, 15 React components following the same pattern, 20 test files with identical structure), describe the *pattern* once and list the instances, instead of describing each file individually.

**Cartographic operators applied to code**:
- **Typification**: Replace N similar files with "pattern + list of N instances." Token cost goes from O(N * per-file-cost) to O(1 * pattern-cost + N * name-cost).
- **Exaggeration**: Make small but critical files (configs, type definitions) more prominent than their size would suggest.
- **Amalgamation**: Merge clusters of tightly-coupled files into single described units ("the auth module: login.ts, session.ts, middleware.ts, types.ts").
- **Simplification**: Reduce detail on files that are well-described by their pattern membership.

**Implementation approach**:
1. After community detection and role classification, cluster files by (role, directory, detected pattern).
2. For each cluster with 3+ members: extract the shared pattern (common imports, similar export shapes, naming convention). Render as: "**Pattern**: [description]. **Files**: [list]."
3. For singleton or 2-member clusters: render normally (no typification benefit).
4. Apply exaggeration: files with high surprise scores (from R.1) or chokepoint status get rendered at full detail regardless of cluster membership.

**What changes in the output**: Instead of 30 individual file entries for route handlers, the context file says "30 Express route handlers in `src/routes/`, each exporting a single router with standard CRUD operations. Pattern: `import { Router } from 'express'; const router = Router(); export default router;`. Exceptions: `src/routes/auth.ts` (custom middleware chain), `src/routes/webhook.ts` (raw body parsing)." This saves tokens and is arguably *more* informative because it highlights the exceptions.

**Risk**: Pattern detection might be too coarse (grouping dissimilar files) or too fine (no groups detected). Mitigate by requiring 80%+ structural similarity within a cluster.

**GO/NO GO signal**: Run on both fixtures. If typification identifies at least one group of 3+ files and the resulting context is shorter without losing any directives from the eval framework, it's a GO.

---

### R.3 Information Bottleneck (Task-Aware Weighting)

**Source field**: Information theory (Tishby et al., 1999).
**Effort**: ~3 hours. **Impact**: Shifts token allocation from "uniformly describe everything" to "focus on what the agent will actually need."

**The idea**: The optimal context is not the one that best describes the codebase, but the one that preserves maximal information about the *tasks the agent will perform*. This means you need a model of the task distribution, and you optimize context to be informative about likely tasks.

**Why this is different**: Current scoring treats all parts of the codebase as equally likely to be relevant. But in practice, 80% of tasks touch 20% of the codebase. A web app where most work happens in the API layer needs different context emphasis than one where most work is in the UI layer.

**Implementation approach** (using signals already available):
1. **Task distribution proxy**: Use git history to estimate where future work will happen. Files with recent churn, many recent commits, and open-branch activity are more likely to be the subject of future tasks. Weight by recency (exponential decay).
2. **Relevance propagation**: For each high-probability task file, propagate relevance to its 1-hop and 2-hop dependency neighbors (the files the agent would need to understand to work on the task file). Use the existing `computeNeighborhood()` from diff-aware mode.
3. **Budget reallocation**: Multiply each file's token budget by its task-relevance score. Files in the "hot zone" (likely task targets + their neighborhoods) get more tokens. Files in cold zones get compressed to minimal mentions.

**What changes in the output**: The context file is no longer a uniform description of the whole codebase. It's a weighted description that goes deep on the areas where work is likely and stays shallow elsewhere. For a project where recent work is all in `src/api/`, the API layer gets detailed directives while `src/ui/` gets a one-line summary.

**Interaction with R.1**: Surprise scores (R.1) tell you *what's hard to predict*. Task-relevance (R.3) tells you *what's likely to matter*. The ideal budget allocation is: `tokens(file) = surprise(file) * relevance(file) * base_importance(file)`. High surprise + high relevance = maximum tokens. Low surprise + low relevance = omit entirely.

**Risk**: Git history might not predict future tasks well (e.g., after a major pivot). Mitigate by keeping a minimum floor for all files (no file gets zero tokens; at worst it appears in a typified group from R.2).

**GO/NO GO signal**: Generate context for both fixtures. Check whether the task-weighted version allocates more tokens to the files that the eval fixtures flag as important hub files and chokepoints in the "active" areas of the codebase. If the weighted version would have helped an agent working on a recent change (simulate by checking against the most recent commits), it's a GO.

---

### R.4 Stigmergic Context (Exploration Guidance)

**Source field**: Collective intelligence, ant colony optimization.
**Effort**: ~2 hours. **Impact**: Could dramatically improve token efficiency by telling agents *where to look* instead of *what's there*.

**The idea**: Instead of describing code in the context file (declarative knowledge), provide exploration guidance (procedural knowledge). The agent doesn't need the content of `cache.ts` in its context; it needs to know "when working on performance, read `cache.ts:L200-L250` for the invalidation logic before making changes."

**Why this is different**: Current context is entirely declarative: "this file has 20 exports, is imported by 15 files, and has high instability." Stigmergic context is procedural: "when you encounter X, do Y." The agent uses procedural hints as triggers during its exploration, not as upfront knowledge. This is dramatically cheaper in tokens because you encode *pointers* instead of *content*.

**Current partial implementation**: The Working Guidelines section already does this ("When modifying X, also check Y"). This technique would extend the principle to more context categories.

**Implementation approach**:
1. Convert the Code Snapshot section from "here are the exports of important files" to "here are the files worth reading when working in each area, with specific line ranges for non-obvious behavior."
2. Convert the Key Files table from "here's metadata about important files" to "here's when and why you'd need each file."
3. Add conditional guidance: "If you're adding a new [template/route/model], follow the pattern in [example file]." This is richer than convention inference because it points to a concrete exemplar.
4. Keep declarative content only for things the agent truly cannot discover (architectural constraints, hidden coupling, conventions that aren't obvious from any single file).

**What changes in the output**: The context file reads more like a guide ("when you need to..., look at...") and less like a reference ("this file contains..."). Token cost per directive drops because pointers are shorter than descriptions.

**Risk**: Agents might not follow procedural guidance as reliably as they use declarative context. Mitigate by keeping critical declarative sections (chokepoints, conventions) and only converting supplementary sections.

**GO/NO GO signal**: Convert the Code Snapshot section for both fixtures to stigmergic format. Compare token counts. If the stigmergic version uses 30%+ fewer tokens for the same files, and a manual review confirms the guidance is actionable, it's a GO.

---

## P1 -- Implement Second

### R.5 Renormalization (Multi-Scale Description)

**Source field**: Statistical physics (Wilson, 1971).
**Effort**: ~4 hours. **Impact**: Principled alternative to flat scoring. Each scale level is internally consistent.

**The idea**: Build a hierarchy of descriptions at different resolutions. At the coarsest level, describe the architecture (4-5 subsystems and how they connect). At the next level, describe each subsystem's key files and internal structure. At the finest level, describe critical implementation details. The token budget determines how deep you go, and at each scale you preserve exactly the coupling structure that matters at that scale.

**Why this is different from current approach**: Current scoring is flat: every file gets a score, top N files get into the context. This can produce incoherent results (detailed description of file A without mentioning file B, even though A is meaningless without B). Renormalization guarantees that each level of description is self-contained and coherent.

**Implementation approach**:
1. Use community detection to identify top-level subsystems.
2. For each subsystem, identify its key interface files (highest authority) and internal structure files.
3. Build 3 description tiers:
   - **Macro** (~200 tokens): Subsystem names, responsibilities, and inter-subsystem dependencies.
   - **Meso** (~500 tokens per subsystem): Key files, roles, internal coupling patterns.
   - **Micro** (remaining budget): Specific function signatures, gotchas, implementation details for the highest-priority files.
4. Fill tiers in order until budget is exhausted. Each tier is complete before the next starts.

**Depends on**: R.2 (typification is needed to compress the meso/micro tiers efficiently).

**GO/NO GO signal**: Generate both flat (current) and hierarchical context for the fixtures. If the hierarchical version produces a more coherent "mental model" of the codebase (subjective but assessable: does it read like a progressively detailed guide vs. a flat list of facts?), and the eval directives are preserved, it's a GO.

---

### R.6 Value of Information (Decision-Theoretic Selection)

**Source field**: Decision theory, submodular optimization.
**Effort**: ~5 hours. **Impact**: Theoretically optimal context selection with provable approximation guarantees.

**The idea**: For each candidate context element, estimate the expected improvement in agent decision quality if included. This turns context selection into a submodular optimization problem: greedily select elements that maximize expected value per token. The greedy algorithm is guaranteed to achieve within (1 - 1/e) ~63% of optimal.

**Why this is different**: Current scoring is a proxy for importance. VoI directly models the *counterfactual*: what happens if this information is absent? A high-centrality file that the agent would discover through tool use anyway has low VoI. An obscure gotcha the agent would never find has high VoI.

**Implementation approach**:
1. For each candidate context element, estimate:
   - `P(agent_mistake | without_this_info)`: Based on file complexity, surprise score, hidden coupling count.
   - `P(agent_mistake | with_this_info)`: Assumed to be significantly lower for high-surprise, high-coupling items.
   - `cost_of_mistake`: Proportional to downstream dependents (a mistake in a foundation file is costlier than in a leaf).
   - `token_cost`: Measured directly.
2. Compute `VoI = (P_without - P_with) * cost_of_mistake`.
3. Greedily select elements by `VoI / token_cost` until budget is exhausted.
4. The submodularity property (adding info has diminishing returns when you already know a lot) means the greedy algorithm has provable guarantees.

**Depends on**: R.1 (surprise scores) and R.3 (task-relevance model) as inputs to the VoI estimation.

**Risk**: The probability estimates are necessarily crude. But even crude VoI estimates should outperform heuristic scoring because they model the right thing (agent decision quality) rather than a proxy (structural importance).

**GO/NO GO signal**: Compare VoI-selected context against current heuristic-selected context for both fixtures. If VoI selects a meaningfully different set of files (not just a reordering), and manual inspection confirms the VoI selections are more actionable, it's a GO.

---

### R.7 Observability-Based Selection

**Source field**: Control theory (Kalman, 1960).
**Effort**: ~4 hours. **Impact**: Principled minimal set of files that lets the agent reconstruct the full system.

**The idea**: A system is *observable* if you can reconstruct its full internal state from a set of outputs. Applied to code: what is the minimal set of code elements that, if understood, lets the agent infer the behavior of the entire system?

**Why this is different from centrality**: A file might be highly central (many imports) but redundant for observability (its behavior is fully determined by its callers and callees, which are already in context). Conversely, a peripheral file might be critical for observability if it defines behavior that can't be inferred from anything else.

**Implementation approach**:
1. Model the codebase as a directed graph (already available).
2. Compute structural observability: find the minimum set of nodes from which all other nodes are reachable via directed paths. This is the minimum dominating set problem (NP-hard in general, but good greedy approximations exist for sparse graphs like import graphs).
3. Augment with information-theoretic observability: among reachable nodes, which ones carry information that can't be inferred from the dominating set? Use surprise scores (R.1) to identify these.
4. The union of structurally-dominating and informationally-unique files is the minimum observable set.

**What changes**: Instead of "top N files by score," the context contains "the minimal set of files from which you can understand the whole system." This is a cleaner conceptual model and might produce a very different (and smaller) file set.

**GO/NO GO signal**: Compute the minimum observable set for both fixtures. If it's meaningfully smaller than the current "top N by HITS authority" set, and manual inspection confirms the observable set is sufficient to understand the architecture, it's a GO.

---

## P2 -- Explore After P0/P1

### R.8 Compressive Sensing (Sparse Basis Identification)

**Source field**: Compressed sensing (Candes, Romberg, Tao, 2006; Donoho, 2006).
**Effort**: ~6 hours. **Impact**: Theoretical framework for minimal-sample reconstruction of codebase structure.

**The idea**: If a signal is sparse in some basis, you can reconstruct it from far fewer samples than Shannon's theorem requires. Codebases are extremely sparse: most files don't interact with most other files. The question is: what basis makes the codebase maximally sparse? In that basis, you need the fewest tokens to reconstruct the essential structure.

**Candidates for the sparse basis**:
- Module decomposition (community detection): Each community is one basis vector.
- Abstraction layers: Types, then interfaces, then implementations.
- Factored representation: Shared patterns are factors; files are combinations of factors.

**Connection to R.2 and R.5**: Typification (R.2) finds repeated patterns (factors). Renormalization (R.5) finds hierarchical structure (multi-scale basis). Compressive sensing provides the theoretical framework for why these work: they identify the sparse basis in which the codebase can be described with minimal information.

**Implementation would mean**: Instead of describing files individually, describe the *basis* (patterns, layers, module interfaces) and then describe each file as a deviation from its expected basis representation. Files that are perfectly predicted by their basis membership need zero additional tokens. Files that deviate need tokens proportional to their deviation.

**This is the theoretical ceiling**: If fully realized, this approach gives the information-theoretically minimal context file. Everything else is an approximation of this.

---

### R.9 Holographic Principle (Interface-First Description)

**Source field**: Theoretical physics (boundary/bulk correspondence).
**Effort**: ~3 hours. **Impact**: Aggressive token reduction by describing modules via interfaces rather than implementations.

**The idea**: In physics, the information content of a 3D volume is bounded by its 2D surface area. Applied to code: the useful information about a module might be fully captured by its interface (types, function signatures, documented contracts), not its implementation.

**Rule**: For each module, start with just the interface. Only add implementation details when:
- The implementation is surprising (high surprise score from R.1).
- The interface is leaky (callers depend on implementation details, detectable via tight coupling analysis).
- The implementation contains gotchas not visible from the interface (hidden coupling, non-obvious side effects).

**This is more aggressive than current snapshot extraction**: Current snapshots include function signatures for all "important" files. The holographic approach would include signatures only when the implementation is non-trivial. For standard CRUD functions, even the signature is unnecessary if the naming convention is clear.

**Interaction with R.4**: Stigmergic context (R.4) says "point to the file instead of describing it." The holographic principle says "when you do describe it, describe the interface, not the implementation." Together: point to the file, and if the agent needs to understand it before reading, give it the interface.

---

## P3 -- Speculative

### R.10 Active Learning Selection

**Source field**: Machine learning (active learning, Bayesian experimental design).

Which pieces of information, if known, would most reduce the agent's uncertainty about the codebase? Iteratively select the most informative pieces. This is the online version of R.6 (VoI): instead of batch-selecting all context upfront, adaptively select the next most informative element given what's already selected.

**Why P3**: Requires a model of agent uncertainty, which is hard to build without LLM-in-the-loop evaluation. Park until the simpler approaches (R.1, R.3, R.6) establish whether modeling agent uncertainty is tractable.

### R.11 Perceptual Lossy Compression

**Source field**: Signal processing (perceptual coding, as in JPEG/MP3).

JPEG works because it knows what humans can't perceive. What can't an AI agent perceive/use in code context? Empirically measure which context elements actually affect agent outputs. Elements that never change agent behavior (even when present) are "imperceptible" and should be dropped.

**Why P3**: Requires empirical measurement of agent sensitivity to context changes. This is essentially an LLM eval at scale. Park until the eval framework (E.1) is mature enough to run hundreds of A/B comparisons.

### R.12 Minimax Regret Selection

**Source field**: Decision theory (robust optimization).

Instead of optimizing for the average task (R.3), optimize for the worst case: choose context that minimizes maximum regret across all possible tasks. This ensures the context works reasonably well even for unexpected tasks, at the cost of being less optimized for likely tasks.

**Why P3**: Only matters if R.3 (task-aware weighting) shows that optimizing for likely tasks degrades performance on unlikely tasks. If R.3 works well across the board, minimax regret is unnecessary.

---

## Interaction Map

How these techniques compose and reinforce each other:

| Technique | Provides | Consumed By |
|-----------|----------|-------------|
| R.1 Surprise | Per-file surprise scores | R.3 (weighting), R.6 (VoI input), R.7 (observability augmentation), R.9 (implementation threshold) |
| R.2 Typification | Pattern clusters, token savings | R.5 (tier compression), R.8 (basis identification) |
| R.3 Info Bottleneck | Task-relevance scores | R.6 (VoI input), R.1 (surprise * relevance product) |
| R.4 Stigmergy | Procedural guidance format | R.9 (pointer format for non-interface content) |
| R.5 Renormalization | Multi-scale tiers | R.8 (hierarchical basis) |
| R.6 VoI | Optimal selection ordering | Final token budget allocation |
| R.7 Observability | Minimum sufficient file set | R.6 (candidate pruning) |

**The composed pipeline** (if everything works):
1. Compute surprise scores (R.1) and task-relevance (R.3) for every file.
2. Cluster similar files into typified groups (R.2).
3. Build multi-scale description hierarchy (R.5).
4. Compute minimum observable set (R.7) to prune candidates.
5. Select final context via VoI optimization (R.6).
6. Render using stigmergic format (R.4) with holographic interface descriptions (R.9).

**But start simple**: R.1 + R.2 alone could significantly improve output. Each subsequent technique adds refinement, not a prerequisite.

---

## Weakness Tracking

| Weakness | Mitigated By |
|----------|-------------|
| No model of what agents actually need | R.1 (surprise as proxy), R.3 (task distribution), R.6 (VoI) |
| Uniform description wastes tokens on predictable code | R.1 (surprise-based allocation), R.2 (typification) |
| Flat scoring produces incoherent descriptions | R.5 (multi-scale), R.7 (observability-based set) |
| Declarative context is token-expensive | R.4 (stigmergic pointers), R.9 (interface-only) |
| No principled budget allocation | R.6 (submodular VoI optimization), R.8 (sparse basis theory) |
| Current heuristics can't distinguish "important" from "informative" | R.1 (surprise separates these), R.6 (VoI models the counterfactual) |
| One-size-fits-all context regardless of likely tasks | R.3 (task-aware weighting), R.12 (minimax for robustness) |

---

## Implementation Notes

### Integration Points

All techniques produce *scoring signals* or *rendering strategies* that plug into the existing pipeline:

- **Scoring signals** (R.1, R.3, R.6, R.7): New per-file scores that multiply or replace the existing HITS-based ranking. These plug into `applyBudget()` in `src/snapshot.ts` and the section prioritization in `src/templates/main-context.ts`.

- **Rendering strategies** (R.2, R.4, R.5, R.9): New ways to render context for files/modules. These modify the template renderers in `src/templates/`. The data pipeline stays the same; only the output format changes.

### No LLM Calls

All techniques use deterministic heuristic proxies. R.1 uses convention deviation as a proxy for surprise. R.3 uses git history as a proxy for task distribution. R.6 uses graph metrics as proxies for mistake probability. The pipeline remains fast, free, and reproducible.

### Incremental Adoption

Each technique can be implemented and evaluated independently. R.1 is a new score added to the existing pipeline. R.2 is a new rendering pass added after the existing pipeline. Neither requires changing existing algorithms. This means we can validate each technique against the current baseline without risk.

### Key Files Affected

| Technique | Primary Files | Test Coverage |
|-----------|--------------|---------------|
| R.1 | `src/graph.ts` (new scoring), `src/conventions.ts` (deviation measurement) | Extend `eval/benchmark.test.ts` |
| R.2 | `src/templates/main-context.ts` (typified rendering), `src/graph.ts` (cluster detection) | New `typification.test.ts` |
| R.3 | `src/git-analysis.ts` (task distribution), `src/templates/main-context.ts` (budget reallocation) | Extend `eval/benchmark.test.ts` |
| R.4 | `src/templates/main-context.ts` (stigmergic format), `src/snapshot.ts` (pointer generation) | Extend `golden/golden.test.ts` |
| E.1 | `src/__tests__/eval/` (new metrics) | Self-testing |
