# Evaluation Suite

Evals measure retrieval quality (MRR) against real-world and synthetic ground truth. They are excluded from the default test run and gated behind an environment variable.

## Running evals

```bash
REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/evals/
```

Or run a single eval:

```bash
REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/evals/hono-retrieval-eval.test.ts
```

## MRR threshold rationale

Thresholds differ by eval because each tests a different retrieval scenario:

| Eval | MRR threshold | Why |
|------|---------------|-----|
| `bm25f-eval` | 0.7 | TypeScript graph is richest (full AST, symbol names, import edges). BM25F has the most signal to work with. |
| `hono-retrieval-eval` | 0.33 | Real-world Hono framework with harder ground truth. Queries are ambiguous, multiple valid targets exist. |
| `typeorm-retrieval-eval` | 0.2 | Large ORM codebase with deep inheritance hierarchies that BM25F cannot fully resolve. |
| `go-retrieval-eval` | 0.2 | Go has no import graph from the TS parser; relies on path/symbol matching only. |
| `python-retrieval-eval` | 0.2 | Python AST support is limited; fewer symbol names available for matching. |
| `rust-retrieval-eval` | 0.2 | Rust module system differs from TS; parser support is minimal. |
| `betweenness-real-projects` | N/A | Tests betweenness centrality ranking, not retrieval MRR. |

## Adding a new eval

1. Create `src/__tests__/evals/<name>-eval.test.ts`
2. Gate with `describe.skipIf(!process.env.REAL_PROJECT_EVAL)`
3. Define ground truth: `{ query: string, expected: string[] }[]`
4. Call `resolveEditTargets(query, graph)` and compute MRR
5. Assert `averageMRR >= threshold` with a threshold appropriate for the language/difficulty
