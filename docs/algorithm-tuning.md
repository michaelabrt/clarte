# Algorithm Tuning Guide

Every tunable parameter and threshold in clarte's analysis pipeline, organized by subsystem. Use this reference when adapting clarte to codebases with unusual characteristics (very small, very large, monorepo, high churn, etc.).

---

## Quick Reference

| Parameter | Value | File | Line | Section |
|-----------|-------|------|------|---------|
| HITS alpha (teleportation) | 0.15 | graph.ts | ~808 | [Graph Analysis](#1-graph-analysis) |
| HITS max iterations | 30 | graph.ts | ~799 | [Graph Analysis](#1-graph-analysis) |
| HITS convergence epsilon | 1e-6 | graph.ts | ~800 | [Graph Analysis](#1-graph-analysis) |
| HITS type-only discount | 0.7 | graph.ts | ~825 | [Graph Analysis](#1-graph-analysis) |
| HITS dynamic import discount | 0.5 | graph.ts | ~826 | [Graph Analysis](#1-graph-analysis) |
| HITS barrel authority discount | 0.3 | graph.ts | ~835 | [Graph Analysis](#1-graph-analysis) |
| HITS specificity formula | log2(N+1)/log2(6), min 0.2 | graph.ts | ~828-829 | [Graph Analysis](#1-graph-analysis) |
| Betweenness sample size (k) | 50 | graph.ts | ~2596 | [Graph Analysis](#1-graph-analysis) |
| Foundation threshold | authority > 0.6, hub < 0.3 | graph.ts | ~934 | [Role Classification](#2-role-classification) |
| Orchestrator threshold | hub > 0.6, authority < 0.3 | graph.ts | ~936 | [Role Classification](#2-role-classification) |
| Bridge threshold | authority > 0.4, hub > 0.4 | graph.ts | ~938 | [Role Classification](#2-role-classification) |
| Utility threshold | 0.3 <= authority <= 0.6, hub < 0.3 | graph.ts | ~940 | [Role Classification](#2-role-classification) |
| Instability threshold | 0.8 | graph.ts | ~1598 | [Role Classification](#2-role-classification) |
| Community min size | 3 files | graph.ts | ~1668, 1746 | [Graph Analysis](#1-graph-analysis) |
| Community ARI novelty threshold | 0.85 | graph.ts | ~1760 | [Graph Analysis](#1-graph-analysis) |
| Cross-cutting min layer spread | 3 | graph.ts | ~1912 | [Graph Analysis](#1-graph-analysis) |
| Tight coupling min names | 5 | graph.ts | ~2520 | [Graph Analysis](#1-graph-analysis) |
| Hub files limit | 8 | graph.ts | ~1209 | [Graph Analysis](#1-graph-analysis) |
| Max circular deps | 10 | graph.ts | ~1317 | [Graph Analysis](#1-graph-analysis) |
| Barrel detection ratio | >50% re-exports | graph.ts | ~773 | [Graph Analysis](#1-graph-analysis) |
| Default analysis window | 90 days | git-analysis.ts | ~27, 90 | [Temporal Analysis](#3-temporal-analysis) |
| Adaptive decay (fast repo) | 29 (half-life ~20d) | git-analysis.ts | ~251 | [Temporal Analysis](#3-temporal-analysis) |
| Adaptive decay (moderate) | 45 (half-life ~31d) | git-analysis.ts | ~253 | [Temporal Analysis](#3-temporal-analysis) |
| Adaptive decay (slow repo) | 87 (half-life ~60d) | git-analysis.ts | ~252 | [Temporal Analysis](#3-temporal-analysis) |
| Fast repo threshold | >30 commits/month | git-analysis.ts | ~251 | [Temporal Analysis](#3-temporal-analysis) |
| Slow repo threshold | <5 commits/month | git-analysis.ts | ~252 | [Temporal Analysis](#3-temporal-analysis) |
| Max coupling files per commit | 30 | git-analysis.ts | ~283 | [Temporal Analysis](#3-temporal-analysis) |
| Coupling confidence minimum | 0.3 | git-analysis.ts | ~339 | [Temporal Analysis](#3-temporal-analysis) |
| Coupling results limit | 10 | git-analysis.ts | ~357 | [Temporal Analysis](#3-temporal-analysis) |
| Hot files limit | 15 | git-analysis.ts | ~129 | [Temporal Analysis](#3-temporal-analysis) |
| Noise discount (lint/format) | 0.1 | git-analysis.ts | ~214 | [Temporal Analysis](#3-temporal-analysis) |
| Noise discount (merge/release) | 0.2 | git-analysis.ts | ~215 | [Temporal Analysis](#3-temporal-analysis) |
| Noise discount (refactor) | 0.5 | git-analysis.ts | ~216 | [Temporal Analysis](#3-temporal-analysis) |
| Lag coupling window | 1-3 commits | git-analysis.ts | ~397 | [Temporal Analysis](#3-temporal-analysis) |
| Lag coupling significance | > coChangeCount * 0.5 | git-analysis.ts | ~406 | [Temporal Analysis](#3-temporal-analysis) |
| Token budget formula | min(20000, 4000 + sqrt(files) * 400) | snapshot.ts | ~1508 | [Snapshot Generation](#4-snapshot-generation) |
| Type/interface boost | 1.3x | snapshot.ts | ~1711 | [Snapshot Generation](#4-snapshot-generation) |
| Git activity boost | 1.0 + log2(commits+1) * 0.15 | snapshot.ts | ~1718 | [Snapshot Generation](#4-snapshot-generation) |
| Diversity discount | 0.5x for same-file entries | snapshot.ts | ~1744 | [Snapshot Generation](#4-snapshot-generation) |
| Parallel chunk size | 50 files | snapshot.ts | ~1520 | [Snapshot Generation](#4-snapshot-generation) |
| Block extraction max lines | 30 | snapshot.ts | ~365, 628 | [Snapshot Generation](#4-snapshot-generation) |
| Convention sampling limit | 50 files | conventions.ts | ~443 | [Convention Inference](#5-convention-inference) |
| Import ordering sample limit | 20 files | conventions.ts | ~482 | [Convention Inference](#5-convention-inference) |
| Naming majority threshold | 0.6 (60%) | conventions.ts | ~34 | [Convention Inference](#5-convention-inference) |
| Directory override threshold | 0.8 (80%) | conventions.ts | ~366 | [Convention Inference](#5-convention-inference) |
| Prefix detection minimum | 3 matches | conventions.ts | ~135 | [Convention Inference](#5-convention-inference) |
| Barrel file ratio (conventions) | >50% re-export lines | conventions.ts | ~741 | [Convention Inference](#5-convention-inference) |
| Integration test import threshold | 3+ source modules | test-map.ts | ~92 | [Convention Inference](#5-convention-inference) |
| High-churn directive threshold | >= 10 commits | directives.ts | ~155 | [Directive Generation](#6-directive-generation) |
| Co-change directive confidence | >= 0.6 | directives.ts | ~103 | [Directive Generation](#6-directive-generation) |
| Complexity high band | > 50 branch points | directives.ts | ~175 | [Directive Generation](#6-directive-generation) |
| Complexity medium band | >= 20 branch points | directives.ts | ~175 | [Directive Generation](#6-directive-generation) |
| Tech debt min risk factors | 2 | directives.ts | ~255 | [Directive Generation](#6-directive-generation) |
| Instability risk threshold | >= 0.8, fanIn >= 3 | directives.ts | ~231 | [Directive Generation](#6-directive-generation) |
| Flow bottleneck threshold | betweenness > 0.5 | directives.ts | ~316 | [Directive Generation](#6-directive-generation) |
| Transitive risk max depth | 5 hops | graph.ts | ~2376 | [Graph Analysis](#1-graph-analysis) |
| Transitive risk decay | 0.5 per hop | graph.ts | ~2409 | [Graph Analysis](#1-graph-analysis) |
| Transitive risk weight split | 0.3 direct / 0.7 transitive | graph.ts | ~2424 | [Graph Analysis](#1-graph-analysis) |
| Transitive risk min score | 0.1 | graph.ts | ~2426 | [Graph Analysis](#1-graph-analysis) |
| Structural-temporal min confidence | 0.4 | graph.ts | ~2450 | [Graph Analysis](#1-graph-analysis) |
| Structural-temporal min distance | 3 hops | graph.ts | ~2451 | [Graph Analysis](#1-graph-analysis) |
| Architectural fitness max violations | 20 | graph.ts | ~2791 | [Graph Analysis](#1-graph-analysis) |

---

## 1. Graph Analysis

### HITS Centrality

HITS (Hyperlink-Induced Topic Search) computes two scores per file: **authority** (how much other files depend on it) and **hub** (how much it orchestrates others).

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `alpha` (teleportation) | 0.15 | graph.ts:~808 | Smoothing factor that prevents extreme score distributions in star-shaped graphs. Each node gets `alpha * (1/N)` base score per iteration. |
| `maxIterations` | 30 | graph.ts:~799 | Maximum power iterations before halting. |
| `epsilon` | 1e-6 | graph.ts:~800 | Convergence threshold; iteration stops when the max score delta falls below this. |

**Reasoning**: Alpha = 0.15 follows the PageRank convention (originally 0.15 teleportation / 0.85 damping). It prevents leaf nodes from collapsing to zero in projects with hub-and-spoke topologies.

**Sensitivity**:
- Higher alpha (0.2-0.3): Scores flatten; differences between hub files and leaves shrink. Useful if you want more files to appear "important."
- Lower alpha (0.05-0.10): Scores become more extreme; a single highly-imported file dominates. Can produce unstable rankings in small graphs.

**When to adjust**: If hub file rankings seem unintuitive (e.g., a clearly important file ranks low), try lowering alpha. If too many files tie for top positions, raise it.

### HITS Edge Weights

Edges are not all equal. The weight formula is:

```
weight = (1 - typeOnlyDiscount) * dynamicDiscount * specificity
```

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Type-only discount | 0.7 | graph.ts:~825 | Edges from `import type { ... }` contribute only 30% weight. Type-only imports indicate design-time coupling, not runtime dependency. |
| Dynamic import discount | 0.5 | graph.ts:~826 | `import(...)` edges get half weight. Dynamic imports are lazy/conditional, so the coupling is weaker. |
| Specificity floor | 0.2 | graph.ts:~829 | Minimum weight for edges with zero named imports (side-effect imports). |
| Specificity formula | log2(N+1) / log2(6) | graph.ts:~828-829 | Where N = number of imported names. Importing 5 named exports is a stronger coupling signal than importing 1. |
| Barrel authority discount | 0.3x | graph.ts:~834-835 | Edges targeting barrel files (index re-exports) contribute 30% authority. Barrel files are routing, not substance. |

**Sensitivity**:
- Setting type-only discount to 0 (no discount) inflates authority for type definition files, which may or may not be desirable.
- The specificity formula saturates at ~5 imports (log2(6)/log2(6) = 1.0). Beyond 5 named imports, the edge weight is governed only by the other factors.

### Betweenness Centrality (Sampled Brandes)

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `k` (sample size) | 50 | graph.ts:~2596 | Number of source nodes sampled for approximate betweenness. Full Brandes is O(V*E); sampling makes it O(k*E). |

**Reasoning**: 50 samples provides a good accuracy/performance tradeoff for codebases up to ~5000 files. The algorithm uses a deterministic seeded PRNG for reproducible results.

**Sensitivity**:
- Lower k (10-20): Faster but noisier. Bottleneck rankings may fluctuate between runs on large codebases.
- Higher k (100-200): More accurate but slower. Diminishing returns beyond 100 for most projects.

**When to adjust**: If betweenness-based directives (flow bottleneck warnings) seem unreliable, increase k. For very large monorepos (>5000 files), consider lowering k for speed.

### Barrel File Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Re-export ratio threshold | > 50% | graph.ts:~773 | A file is classified as a barrel if more than half of its top-level statements are re-exports (`export { ... } from` or `export * from`). |

**Reasoning**: 50% is a conservative threshold. True barrel files (like `index.ts`) are almost entirely re-exports. A file with 40% re-exports likely has its own logic too.

**When to adjust**: If your project has "partial barrel" files (index files that both re-export and define utilities), you might lower this to ~0.3 to capture them.

### Community Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Minimum community size | 3 files | graph.ts:~1668, 1746 | Tiny communities (< 3 files) are merged into their best neighbor. Final communities under 3 files are discarded. |
| Merge rounds | 3 | graph.ts:~1663 | Maximum iterations for merging tiny communities. |
| Reassignment rounds | 3 | graph.ts:~1705 | Maximum iterations for reassigning files with >50% cross-community imports. |
| Reassignment threshold | > 50% edges to other community | graph.ts:~1732 | A file is reassigned when the majority of its edges point to a different community. |
| ARI novelty threshold | 0.85 | graph.ts:~1760 | Adjusted Rand Index. If the detected communities match the directory tree with ARI > 0.85, they are discarded as offering no novel insight. |

**Reasoning**: Community detection is only useful when it reveals non-obvious groupings that differ from the directory structure. The ARI check prevents outputting "src/components forms a cluster" when that's already obvious from the file tree.

**Sensitivity**:
- Lowering the ARI threshold (e.g., 0.7) means communities must differ more from directories to be reported. This reduces noise but may suppress valid findings.
- Raising it (e.g., 0.95) reports communities even when they mostly match directories.

### Cross-Cutting File Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `minLayerSpread` | 3 layers | graph.ts:~1912 | A file must be imported from at least 3 different architectural layers to be flagged as cross-cutting. |

**Reasoning**: A file imported by 2 layers is common (e.g., types imported by both hooks and components). Requiring 3+ layers surfaces files that truly span boundaries.

**When to adjust**: For projects with only 3-4 layers total, lowering to 2 makes sense. For projects with 8+ layers, raising to 4 reduces noise.

### Tight Coupling Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `minNames` | 5 | graph.ts:~2520 | Minimum number of distinct named imports from a single file to flag as tightly coupled. |
| `topN` | 10 | graph.ts:~2521 | Maximum number of tight coupling pairs to return. |

**Reasoning**: Importing 5+ named exports from one file (e.g., `import { A, B, C, D, E } from './module'`) suggests the consumer depends on many implementation details. This threshold balances signal (real coupling) vs. noise (files legitimately using a rich API).

**When to adjust**: For projects with large type definition files (where importing 10+ types is normal), raise to 8-10. For projects that heavily use barrel files, this metric is less meaningful since barrel resolution already rewrites edges.

### Transitive Dependency Risk

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `maxDepth` | 5 hops | graph.ts:~2376 | BFS depth limit when computing transitive risk. |
| Decay per hop | 0.5 | graph.ts:~2409 | Exponential decay: `pow(0.5, depth)`. A dependency 3 hops away contributes 12.5% of its volatility. |
| Risk weight split | 0.3 direct / 0.7 transitive | graph.ts:~2424 | How much the file's own churn vs. its dependencies' churn contributes to the score. |
| Minimum risk score | 0.1 | graph.ts:~2426 | Files below this score are excluded from results. |
| `topN` | 15 | graph.ts:~2377 | Maximum number of at-risk files to return. |

**Reasoning**: The 0.3/0.7 weight split reflects the idea that a file's risk comes more from its volatile dependencies than its own churn. The half-life decay ensures distant dependencies do not dominate.

### Structural-Temporal Mismatch Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `minConfidence` | 0.4 | graph.ts:~2450 | Minimum co-change confidence to consider a pair. |
| `minDistance` | 3 hops | graph.ts:~2451 | Minimum structural distance in the import graph to flag as a mismatch. |
| `topN` | 10 | graph.ts:~2452 | Maximum number of mismatch pairs to return. |

**Reasoning**: A pair that co-changes at 40%+ confidence yet has no short path in the import graph suggests a hidden dependency (shared schema, API contract, or copy-paste coupling).

### Output Limits

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Hub files limit | 8 | graph.ts:~1209 | Top N files returned by `getHubFiles()`. |
| Max circular deps | 10 | graph.ts:~1317 | Maximum cycles to report from SCC analysis. |
| Layer violations cap | 10 | graph.ts:~2079 | Maximum layer violations in consistency report. |
| Chokepoint dependents cap | 10 | graph.ts:~2159 | Maximum disconnected files listed per chokepoint. |
| Fitness violations cap | 20 | graph.ts:~2791 | Maximum architectural fitness violations. |

---

## 2. Role Classification

Files are classified into roles based on their HITS authority and hub scores. All thresholds operate on min-max normalized scores (0-1 range).

| Role | Authority | Hub Score | Description |
|------|-----------|-----------|-------------|
| **Foundation** | > 0.6 | < 0.3 | Heavily depended upon, delegates little. Types, core utilities. |
| **Orchestrator** | < 0.3 | > 0.6 | Coordinates many modules, not itself depended upon. Entry points, routers. |
| **Bridge** | > 0.4 | > 0.4 | Significant on both axes; sits between subsystems. |
| **Utility** | 0.3 - 0.6 | < 0.3 | Moderate authority, provides helpers without orchestrating. |
| **Barrel** | (any) | (any) | Barrel files get this role regardless of scores (checked first). |
| **Leaf** | (remainder) | (remainder) | Low on both axes; end-of-chain files like pages or scripts. |

Location: `graph.ts:~931-942`

**Reasoning**: The thresholds (0.6, 0.3, 0.4) were empirically tuned on typical TypeScript/React project distributions after min-max normalization. The comment in code notes that boundary instability is expected in small graphs (<10 files) where score ranges compress.

**Sensitivity**:
- Lowering the Foundation authority threshold (e.g., 0.5) captures more files as foundations. Useful for codebases where dependency depth is shallow.
- Raising the Bridge thresholds (e.g., 0.5 each) narrows the Bridge category to only the most clearly dual-role files.
- In small projects, most files collapse to Leaf or Utility because score variance is low.

**When to adjust**: If the role distribution seems wrong (e.g., all files are Leaf), the problem is usually that HITS scores are compressed. Adjusting alpha or edge weights is more effective than changing these thresholds.

### Instability (Robert C. Martin metric)

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `INSTABILITY_THRESHOLD` | 0.8 | graph.ts:~1598 | Files with instability > 0.8 AND fanIn >= 1 are flagged. |

Formula: `instability = fanOut / (fanIn + fanOut)`

**Reasoning**: A file with instability near 1.0 depends on many others but nothing depends on it; changes to its dependencies cascade freely. The 0.8 threshold focuses on the most extreme cases. The fanIn >= 1 guard prevents flagging completely isolated files.

---

## 3. Temporal Analysis

### Analysis Window

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Default window | 90 days | git-analysis.ts:~27, 90 | How far back to look in git history. |
| Configurable via | `analysisDays` param or `sinceRef` | git-analysis.ts:~90-91 | Users can override via config. |

**When to adjust**: 90 days works well for most projects. For slow-moving projects (< 5 commits/month), extend to 180 days. For very active projects (daily deploys), 30-60 days reduces noise.

### Adaptive Temporal Decay

The decay constant adapts to repository velocity (commits per month within the analysis window).

| Velocity | Commits/month | Decay constant | Half-life | Location |
|----------|--------------|----------------|-----------|----------|
| Fast | > 30 | 29 | ~20 days | git-analysis.ts:~251 |
| Moderate | 5-30 | 45 | ~31 days | git-analysis.ts:~253 |
| Slow | < 5 | 87 | ~60 days | git-analysis.ts:~252 |

Formula: `decay(ageDays) = exp(-ageDays / decayConstant)`

**Reasoning**: In fast-moving repos, a commit from 60 days ago is ancient history. In slow repos, a 60-day-old commit is recent. Adaptive decay normalizes the recency signal across different project tempos.

**Sensitivity**:
- The half-life breakpoints (20d, 31d, 60d) correspond to the decay constants via `halfLife = decayConstant * ln(2)`.
- Using a fixed decay constant of 45 for all repos works for moderate projects but may over-weight old commits in fast repos.

### Change Coupling

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| `MAX_COUPLING_FILES` | 30 | git-analysis.ts:~283 | Commits touching > 30 files are skipped (mass renames, generated code). |
| Adaptive min co-changes | 3 if > 20 multi-file commits, else 2 | git-analysis.ts:~319 | Minimum raw co-change count to consider a pair. |
| Confidence minimum | 0.3 (Jaccard) | git-analysis.ts:~339 | Pairs below 30% Jaccard similarity are discarded. |
| Results limit | 10 pairs | git-analysis.ts:~357 | Maximum coupling pairs returned. |
| Hot files limit | 15 | git-analysis.ts:~129 | Maximum files in the hot files list. |

**Coupling weight formula**:
```
pairWeight = 1 / (files.length - 1)    // inverse commit size
weight = pairWeight * decay * noise
```

**Reasoning**: Inverse commit size prevents large commits from inflating coupling scores. A commit touching 20 files contributes much less per pair than a commit touching 2 files.

**Sensitivity**:
- Lowering `MAX_COUPLING_FILES` to 15 aggressively filters large commits but may miss legitimate refactoring patterns.
- Raising the confidence minimum to 0.5 reduces noise but may suppress real coupling in repos with many single-file commits.

### Noise Discounting

Commit messages matching certain patterns receive reduced weight:

| Pattern | Discount | Location | Reasoning |
|---------|----------|----------|-----------|
| lint, format, prettier, eslint, style, biome | 0.1 (90% reduction) | git-analysis.ts:~214 | Formatting commits are mass changes with no semantic coupling. |
| merge, bump, release, changelog, version | 0.2 (80% reduction) | git-analysis.ts:~215 | Release engineering touches many files artificially. |
| refactor, rename, move | 0.5 (50% reduction) | git-analysis.ts:~216 | Refactoring co-changes are real but represent historical, not ongoing, coupling. |

**When to adjust**: If your team uses different commit message conventions (e.g., "chore:" for formatting), the patterns may not match. Consider extending `NOISE_PATTERNS` in git-analysis.ts.

### Lag Coupling

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Lag window | 1-3 commits | git-analysis.ts:~397 | How many commits ahead/behind to look for reactive co-changes. |
| Inverse lag weighting | 1/lag | git-analysis.ts:~400 | Lag 1 contributes 1.0, lag 2 contributes 0.5, lag 3 contributes 0.33. |
| Significance threshold | lagScore > coChangeCount * 0.5 | git-analysis.ts:~406 | Lag coupling must be at least 50% of same-commit coupling to be reported. |

**Reasoning**: Lag coupling captures reactive patterns where modifying file A predictably triggers a change to file B within the next 1-3 commits. The significance threshold prevents flagging pairs that merely happen to be active simultaneously.

---

## 4. Snapshot Generation

### Token Budget

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Budget formula | `min(20000, 4000 + sqrt(sourceFileCount) * 400)` | snapshot.ts:~1508 | Scales with project size but caps at 20K tokens. |
| Override | `maxTokens` parameter | snapshot.ts:~1346 | Users can override the automatic budget. |

**Budget examples**:

| Source files | Budget (tokens) |
|-------------|----------------|
| 10 | 5,265 |
| 50 | 6,828 |
| 100 | 8,000 |
| 500 | 12,944 |
| 1000+ | 16,649 (caps at 20,000) |

**Reasoning**: The square root scaling prevents large projects from blowing up context windows. The 4,000 base ensures small projects still get meaningful snapshots. The 20,000 cap leaves room for the rest of the context file.

**Sensitivity**:
- The base of 4,000 is roughly the cost of 10-15 type definitions. Below this, snapshots are too sparse to be useful.
- The multiplier of 400 controls how aggressively the budget grows. Raising it (e.g., 600) favors larger snapshots in medium projects.
- The cap of 20,000 assumes a total context budget of ~30-40K tokens. For models with larger windows, this can be raised.

### Entry Scoring

Each snapshot entry is scored for inclusion:

```
value = (centrality * categoryBoost * gitBoost) / tokens
```

| Component | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Centrality fallback | 0.5 | snapshot.ts:~1707 | Default centrality when no import graph is available. |
| Category boost (type/interface) | 1.3x | snapshot.ts:~1711 | Types and interfaces get 30% priority boost; they are the most useful context for code generation. |
| Category boost (other) | 1.0x | snapshot.ts:~1710 | Functions, hooks, stores, components get no boost. |
| Git boost formula | `1.0 + log2(commits + 1) * 0.15` | snapshot.ts:~1718 | Recently active files score higher. Logarithmic so 100 commits scores higher than 20, but not 5x higher. |
| Git boost multiplier | 0.15 | snapshot.ts:~1718 | Controls how much git activity influences selection. |

**Sensitivity**:
- Raising the category boost (e.g., 1.5x) strongly favors types over functions. Good for projects where type definitions are the primary API surface.
- The git boost multiplier of 0.15 is conservative. Raising to 0.25 gives more weight to recently active code, which may be desirable if the codebase has a lot of legacy dead code.

### Diversity Discount (Submodular Selection)

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Same-file discount | 0.5x | snapshot.ts:~1744 | After selecting one entry from a file, subsequent entries from the same file score at 50%. |

**Reasoning**: Without the discount, a single large type definition file could consume most of the budget. The 0.5x discount ensures diverse file coverage.

**Sensitivity**:
- Lower discount (e.g., 0.3x) strongly penalizes multiple entries from one file. Better for broad coverage.
- Higher discount (e.g., 0.8x) allows more entries per file. Better if key files contain many critical types.

### Parallelism

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Chunk size | 50 files | snapshot.ts:~1520 | Files are processed in batches of 50 using `Promise.all()`. |

**Reasoning**: Processing all files at once would create too many concurrent file reads. Chunking at 50 provides good throughput without overwhelming the file system.

**When to adjust**: On systems with slow I/O (network drives), lower to 20-30. On fast SSDs with many cores, raising to 100 may improve throughput.

### Block Extraction Limits

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Max block lines | 30 | snapshot.ts:~365, 628, 876, 930, 1220 | Maximum lines captured for a single type/struct/class definition. |
| Function signature lookahead | 5 lines | snapshot.ts:~409 | Maximum lines to scan for a function signature. |

---

## 5. Convention Inference

### Sampling

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| File sampling limit | 50 files | conventions.ts:~443 | Maximum files sampled for identifier analysis, sorted by centrality (highest first). |
| Import ordering samples | 20 files | conventions.ts:~482 | Maximum files sampled for import ordering detection. |

**Reasoning**: Sampling high-centrality files first ensures conventions are inferred from the most interconnected (and presumably most canonical) code. 50 files is enough to establish statistical confidence in naming patterns.

### Naming Pattern Thresholds

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Global majority threshold | 0.6 (60%) | conventions.ts:~34 | A naming style must appear in 60%+ of identifiers to be reported as a convention. Below this, "mixed" is returned. |
| Directory override threshold | 0.8 (80%) | conventions.ts:~366 | Per-directory overrides require 80% consistency, stricter than the global threshold. |
| Minimum identifiers for override | 3 per category | conventions.ts:~360, 373, 386, 399 | At least 3 functions/types/constants/files needed to infer a per-directory pattern. |
| Minimum total samples for directory | 5 | conventions.ts:~353 | A directory needs 5+ identifiers total before convention analysis. |
| Import ordering dominance for alphabetical | 0.7 (70%) | conventions.ts:~552, 555 | Alphabetical ordering or node-builtin separation is reported only if 70%+ of sampled files follow it. |

**Sensitivity**:
- Lowering the global threshold to 0.5 catches weaker conventions but may report false positives in codebases with genuinely mixed styles.
- The directory override threshold at 0.8 is intentionally strict to avoid noisy per-directory overrides.

### Prefix Detection

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Minimum matches | 3 | conventions.ts:~135 | A prefix pattern (e.g., `use`, `is`, `handle`) needs 3+ occurrences to be reported. |

**Reasoning**: With fewer than 3 matches, a prefix could be coincidental. The prefix patterns are hardcoded (use, is, has, get, set, handle, on, create, make).

### Barrel File Detection (Conventions Module)

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Re-export line ratio | > 50% | conventions.ts:~741 | A file is classified as a barrel if more than half of its non-empty, non-comment lines are re-exports. |

This is a separate barrel detection from `graph.ts` (which uses statement counting). The conventions module uses a simpler line-based heuristic for counting barrel files in the export style statistics.

### Test Type Classification

| Parameter | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Integration import threshold | 3+ source modules | test-map.ts:~92 | A test file importing 3+ distinct source modules (not in an e2e/ or integration/ directory) is classified as an integration test. |

**Reasoning**: Unit tests typically import 1-2 modules (the module under test plus maybe a helper). Tests importing 3+ source modules are exercising integration between multiple components.

---

## 6. Directive Generation

Directives are imperative guidelines generated from analysis results. Each category has its own thresholds and limits.

### Category Limits

| Category | Max directives | Location |
|----------|---------------|----------|
| Foundation file guards | 3 | directives.ts:~80 |
| Circular dep guidance | 3 | directives.ts:~90 |
| Co-change hints | 5 | directives.ts:~104 |
| Chokepoint caution | 3 | directives.ts:~115 |
| Test reminders | 3 | directives.ts:~127 |
| Layer violation warnings | 2 | directives.ts:~144 |
| High-churn caution | 3 | directives.ts:~156 |
| Complexity warnings | 3 | directives.ts:~171 |
| Tech debt flags | 5 | directives.ts:~261 |
| Encapsulation violations | 3 | directives.ts:~280 |
| Lag coupling hints | 3 | directives.ts:~289 |
| Change impact predictions | 5 | directives.ts:~299 |
| Flow bottleneck directives | 3 | directives.ts:~318 |
| Architectural fitness violations | 5 | directives.ts:~336 |

### Filtering Thresholds

| Threshold | Value | Location | What it controls |
|-----------|-------|----------|-----------------|
| Co-change confidence for directive | >= 0.6 | directives.ts:~103 | Only coupling pairs with 60%+ Jaccard confidence generate directives. |
| Untested hub min importedBy | >= 2 | directives.ts:~126 | Only untested files imported by 2+ files get test reminder directives. |
| High-churn commit count | >= 10 | directives.ts:~155 | Files with fewer than 10 commits in the analysis window are not flagged for churn. |
| Complexity high band | > 50 branch points | directives.ts:~175 | High complexity threshold for hub files. |
| Complexity medium band | >= 20 branch points | directives.ts:~175 | Medium complexity threshold. |
| Large file indicator | >= 1000 lines | directives.ts:~179 | Files >= 1000 lines get a rounded line count in the directive. |
| Tech debt risk factor threshold | >= 2 factors | directives.ts:~255 | Files need 2+ risk factors (high churn, no tests, circular dep, high instability, tightly coupled) to be flagged. |
| High instability for risk | >= 0.8, fanIn >= 3 | directives.ts:~231 | Instability qualifies as a risk factor when extreme (>= 0.8) and the file has real dependents (fanIn >= 3). |
| Flow bottleneck betweenness | > 0.5 | directives.ts:~316 | Betweenness score threshold for flow bottleneck directives. Only files NOT already flagged as chokepoints are included. |

**Reasoning for the 0.6 co-change confidence**: At 0.6 Jaccard similarity, two files appear in the same commits more often than not relative to their total appearances. This is a strong enough signal to warrant an explicit directive. The lower 0.3 threshold used in coupling detection itself allows exploration, while the directive threshold is stricter to avoid noisy guidance.

**Reasoning for 10 commits as high-churn**: In a 90-day window, 10 commits means roughly one change every 9 days. This signals a file under active development where concurrent modifications are likely.

---

## Interaction Effects

Some parameters interact with each other in non-obvious ways:

1. **HITS alpha and edge weights**: Increasing alpha flattens score distributions, making edge weight differences less impactful. If you tune edge weights (e.g., type-only discount), test with the default alpha.

2. **Adaptive decay and coupling confidence**: Fast repos use shorter decay, which down-weights older co-changes. This can lower confidence for pairs that co-changed heavily in the past but not recently. The adaptive min co-change count (2 or 3) partially compensates.

3. **Token budget and diversity discount**: A tight budget combined with a strong diversity discount (low multiplier) produces broad but shallow snapshots. A generous budget with weak discount produces deep snapshots dominated by a few key files.

4. **Community ARI threshold and layer detection**: Communities are validated against the directory tree, not against architectural layers. If your project uses flat directories but has clear architectural layering, communities may appear novel (low ARI) even when they merely restate the layers.

5. **Instability threshold and tech debt flags**: The instability threshold of 0.8 in graph.ts controls which files appear in the instability list. The directive system applies a stricter filter (0.8 AND fanIn >= 3) before flagging instability as a risk factor.
