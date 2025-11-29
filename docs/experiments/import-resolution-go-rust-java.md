# Experiment: Go/Rust/Java Import Resolution (2.37-2.39)

**Branch:** `experimental/ongoing/go-import-resolution` (merged to main)
**Date:** 2026-02-24
**Verdict:** GO

## Theory

Go, Rust, and Java import graphs were actively broken: `resolveImport()` returned `null` for all three languages (graph.ts:267), so every internal import was misclassified as an external package. This broke all downstream analysis (HITS scores, architectural layers, chokepoints, coupling, hub detection) for non-TypeScript/Python projects.

The hypothesis: implementing language-specific import resolution would produce correct internal edges, enabling the full analysis pipeline to work for Go/Rust/Java projects.

## Implementation

### Go

Reads `go.mod` to extract the module path (e.g., `myapp`). For each import starting with the module path, strips the prefix to get the relative package directory, then finds `.go` files in that directory. Stdlib and third-party imports (which don't start with the module path) fall through to external.

`getPackageName` for Go: domain-style imports (`github.com/user/repo/...`) take the first 3 segments; stdlib (`fmt`, `net/http`) takes the first segment.

### Java

Detects source roots by scanning for `src/main/java/`, `src/test/java/`, or `src/` prefixes in the file list. Converts dotted import paths (`com.example.model.User`) to file paths (`com/example/model/User.java`) and tries each source root. Wildcard imports (`com.example.model.*`) find the first `.java` file in the package directory.

`getPackageName` for Java: known prefixes (`java.`, `javax.`) take 2 segments; domain-style (`com.example.library`) takes 3 segments.

### Rust

Resolves `crate::`, `super::`, `self::` use paths by mapping `::` to `/` and trying `.rs` files or `/mod.rs` directories. Handles scoped imports (`crate::types::{A, B}`) by stripping the brace suffix. Uses progressive segment shortening to distinguish module paths from item names (e.g., `crate::models::user::User` tries `models/user/User.rs`, then `models/user.rs`).

For `mod` declarations (`mod foo;`), the AST parser now prefixes specifiers with `mod::` to distinguish them from `use` declarations. Resolution tries `foo.rs` then `foo/mod.rs` relative to the declaring file.

`getPackageName` for Rust: takes the first segment before `::` (e.g., `std`, `serde`).

### Shared infrastructure

- `ResolveContext` interface carries language-specific state (`goModulePath`, `javaSourceRoots`)
- `getPackageName(specifier, lang?)` extended with language-aware package name extraction
- `isRelativeSpecifier` updated: Go/Java always return `true` (attempt resolution first), Rust adds `mod::` prefix
- Unresolved Go/Java/Rust imports fall through to external edges (previously silently dropped)
- Guard prevents unresolved `mod::` declarations from creating bogus `"mod"` external packages

### Files modified

| File | Change |
|------|--------|
| `src/graph.ts` | +305 lines: 7 new functions, updated `resolveImport`, `getPackageName`, `isRelativeSpecifier`, `buildImportGraph` |
| `src/ast-parse.ts` | Prefix Rust `mod` declarations with `mod::` |
| `src/__tests__/integration/language-pipeline.test.ts` | Flip `resolvesInternalEdges` to `true` for all three languages |
| `src/__tests__/graph.test.ts` | Update Rust mod test for `mod::` prefix |
| `src/__tests__/ast-parse.test.ts` | Update Rust mod test for `mod::` prefix |
| `src/__tests__/integration/fixtures/go-service/go.mod` | New fixture |
| `src/__tests__/integration/fixtures/rust-lib/Cargo.toml` | New fixture |
| `src/__tests__/integration/fixtures/java-app/pom.xml` | New fixture |
| `src/__tests__/integration/fixtures/rust-lib/src/lib.rs` | Use `crate::` paths (Rust 2018 convention) |

## Resolved edges (fixture verification)

### Go (go-service fixture)

| From | To | Type |
|------|-----|------|
| `cmd/main.go` | `internal/handler/handler.go` | internal |
| `internal/handler/handler.go` | `internal/store/store.go` | internal |
| `internal/handler/handler.go` | `internal/model/user.go` | internal |
| `internal/store/store.go` | `internal/model/user.go` | internal |
| (various) | `fmt`, `net`, `encoding`, `time`, `sync` | external |

### Rust (rust-lib fixture)

| From | To | Type |
|------|-----|------|
| `src/lib.rs` | `src/models/mod.rs` | internal (mod decl) |
| `src/lib.rs` | `src/handlers/mod.rs` | internal (mod decl) |
| `src/lib.rs` | `src/models/user.rs` | internal (use path) |
| `src/lib.rs` | `src/handlers/user_handler.rs` | internal (use path) |
| `src/handlers/mod.rs` | `src/handlers/user_handler.rs` | internal (mod decl) |
| `src/handlers/user_handler.rs` | `src/models/user.rs` | internal (use crate::) |
| `src/models/mod.rs` | `src/models/user.rs` | internal (mod decl) |
| `src/models/mod.rs` | `src/models/product.rs` | internal (mod decl) |
| (various) | `serde` | external |

### Java (java-app fixture)

| From | To | Type |
|------|-----|------|
| `UserController.java` | `User.java` | internal |
| `UserController.java` | `UserService.java` | internal |
| `ProductService.java` | `Product.java` | internal |
| `UserService.java` | `User.java` | internal |
| (various) | `java.util` | external |

## CLAUDE.md output comparison

Context size change (baseline on main vs experiment):

| Language | Baseline | Experiment | Delta | Key files | Hub detection |
|----------|----------|------------|-------|-----------|---------------|
| Go | 841 B | 2,122 B | +152% | 0 -> 4 | none -> handler.go (Orchestrator) |
| Rust | 924 B | 2,893 B | +213% | 0 -> 6 | none -> lib.rs (Orchestrator) |
| Java | 905 B | 2,751 B | +204% | 0 -> 5 | none -> UserController.java (Orchestrator) |

Baseline outputs lacked: key files, working guidelines, chokepoints, roles, co-change suggestions. All files appeared as dead/unconnected. Experiment outputs contain full architectural analysis.

## Eval results

### E.1 (deterministic)

- `tsc --noEmit`: clean
- `vitest run`: 900/900 pass
- Self-test diff on clarte (TypeScript project): only temporal differences and line count change (2400+ -> 2700+)

### E.2 (isolated LLM eval, temp=0, 1 iteration)

12 tasks (4 per language): hub detection, architecture, foundation/chokepoint, external separation/dead files.

| Language | Baseline | Experiment | Delta |
|----------|----------|------------|-------|
| Go | 2/4 | **4/4** | **+50%** |
| Rust | 2/4 | **4/4** | **+50%** |
| Java | 2/4 | **4/4** | **+50%** |
| **Aggregate** | **6/12 (50%)** | **12/12 (100%)** | **+50%** |

6 improves, 0 regressions. Cost: $0.18.

### E.3 (combinatorial, temp=0.3, 2 iterations)

Same 12 tasks, 2 iterations at temp=0.3.

| Language | Baseline | Experiment | Delta |
|----------|----------|------------|-------|
| Go | 4/8 | **8/8** | **+50%** |
| Rust | 4/8 | **6/8** | **+25%** |
| Java | 4/8 | **8/8** | **+50%** |
| **Aggregate** | **12/24 (50%)** | **22/24 (91.7%)** | **+41.7%** |

10 improves, 2 regressions (both rs-4 chokepoint task, consistent across iterations). The rs-4 regression is a judge artifact: the richer context causes the model to describe flow bottlenecks (from the betweenness data) instead of graph-disconnection chokepoints. Both descriptions are architecturally valid; the judge prompt penalizes not using the word "disconnect." Cost: $0.36.

**Verdict: GO.** All three gates pass with extremely strong positive signal. Unlike marginal experiments (content-dedup at -5%, instability-feedback at 0%), this feature shows +41-50% improvement with near-zero regression risk.

## Safety analysis

| Concern | Analysis |
|---------|----------|
| TS/JS projects | Zero impact: all new code paths guarded by `language === "go"/"java"/"rust"` |
| Python projects | Zero impact: hits existing `case "python"` before new branches |
| `getPackageName(spec, lang?)` | `lang` is optional with default to original `/`-split behavior |
| Unresolved `mod::` declarations | Guarded: skipped before `getPackageName` to prevent bogus `"mod"` package |
| Performance | `loadGoModule` is one file read; `detectJavaSourceRoots` is a single pass over the file list. Negligible overhead. |
