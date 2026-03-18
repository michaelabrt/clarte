# Research: What Changes Agent Behavior

We ran 30+ experiments across 700+ agent sessions to find what actually makes AI coding agents faster, more correct and more precise. The goal: measure what helps, what hurts and why.

**TL;DR**: Most approaches to injecting static analysis into agent context either do nothing or actively hurt. Content doesn't matter nearly as much as behavior. The breakthrough came from using the dependency graph to predict edit targets and inject them as confidence signals, cutting the agent's exploration phase. This approach (pre-flight) won on all tested tasks - completing tasks agents couldn't finish alone, reaching the correct file in 2 minutes instead of 14, and reducing turns by up to 66%.

## Background

Clarté generates rich context files from static analysis: key files, chokepoints, coupling patterns, architectural layers, code snapshots. In controlled fixture benchmarks ([clarte-benchmark](https://github.com/michaelabrt/clarte-benchmark)), this context cut wall-clock time by 25%, turns by 28% and context processing by 60% (all p<0.001). But fixture benchmarks are synthetic. Would it hold on real-world bug fixes?

## Phase 1: Does the content matter?

We started by asking which sections of the generated context actually help. The answer was surprising: almost none of them.

### Content injection experiments (0/9 survived)

We tried adding, removing and reorganizing context sections in many configurations:

| Experiment | Idea | Result |
|---|---|---|
| [Surprise Scoring](experiments/surprise-scoring.md) | Boost structurally anomalous files | -50% in LLM eval |
| [Content Dedup](experiments/content-dedup.md) | Remove duplicate info across sections | -5% aggregate delta |
| [Instability Feedback](experiments/instability-feedback.md) | Add Robert Martin I-metric warnings | +0% in E.3, high variance |
| [Facade Map](experiments/facade-map.md) | Expose barrel file re-export mappings | Noise, no benefit |
| [API Surface](experiments/api-surface.md) | Pre-compute function signatures for hubs | -3/4 tasks regressed |
| [Per-File Docs](experiments/per-file-docs.md) | Per-file context instead of one file | Lost cross-file relationships |
| [Hierarchical Context](experiments/hierarchical-context.md) | Attention-weighted section ordering | LLMs process full context in one pass |
| [Typification](experiments/typification.md) | Type-aware section grouping | +0% in E.3 |
| [Task Relevance](experiments/task-relevance.md) | Weight sections by task type | +0% in E.3 |

**Key finding**: E.2 isolated evals (temp=0, single feature) consistently gave false positives. Features showing +6-13% improvement in isolation failed at temp=0.3 with real variance. This taught us to never trust isolated evals.

### Presentation and optimization experiments (0/4 survived)

We tried reformatting the same content in different ways:

| Experiment | Idea | Result |
|---|---|---|
| [Context Optimization](experiments/context-optimization.md) | Consolidate directives, trim sections, rewrite voice | Each helped alone; combined = +63% overhead |
| [Negative Framing](experiments/negative-framing.md) | Constraint language ("NEVER do X") | No benefit vs positive guidance |
| [Five Dimensions (R.7)](experiments/r7-five-dimensions.md) | Culture, checklist, memory, hooks, cochange | All five hurt or did nothing |
| [Variant Benchmark (R.9)](experiments/r9-variant-benchmark.md) | Reorder, compress, ultra-minimal, hooks | No variant beats placebo |

**Key finding**: Interaction effects are non-linear. Three optimizations that each helped individually (-26%, -16%, -32%) combined to +63% overhead. Always test combinations.

### Graph correctness fixes (3/3 survived)

The only changes that passed the E.3 combinatorial benchmark were fixes to the underlying graph algorithms:

| Experiment | Idea | Result |
|---|---|---|
| [Directed Betweenness](experiments/directed-betweenness.md) | Fix undirected phantom paths | +40% value on drizzle-orm |
| [Chokepoints BFS](experiments/chokepoints-bfs.md) | Directed BFS with adaptive threshold | Better wording, fewer false positives |
| [Go/Rust/Java Imports](experiments/import-resolution-go-rust-java.md) | Language-specific import resolution | +41.7% in E.3 |

**Key finding**: Making the graph more accurate helps. Adding more content on top of an accurate graph does not.

## Phase 2: Does the delivery mechanism matter?

If content doesn't help, maybe we're delivering it wrong.

### Delivery experiments (0/4 survived)

| Experiment | Idea | Result |
|---|---|---|
| [Delivery Mechanism (R.4)](experiments/delivery-mechanism.md) | Read-executor, prompt injection, MCP | Read-executor hurts; prompt is best |
| [MCP Tools](experiments/mcp-tools.md) | On-demand graph queries via MCP | 0% voluntary adoption |
| [Hook Context Injection (R.12, R.13b)](experiments/hook-context-injection.md) | PostToolUse additionalContext, updatedInput | Claude Code silently ignores both |
| [Stigmergic Context](experiments/stigmergic-context.md) | Adaptive context via hook signals | Passed E.2, failed E.3 |

**Key finding**: Only `permissionDecision: "deny"` works in Claude Code hooks. All context injection mechanisms (additionalContext, updatedInput) are dead code as of Claude Code 2.1.71. The hook test also revealed that any injected context adds processing overhead; agents don't shortcut, they process. See [Hook Context Injection](experiments/hook-context-injection.md) for the full mechanism audit.

## Phase 3: Understanding the real problem

After 18 experiments with 0 content wins, we stepped back and measured what actually happens during agent sessions.

### Real-world benchmarks

| Experiment | Finding |
|---|---|
| [Content vs Wrapper (R.5)](experiments/content-vs-wrapper.md) | Placebo beats full context on detailed tasks. The system prompt wrapper matters more than content. |
| [Real-World Benchmark (R.6)](experiments/r6-real-world-benchmark.md) | Placebo wins turns across all models. "Do not use Grep or Glob" cuts token processing by 40%. Both findings superseded by R.20 pre-flight. |
| [Monorepo vs Single (R.8)](experiments/monorepo-vs-single.md) | Context-file Clarté helps on monorepos (-29% turns), hurts on single-package (+24% turns). Superseded by R.20 pre-flight, which wins on both. |

### Agent behavior analysis

| Experiment | Finding |
|---|---|
| [Failure Patterns (R.11)](studies/failure-patterns.md) | 170 sessions, 7595 turns. 59% exploration, 28% edit, 13% tail. Test output parsing loops are 75% of tail waste. |
| [Quality Measurement (R.10)](studies/quality-measurement.md) | Code patches identical across conditions. No quality signal on simple bug fixes. |
| [Evolving Context (Gate A/B)](studies/evolving-context.md) | 100% of missed files are already in CLAUDE.md. Utilization problem, not coverage. |

### The first-edit timing breakthrough (R.18)

The [research synthesis](studies/research-synthesis.md) analyzed 426 passing sessions (4775 turns) across all conditions and found a strong predictor: **first-edit turn predicts total session length at r=0.70-1.00**. Every delayed first-edit turn adds ~1.3 total turns.

With context, agents start editing at turn 5.0. Without context, turn 7.8. The mechanism isn't knowledge (agents find the right files anyway); it's confidence to stop reading and start editing.

This reframed the entire problem. The question isn't "what should the agent know?" but "how do we make the agent start editing sooner?"

## Phase 4: Behavioral steering

Armed with the first-edit insight, we pivoted from information injection to confidence injection.

### Approaches tested

| Experiment | Idea | Result |
|---|---|---|
| [Skill Primitives (R.19)](experiments/skill-primitives.md) | Generated scripts + imperative CLAUDE.md directives | "Always use X" works; "To verify, run X" is ignored |
| [Stop Hook (R.14)](experiments/stop-hook.md) | Block repeated test commands without edits | NO-GO: addressable surface too small (16% of sessions) |
| [Test Reporter (R.13)](experiments/test-reporter.md) | Pre-configure test reporter to reduce output | Killed: root cause is compulsion, not truncation |
| [Haiku Localization (G1)](experiments/gate1-haiku-localization.md) | LLM-based file localization | NO-GO: agent self-localizes 86-100% on 2/3 repos |

Three more were deprioritized as subsumed:

| Experiment | Subsumed by |
|---|---|
| [Plan Template (R.15)](experiments/plan-template.md) | Not applicable to real-world use |
| [Monorepo Routing (R.16)](experiments/monorepo-routing.md) | R.20 graph-based edit target prediction |
| [Exploration Nudge (R.17)](experiments/exploration-nudge.md) | R.20 confidence injection |

### The pre-flight breakthrough (R.20)

The [BM25F retrieval](experiments/bm25-retrieval.md) experiment combined all insights into one system:

1. **BM25F scoring** on file paths + function/method names from the dependency graph, with per-field normalization and test-file proxy scoring
2. **Task-context file** listing predicted edit targets with key symbols per file
3. **Generated CLAUDE.md** with imperative directives ("Always use .clarte/scripts/check-tests.sh")

Tested on 4 real-world bug fixes (3 Hono single-package, 1 TypeORM monorepo), opaque prompts. The URL fragment and TypeORM rows pool pilots with later controlled ABs:

| Task | Placebo | Pre-flight | Delta | n |
|---|---|---|---|---|
| Hono: URL fragment (opaque) | completed, high variance | completed, 3x more consistent | faster, tighter | 8+8 |
| Hono: URL fragment (detailed) | completed | completed | parity | 10+1 |
| Hono: JSX async context | wrong file, DNF | correct file, 2 min to first edit | pre-flight only | 2+2 |
| Hono: form validator | DNF | completed (18 turns) | pre-flight only | 1+1 |
| TypeORM: SQLite simple-enum array | 47.7 turns | 16.3 turns | **-66% turns** | 3+3 |

Pre-flight finished all 4 opaque tasks. Placebo finished 2 of 4 (and was slower on both). The JSX context loss task was re-run as a controlled AB: placebo edited the wrong file (`src/jsx/base.ts`) and did not finish; pre-flight predicted the correct file (`src/jsx/context.ts`) and completed in 2 minutes. On hono-url (n=8), pre-flight sessions were 3x more consistent. On TypeORM (n=3), the gap was -66% turns. This is the first approach to beat placebo on single-package repos.

**First-edit timing** (JSX async context AB, $1.50 budget, n=1+1):

| Metric | Placebo | Pre-flight |
|---|---|---|
| First edit | ~14 min | ~2 min |
| File edited | `src/jsx/base.ts` (wrong) | `src/jsx/context.ts` (correct) |
| Outcome | hit budget cap | completed |

Pre-flight's target prediction (`task-context.md`) listed `src/jsx/context.ts` as the top edit target. The agent applied the pre-flight findings and edited the correct file within 2 minutes, skipping exploration entirely. Placebo spent 14 minutes in extended thinking before editing a different file, then did not finish. This is consistent with R.18: each delayed first-edit turn adds ~1.3 total turns, and here the 12-minute gap translated directly into a DNF.

## Phase 5: On-demand delivery

The pre-flight system from R.20 loaded its agent file into every session's system prompt. On detailed prompts where the agent already knows which files to edit, this added per-turn overhead with no benefit. Full write-up: [on-demand delivery](experiments/on-demand-delivery.md).

### On-demand agent mechanism

The prompt hook checks whether the prompt mentions known file paths from the dependency graph. If it does: no task-context.md, no agent copy, zero overhead.

**AB benchmark (hono #4440, URL fragment stripping, Sonnet)**:

| Prompt type | Placebo | Pre-flight | Delta | n |
|---|---|---|---|---|
| Detailed | parity | parity | no overhead | 10 vs 1 |
| Opaque | completed, high variance | **completed, 3x more consistent** | faster | 8 vs 8 |

Opaque pre-flight sessions were 3x more consistent than placebo (spread 0.06 vs 0.16 on normalized session length).

## What we learned

1. **Content injection doesn't work.** 15 experiments, 0 wins. Adding more information adds processing overhead without reducing exploration or improving correctness.

2. **The wrapper matters more than content.** A one-line placebo in a `CLAUDE.md` file performs comparably to 2000 tokens of structural analysis (R.5). The file's existence suppresses the discovery phase.

3. **Isolated evals are unreliable.** Features showing +6-13% at temp=0 consistently failed at temp=0.3. Combinatorial benchmarks at realistic temperature are the real gate.

4. **Monorepo vs single-package was the key split** for context-file Clarté. Agents self-localize fine in single-package repos (R.8). Pre-flight targeting (R.20) resolved this by predicting the correct file regardless of project structure.

5. **First-edit timing is the mechanism.** Each delayed first-edit turn adds ~1.3 total turns of wall-clock time (R.18). Context doesn't help agents know more; it helps them reach the correct file sooner.

6. **Confidence injection beats information injection.** "Edit src/foo.ts. Start now." produces correct edits faster than "this file has 49 importers and is a structural chokepoint" (R.20). The agent that received the target prediction edited the correct file in 2 minutes; the agent without it spent 14 minutes, chose the wrong file and did not finish.

7. **Imperative phrasing is obeyed; soft phrasing is ignored.** "Always use X instead of Y" works. "To verify tests, run X" does not (R.19).

8. **Hook mechanisms are limited.** Only `permissionDecision: "deny"` works in Claude Code. All other hook outputs (additionalContext, updatedInput) are silently ignored (R.12, R.13b, R.19).

9. **On-demand delivery eliminates detailed-prompt overhead.** Pre-flight adds zero overhead when the agent already knows where to edit. The prompt hook gates agent installation on prompt opacity.

## Experiment index

All experiment write-ups are in [`docs/experiments/`](experiments/). Observational studies, meta-analyses and design docs are in [`docs/studies/`](studies/). The [research pipeline](../memory/) in project memory has raw data and intermediate findings.
