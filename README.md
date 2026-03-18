<h1 align="center"><img src="logo.svg" width="110" alt="Clarté logo" /><br>Clarté</h1>
<p align="center"><em>/klaʁ.te/</em></p>

<p align="center">
  <a href="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml"><img src="https://github.com/michaelabrt/clarte/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/clarte"><img src="https://img.shields.io/npm/v/clarte" alt="npm version"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-5.9-blue" alt="TypeScript"></a>
  <a href="https://fsl.software"><img src="https://img.shields.io/badge/License-FSL--1.1--MIT-blue.svg" alt="License: FSL-1.1-MIT"></a>
</p>

<p align="center"><strong>Predicts which files to edit before the agent starts exploring.</strong></p>

```bash
npx clarte            # build graph, generate hooks and context
```

Zero config. Detects your stack, scans source files, generates everything. Node.js 20+.

---

Hono JSX async context loss. Real bug, opaque prompt, Claude Sonnet:

| | Without Clarté | With Clarté |
|---|---|---|
| Time to first edit | 14 minutes | **2 minutes** |
| File edited | `src/jsx/base.ts` (wrong) | **`src/jsx/context.ts`** (correct) |
| Outcome | hit budget cap | **task completed** |

Clarté's BM25F retrieval predicted `src/jsx/context.ts` as the top edit target. The agent applied the prediction and skipped exploration entirely. Without it, the agent spent 14 minutes reasoning, edited the wrong file and ran out of budget.

## Results

Five real bug fixes in open-source repos. Opaque prompts, Claude Sonnet, `claude -p`:

| Task | Repo | Without Clarté | With Clarté | n |
|------|------|----------------|-------------|---|
| JSX async context loss | Hono | wrong file, did not finish | **correct file, 2 min to first edit** | 2+2 |
| Form validator prototype pollution | Hono | did not finish | **completed (18 turns)** | 1+1 |
| SQLite simple-enum array | TypeORM | 47.7 turns | **16.3 turns (-66%)** | 3+3 |
| WebSocket adapter shutdown | NestJS | 53 turns | **38 turns (-28%)** | 7+7 |
| URL fragment stripping | Hono | completed, high variance | **completed, 3x more consistent** | 8+8 |

