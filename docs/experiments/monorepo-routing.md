# R.16: Monorepo Package Routing

## Status

Deprioritized (2026-03-07)

## Context

R.8 showed that clarte helps on monorepos but hurts on single-package projects. The mechanism was unclear. R.16 proposed building explicit package routing: use the dependency graph to identify which package(s) a task touches, then scope the agent's context to those packages only.

The hypothesis was that monorepo benefit comes from reducing the search space. Without routing, agents waste turns exploring irrelevant packages. With routing, they start in the right package immediately.

## Why Deprioritized

Subsumed by R.20 (BM25F edit-target retrieval). Graph-based edit target prediction handles the routing use case naturally:

1. **Implicit routing.** BM25F scores files across all packages using path tokens, export names and import expansion. The top-scoring targets point the agent to the correct package without explicit routing logic. Package boundaries are a human abstraction; the retrieval model does not need them.

2. **Finer granularity.** Package routing operates at the package level (e.g. "work in packages/auth"). Edit-target prediction operates at the file level (e.g. "edit packages/auth/src/session.ts"). File-level targets are strictly more informative.

3. **No special-casing.** Package routing requires detecting monorepo structure, identifying package boundaries and mapping tasks to packages. BM25F uses the same algorithm for monorepos and single-package projects. Less code, fewer failure modes.

## References

- R.8: Monorepo Benchmark (`memory/r8-monorepo-benchmark.md`)
- R.20: BM25 Edit-Target Retrieval (`memory/bm25-retrieval-research.md`)
