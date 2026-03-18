# On-demand Pre-flight Delivery

## Status

GO (2026-03-11)

## Context

R.20's pre-flight system loaded its agent file into every session. On detailed prompts where the agent already names the files to edit, this added per-turn overhead with no benefit. Needed a way to fire pre-flight only when it would help.

## Method

The prompt hook checks whether the prompt mentions file paths known to the dependency graph. If it does, the prompt is "detailed" - the agent already has a starting point. Steps skipped: no BM25F retrieval, no task-context.md, no agent copy to `.claude/agents/`. Zero overhead.

If no known paths are found, the prompt is "opaque" - full pre-flight fires: BM25F target resolution, task-context.md generation, agent installation.

AB benchmark on hono #4440 (URL fragment stripping), Sonnet, `claude -p`. Opaque condition uses n=8 (7 from the controlled AB + 1 from R.20 pilot). Detailed placebo uses n=10.

## Results

| Prompt type | Placebo | Pre-flight | Delta | n |
|---|---|---|---|---|
| Detailed | completed | completed | parity (no overhead) | 10 vs 1 |
| Opaque | completed, high variance | completed, 3x more consistent | faster, tighter | 8 vs 8 |

Opaque pre-flight sessions were 3x more consistent (spread 0.06 vs 0.16 on normalized session length). Pre-flight produces tighter, more predictable sessions.

Detailed pre-flight (n=1) is a warm-cache sanity check, not a controlled comparison. The point: pre-flight doesn't hurt when it shouldn't fire, and the mechanism correctly prevents it from firing.

## Insight

The overhead of context is per-turn, not per-session. Pre-flight adds ~500 tokens to the system prompt; over a 15-turn session that's 7,500 extra tokens to process per turn, increasing wall-clock time. Gating on prompt opacity eliminates this overhead exactly when it provides no benefit. The dependency graph serves double duty: routing (which files to edit) and gating (whether to route at all).