Clarté completed 5 of 5. Without it, the agent completed 3 of 5 within the same budget. The first four rows use the full stack (graph + BM25F targeting + pre-flight agent). The WebSocket row uses the context file only (no pre-flight). The TypeORM and WebSocket rows pool from multiple controlled runs; JSX and form validator include single-run pilots with follow-up ABs. For controlled evidence with statistical testing, see [controlled benchmarks](#controlled-benchmarks).

## See the Problem in Your Project

```bash
$ npx clarte observe --all

19 sessions analyzed

Averages (per session)
  Turns:        48.2
  First edit:   turn 16.5

Phase Distribution
  Explore:  59%   ← reading files never edited
  Edit:     28%
  Tail:     13%   ← re-running tests with no code change
```

Parses Claude Code session logs, classifies turns into explore/edit/tail phases and detects waste patterns. 59% of turns spent reading files the agent never touches. 75% of tail waste is test-retry loops where the agent re-runs the same failing command without changing code.

## Why It Works

We tested 30+ approaches across 700+ sessions. 15 content experiments (richer analysis, better formatting, more sections) produced zero wins. A [placebo](#placebo) (minimal context listing only language and test framework) performed identically to the full analysis. Content injection doesn't change agent behavior; confidence injection does.

**First-edit timing** is the strongest predictor of session efficiency (r=0.70-1.00 across 15 of 19 tasks). Each turn before the first edit adds roughly 1.3 total turns. Agents find files on their own; they lack the confidence to stop reading and start editing. Clarté provides that confidence by running probabilistic inference over the dependency graph and delivering ranked edit targets before the first turn.

For the full research story (30+ experiments, ablation studies, statistical methodology), see [docs/research.md](docs/research.md).

## How It Works

Clarté is a probabilistic intent-mapping engine. It parses imports with tree-sitter, builds a dependency graph and trains repository-specific scoring weights from git history. On every prompt, it maps the task description to ranked file targets through a multi-stage pipeline - BM25F retrieval, latent semantic expansion, Katz centrality propagation and learned logistic fusion - in under 50ms.

```mermaid
graph TD
    subgraph offline ["Build Phase (offline)"]
        A[tree-sitter] --> B[Dependency Graph]
        C[git log] --> D[Change Coupling]
        B --> E["HITS · Betweenness · Communities"]
        D --> F[Bayesian EWMA Priors]
        E & D --> G[Logistic Fusion Training]
    end

    subgraph prompt ["Query Phase (per prompt)"]
        H[Task Prompt] --> I["BM25F Multi-field Scoring"]
        I --> J[LSA Seed Expansion]
        J --> K[Katz Propagation]
        K --> L[Score Fusion]
        L --> M[Pre-flight Agent]
    end

    B -.-> I
    G -.-> L
    F -.-> K
    M --> N((Agent))
```

<details>
<summary><strong>BM25F Seed Resolution</strong></summary>

File paths encode architectural intent. `auth/middleware.ts` tells you more about a session-handling bug than a function named `validate`. Clarté runs true multi-field BM25F (Robertson et al. 2004) across three document fields - file path, exported symbol names and import statements - with per-field length normalization and independent field weights.

Path segments are weighted 2x higher than symbols. Import names are weighted 0.5x because they signal consumption, not definition. The query is tokenized with camelCase splitting, compound preservation and domain-specific synonym expansion (`auth` -> `authentication`, `db` -> `database`). IDF is computed globally across the corpus.

After scoring, three post-processing steps refine the candidate set:

1. **Spreading activation** propagates scores along import edges for 3 hops with $0.5^{(\text{hop}-1)}$ decay and directional bias (importers 0.4x, imports 0.2x, co-change partners 0.4x)
2. **Test proxy scoring** transfers test file BM25F scores to their source files at 0.6x, since test paths encode what they cover
3. **Import ceiling** caps import-only files at 0.5x the minimum path/symbol score, preventing re-export barrels from outranking direct matches

$$\text{score}(d, q) = \sum_{t \in q} \text{IDF}(t) \cdot \frac{\widetilde{tf}(t, d)}{\widetilde{tf}(t, d) + k_1}$$

where the weighted pseudo-term-frequency combines all three fields before saturation (true BM25F, not per-field BM25+):

$$\widetilde{tf}(t, d) = \sum_{f \in \lbrace \text{path, sym, imp} \rbrace} w_f \cdot \frac{tf_{f}(t, d)}{1 - b_f + b_f \cdot |d_f| \, / \, \overline{dl}_f}$$

| Parameter | Value | Role |
|-----------|-------|------|
| $k_1$ | 1.2 | Saturation constant |
| $w_{\text{path}}$ | 2.0 | Path field weight |
| $w_{\text{sym}}$ | 1.0 | Symbol field weight |
| $w_{\text{imp}}$ | 0.5 | Import field weight |
| $b_{\text{path}}$ | 0.3 | Path length normalization |
| $b_{\text{sym}}$ | 0.4 | Symbol length normalization |
| $b_{\text{imp}}$ | 0.5 | Import length normalization |

</details>

<details>
<summary><strong>Semantic Expansion (LSA)</strong></summary>

BM25F only finds lexical matches. A bug report mentioning "session tokens" won't match a file named `auth/middleware.ts` that exports `validateJWT`. Latent Semantic Analysis catches these conceptual neighbors.

Clarté builds a file-symbol incidence matrix and computes a rank-32 approximation via randomized truncated SVD (Halko-Martinsson-Tropp). Files are projected into a 32-dimensional latent space where cosine similarity captures shared structural role rather than shared tokens.

After BM25F scoring, the top seeds are averaged into a centroid vector. Non-seed files within cosine distance 0.3 of this centroid enter the candidate pool at a discounted score (0.4x the minimum BM25F seed score), expanding the set with up to 5 conceptually related files that share no surface tokens with the query. Activates only on codebases with 50+ files; below that threshold, BM25F alone has sufficient coverage.

**Randomized SVD pipeline:**

1. Build sparse file-symbol incidence matrix $M$ (CSR format)
2. Generate random Gaussian $\Omega \in \mathbb{R}^{n \times (k+p)}$ where $k{=}32$ (rank), $p{=}10$ (oversampling)
3. Form $Y = M\Omega$, then 2 power iterations: $Y \leftarrow M(M^T Y)$
4. QR decomposition $Y = QR$ via modified Gram-Schmidt
5. Project: $B = Q^T M$ (small dense matrix)
6. Jacobi eigendecomposition of $BB^T$ for singular values and left vectors
7. File embeddings: $U = Q \, U_B \, \text{diag}(S)$

Sub-millisecond for typical codebases (1,000 files, 20 imports/file).

</details>

<details>
<summary><strong>Katz Intent Propagation</strong></summary>

Single-path graph traversal misses consensus. If a file is reachable from the query seeds via three independent import chains, it is more likely relevant than a file reachable via one chain. Katz centrality captures this by computing the weighted sum of all walks from the seed set, with exponential decay per hop.

The attenuation factor $\alpha$ is set to 85% of $1/\rho(A)$, where $\rho(A)$ is the spectral radius of the weighted adjacency matrix (estimated via 10 power iterations). This guarantees convergence while maximizing the contribution of longer paths.

Edge weights fuse four signals: edge kind (call, import, type-only), co-change confidence from Bayesian EWMA priors, directionality (reverse edges discounted) and ghost status (edges to files outside the analyzed scope).

$$\mathbf{x}_{k+1} = \alpha \, A^T \mathbf{x}_k + \mathbf{s}$$

Converges when $\lVert\mathbf{x}_{k+1} - \mathbf{x}_k\rVert_2 < 10^{-6}$ or after 50 iterations. The closed-form solution $(I - \alpha A^T)^{-1}\mathbf{s}$ avoids matrix inversion in favor of the iterative form, which supports sparse graphs with O(|E|) per iteration.

</details>

<details>
<summary><strong>Logistic Score Fusion</strong></summary>

Hardcoded weights assume every repository has the same coupling patterns. A monorepo with 200 packages and a single-file CLI tool need different blends of lexical, structural and temporal signals. Clarté learns repository-specific fusion weights from git history via logistic regression.

For each of the 500 most recent multi-file commits, the system extracts four features per (candidate, seed-set) pair:

| Feature | Signal |
|---------|--------|
| $L$ | Path token Jaccard similarity (lexical proximity) |
| $G$ | $1 / (\text{BFS distance} + 1)$ via multi-source BFS (graph proximity) |
| $T$ | Maximum change coupling confidence (temporal co-change) |
| $B$ | Normalized betweenness centrality (structural importance) |

Hard negatives are mined from three tiers: direct imports, same Leiden community members and 2-hop neighbors. Logistic regression with L2 regularization ($\lambda = 0.01$) learns $\boldsymbol{\lambda} = (\lambda_L, \lambda_G, \lambda_T, \lambda_B)$ via batch gradient descent. Trained weights are stored in the graph database. Repositories with fewer than 30 commits fall back to empirically tuned defaults.

$$P(\text{co-change} \mid \mathbf{x}) = \sigma(\boldsymbol{\lambda}^T \mathbf{x}) = \frac{1}{1 + e^{-\boldsymbol{\lambda}^T \mathbf{x}}}$$

Training budget: <50ms for 500 commits on a 1,000-file graph.

</details>

<details>
<summary><strong>Execution Flow (Absorbing Markov Chains)</strong></summary>

Import graphs show static structure. Execution flow shows runtime behavior. A function's callers reveal more about impact than its importers.

Clarté models the call graph as an absorbing Markov chain. Each symbol is a state; symbols with no outgoing calls are absorbing states. Transition probabilities fuse four factors:

$$w(u, v) = s(\text{kind}) \cdot c \cdot \alpha(v)^{0.7} \cdot e^{-0.033\,\Delta t}$$

where $s$ is the edge kind weight, $c$ is coupling confidence, $\alpha(v)$ is the HITS authority of the target (raised to 0.7 to soften dominance) and $\Delta t$ is days since last co-change (exponential decay with ~90-day half-life).

Cross-community utility sinks (loggers, formatters) with indegree $\geq 5$ receive a 0.05x penalty via information-theoretic attenuation (INF), which uses the ratio of directed indegree to outdegree to distinguish legitimate hubs from infrastructure drains. This keeps probability flowing through domain logic rather than pooling in shared utilities.

Forward propagation from the entry point produces a flow signature: visited states with absorption probabilities, residual mass and convergence steps. The system reconstructs up to 5 diverse shortest paths and identifies dominator waypoints - nodes that all execution paths must traverse.

</details>

<details>
<summary><strong>Supporting Infrastructure (HITS, Bayesian EWMA)</strong></summary>

Two systems provide the edge weights consumed by the stages above.

**HITS Authority/Hub Scoring.** Hyperlink-Induced Topic Search with teleportation smoothing ($\alpha = 0.15$) computes per-file authority and hub scores. Authority identifies foundational files (heavily imported); hub identifies orchestrators (many outgoing imports). Barrel files receive a 0.3x authority discount. Edge weights account for specificity (how many names are imported), type-only discount (0.7x) and dynamic import discount (0.5x). These scores feed into Markov transition weights, file role classification and the betweenness centrality used in logistic fusion features.

**Bayesian EWMA Edge Priors.** Each import edge carries a Beta($\alpha$, $\beta$) distribution modeling co-change probability. Priors initialize from structural properties: direct value import at 0.7, barrel-routed at 0.5, dynamic at 0.4, type-only at 0.3. On each git commit, affected edges update via EWMA with 0.995 per-commit decay. The expected weight $E[w] = \alpha / (\alpha + \beta)$ modulates Katz edge weights and Markov transition probabilities, giving recently co-changed edges higher traversal probability.

</details>

## Controlled Benchmarks

<a id="controlled-benchmarks"></a>

Controlled benchmarks isolating context files alone (no hooks, no pre-flight). Same tasks, same model. Statistical testing with Wilcoxon signed-rank, bootstrap CIs, Benjamini-Hochberg FDR correction and Cliff's delta effect sizes.

**Claude Sonnet 4.6** - 9 opaque tasks across 3 TypeScript fixtures, 5 repetitions (135 sessions):

| Metric | Without Context | With Context | Delta | Significance |
|--------|----------------|--------------|-------|--------------|
| Wall-clock time (median) | 130s | **98s** | **-25%** | p<0.001, small effect |
| Turns (median) | 16 | **11.5** | **-28%** | p<0.001, medium effect |
| Input tokens (median) | 272K | **108K** | **-60%** | p<0.001, large effect |
| Pass rate | 100% | 93% | -7pp | n.s. |

Token reduction translates directly to faster response times - 60% less context for the model to process per turn, regardless of pricing model.

<a id="placebo"></a>

A placebo condition (minimal context with project language and test framework, no structural analysis) showed negligible change (not significant), confirming the improvement comes from the graph analysis, not from having a system prompt.

The 7pp pass rate drop is not statistically significant at this sample size, but we are underpowered to rule out a small regression. Users should monitor pass rates in their own workloads.

**Claude Haiku 4.5** - 3 tasks, 7 repetitions (127 sessions):

| Metric | Without Context | With Context | Delta |
|--------|----------------|--------------|-------|
| Pass rate | 86% | **95%** | **+9pp** |
| Turns (median) | 19 | **14** | -26% (p<0.001) |

Haiku shows a correctness gain: +9pp pass rate with 26% fewer turns.

Methodology, fixture projects and full reports are in the [benchmark repo](https://github.com/michaelabrt/clarte-benchmark).

<details>
<summary><strong>Claude Code Integration</strong></summary>

For Claude Code, Clarté installs hooks and a pre-flight diagnostic agent on top of the context file. This is the full stack that produced the case study results.

**The flow:**

1. You submit a task prompt
2. The prompt hook checks whether the prompt already mentions file paths from the dependency graph. If it does, the agent already knows where to edit - steps 3-4 are skipped (zero overhead)
3. Otherwise, the hook runs BM25F retrieval over the graph (file paths + AST symbol names), writes the top-5 predicted edit targets to `.clarte/task-context.md` with key symbols and installs the pre-flight agent. Falls back to git history similarity when no graph is present
4. The pre-flight agent reads each target file exactly once and returns exact code locations with verbatim surrounding context and a proposed fix
5. The main agent's first action is an edit, not an exploration

| Component | Location | Purpose |
|-----------|----------|---------|
| Context file | `.claude/rules/clarte.md` | Operational directives, always loaded |
| Prompt hook | `.clarte/hooks/on-prompt.mjs` | BM25F target resolution on every prompt |
| Fail-fast hook | `.clarte/hooks/on-fail-fast.mjs` | Blocks repeated test/build without a code edit (threshold: 3) |
| Session hook | `.clarte/hooks/on-session-start.mjs` | Resets hook state, disables hooks for Haiku |
| Pre-flight agent | `.clarte/agents/clarte-pre-flight.md` | Reads targets, returns exact edit locations |

Hooks wire into `.claude/settings.json` automatically. The pre-flight agent is stored in `.clarte/agents/` and copied to `.claude/agents/` only when the prompt hook detects an opaque task.

Also generates context files for Cursor, Copilot, Windsurf, Cline, Continue and OpenCode (context file only, no hooks or steering).

</details>

<details>
<summary><strong>Generated Scripts</strong></summary>

Clarté generates framework-aware shell scripts in `.clarte/scripts/`:

| Script | What it does |
|--------|-------------|
| `check-tests.sh` | Runs your test command and appends a structured one-line summary (pass/fail counts, failure names). Parses output for Vitest, Jest, Mocha and pytest. |
| `run-tests.sh` | Runs a filtered subset of tests by name pattern. Auto-detects compile steps and runs them first when needed. |
| `clarte-grep` | Wraps ripgrep and appends graph context (importers, co-change partners, test file) for each matching file. |

These are referenced in the generated context file with imperative directives ("Always use X instead of Y") so the agent uses them by default.

</details>

<details>
<summary><strong>Supported Languages</strong></summary>

| Language | Import parsing | Snapshot extraction |
|----------|---------------|---------------------|
| TypeScript / JavaScript | `import`, `require` | types, interfaces, functions, components, hooks, stores |
| Python | `import`, `from ... import` | classes, functions, type aliases |
| Go | `import` | structs, interfaces, functions, methods |
| Rust | `use` | structs, enums, traits, functions |
| Java | `import` | classes, interfaces, enums, records, methods |

Multi-language projects handled automatically when a secondary language exceeds 15% of source files.

</details>

<details>
<summary><strong>CLI Reference</strong></summary>

```bash
npx clarte [directory] [options]
```

**Subcommands:**

| Command | Description |
|---------|-------------|
| `init` | Set up Clarté for a project (default if no subcommand) |
| `observe` | Analyze Claude Code session logs for waste patterns |
| `ci` | Analyze changed files and output architectural findings as JSON |

**Init options:**

| Flag | Description |
|------|-------------|
| `--yes` | Overwrite existing files without asking |
| `--dry-run` | Preview what would be generated |
| `--reconfigure` | Re-prompt even if `.clarte.json` exists |
| `--refresh-snapshot` | Re-scan source files and update just the code snapshot |
| `--format=json` | Output full analysis as structured JSON to stdout |
| `--init-hook` | Install git pre-commit hook for auto-refresh on commit |
| `-v, --verbose` | Show detailed progress output |

**Observe options:**

| Flag | Description |
|------|-------------|
| `--session=ID` | Analyze a specific session |
| `--all` | Search all projects, not just current |
| `--since=7d` | Time window (d/h/m/w) |
| `--format=json` | Machine-readable JSON output |

**Check options:**

| Flag | Description |
|------|-------------|
| `--check` | Exit 0 if snapshot is fresh, 1 if stale (hash-based) |
| `--check=timestamp` | Timestamp-only staleness check (for shell hooks) |
| `--ci` | Machine-readable output (use with `--check` for CI pipelines) |

**CI options:**

| Flag | Description |
|------|-------------|
| `--base=REF` | Git ref to diff against (default: HEAD) |
| `--changed-files=a,b` | Explicit list of changed files (comma-separated) |

</details>

<details>
<summary><strong>Configuration</strong></summary>

On first run, Clarté saves config to `.clarte.json` (add to `.gitignore`). Use `--reconfigure` to re-prompt.

| Field | Description |
|-------|-------------|
| `analysisDays` | Git history window in days (default: 90) |
| `staleDays` | Days before snapshot is considered stale (default: 7) |
| `layers` | Custom architectural layer patterns (regex, for hexagonal/clean/DDD architectures) |

**Monorepo support:** Detects pnpm workspaces, Turborepo and Nx. Per-package context files with scoped dependencies, frameworks and cross-package import analysis.

**Framework conventions:** Detects Next.js, Express, FastAPI, Django, NestJS, SvelteKit, Expo, Hono and more. Includes relevant conventions in the output.

**User section preservation:** Wrap custom content with `<!-- clarte:user-start -->` / `<!-- clarte:user-end -->` markers to survive regeneration.

</details>

<details>
<summary><strong>GitHub Action (work in progress)</strong></summary>

There's an experimental GitHub Action that reviews PRs for missing co-changes and structural hotspots. It works but the signal-to-noise ratio needs improvement - most findings are technically correct but not actionable yet. Use at your own discretion.

```yaml
- uses: michaelabrt/clarte@v1
  with:
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

</details>

## Development

```bash
bun install
bun run build      # Build with tsup
bun run dev        # Watch mode
bun run typecheck  # Type-check without emitting
bun test           # Run tests with vitest
```

## License

[FSL-1.1-MIT](LICENSE) - free to use, modify and distribute. The only restriction is competing use (building a product whose primary utility overlaps with Clarté's core functionality). Converts to MIT on March 17, 2028.
