# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 49 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/graph.ts` (Foundation, imported by 30 files), check dependents for breaking changes.
- When modifying `package-lock.json`, also check `package.json` (90% of the time).
- When modifying `src/__tests__/hooks.test.ts`, also check `src/hooks.ts` (100% of the time).
- `src/utils.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/graph.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/theme.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/index.ts` is a high-churn file (53 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `README.md` is a high-churn file (39 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/summary.ts` is a high-churn file (30 commits in 90 days). Review recent changes before modifying to avoid conflicts.
- `src/graph.ts` is a Foundation file with high complexity (36 exports, 2400+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` is a Orchestrator file with high complexity (0 exports, 971 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/watch.ts` is a Orchestrator file with medium complexity (3 exports, 359 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/templates/main-context.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/graph.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- `src/detect.ts` has multiple risk factors (high churn, tightly coupled). Consider extracting an interface and before making large changes.
- When you modify `src/index.ts`, you'll likely need to also update `src/summary.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/types.ts` within the next 1-2 commits (lagged co-change pattern).
- When you modify `src/index.ts`, you'll likely need to also update `src/templates/main-context.ts` within the next 1-2 commits (lagged co-change pattern).
- When modifying `src/graph.ts`, also check: `src/snapshot.ts`, `src/diff.ts`, `src/index.ts`, `src/refresh.ts`.
- When modifying `src/utils.ts`, also check: `src/check.ts`, `src/config-scan.ts`, `src/config.ts`, `src/conventions.ts`.
- When modifying `src/cache.ts`, also check: `src/theme.ts`, `src/types.ts`, `src/diff.ts`, `src/utils.ts`.
- When modifying `src/diff.ts`, also check: `src/theme.ts`, `src/utils.ts`, `src/animations.ts`, `src/detect.ts`.
- When modifying `src/watch.ts`, also check: `src/config.ts`, `src/detect.ts`, `src/config-scan.ts`, `src/theme.ts`.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/graph.ts` (Foundation) | 30 files | stable |
| `src/index.ts` (Orchestrator) | 0 files | stable |
| `src/watch.ts` (Orchestrator) | 2 files | 82% unstable ⚠️ |
| `src/diff.ts` | 2 files | 85% unstable ⚠️ |
| `src/cache.ts` | 4 files | stable |
| `src/utils.ts` (Utility) | 33 files | stable |
| `src/__tests__/golden/golden.test.ts` | 0 files | stable |
| `src/__tests__/bench/pipeline.bench.ts` | 0 files | stable |

## Architecture

Dependency flow (foundational -> consumer):

`types` -> `utils` -> `services`

Cross-layer edges: services -> types, services -> utils, utils -> types

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, camelCase for files
- **Prefer**: In `src/theme.ts/`, use camelCase for constants (overrides project-wide camelCase)
- **Prefer**: In `src/templates/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Code Snapshot

<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->
### Core Types

```ts
export type RGB = [number, number, number];  // imported by 24 files

export type TestType = "unit" | "integration" | "e2e";  // imported by 62 files

export type ProgressCallback = (message: string) => void;  // imported by 62 files

export interface LayerEdge {  // imported by 62 files
  from: string;
  to: string;
}

export type TimeWindow = { days: number } | { ref: string };  // imported by 4 files

export type FileRole = "Foundation" | "Orchestrator" | "Bridge" | "Utility" | "Leaf" | "Barrel";  // imported by 62 files

export type Language =  // imported by 62 files
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

export type Linter =  // imported by 62 files
  | "biome"
  | "eslint"
  | "prettier"
  | "ruff"
  | "black"
  | "rustfmt"
  | "gofmt"
  | "none";

export type PackageManager =  // imported by 62 files
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go"
  | "none";

export interface FileComplexityInfo {  // imported by 10 files
  path: string;
  exports: number;
  lines: number;
  branchPoints: number;
}

export type IDETarget =  // imported by 62 files
  | "claude"
  | "cursor"
  | "opencode"
  | "copilot"
  | "windsurf"
  | "cline"
  | "continue"
  | "aider"
  | "generic";

export interface PackageHubFile {  // imported by 62 files
  /** Relative file path */
  path: string;
  /** HITS authority score within the package subgraph */
  authority: number;
}

export interface DetectedFramework {  // imported by 62 files
  name: string;
  version?: string;
  /** Number of files that import this framework (from import graph) */
  importCount?: number;
}

export interface GeneratedFile {  // imported by 62 files
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

export interface MonorepoInfo {  // imported by 62 files
  /** Which monorepo tool was detected */
  type: "pnpm-workspaces" | "turborepo" | "nx" | "npm-workspaces";
  /** Discovered packages */
  packages: MonorepoPackage[];
}

export interface Community {  // imported by 62 files
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

export interface LagCoupling {  // imported by 62 files
  fileA: string;
  fileB: string;
  /** Number of same-commit co-changes */
  sameCommitCount: number;
  /** Weighted lag coupling score (inverse-lag weighted) */
  lagScore: number;
}

export interface LayerConsistency {  // imported by 62 files
  /** Fraction of cross-layer imports that follow the expected direction (0-1) */
  consistency: number;
  /** Import edges that violate the expected layer ordering */
  violations: LayerViolation[];
}

export interface LayerViolation {  // imported by 62 files
  /** File that contains the import */
  from: string;
  /** File being imported */
  to: string;
  /** Layer of the importing file */
  fromLayer: string;
  /** Layer of the imported file */
  toLayer: string;
}

export interface TightCoupling {  // imported by 62 files
  /** The file doing the importing */
  from: string;
  /** The file being imported from */
  to: string;
  /** Number of named imports */
  importedNames: number;
  /** The actual imported names */
  names: string[];
}

export interface CodeSnapshot {  // imported by 62 files
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}

export interface ContextSection {  // imported by 62 files
  /** Unique section identifier */
  id: string;
  /** Priority level: 0 = always included, 1 = highest, 10 = lowest */
  priority: number;
  /** Rendered markdown content */
  content: string;
  /** Estimated token count */
  tokens: number;
}

export interface MonorepoPackage {  // imported by 62 files
  /** Package name from package.json */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Dependency names */
  dependencies: string[];
  /** Detected frameworks for this package */
  frameworks: DetectedFramework[];
}

export interface CacheData {  // imported by 4 files
  version: number;
  createdAt: string;
  language: string;
  fileHashes: Record<string, string>;
  edges: SerializedEdge[];
  barrelFiles: string[];
}

export interface FileInstability {  // imported by 62 files
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1 */
  instability: number;
}

export interface ShimmerHandle {  // imported by 3 files
  /** Stop the shimmer and clear the line */
  stop: () => void;
  /** Update the shimmer text mid-animation */
  message: (text: string) => void;
}

export interface CircularDependency {  // imported by 62 files
  /** File paths forming the cycle */
  chain: string[];
  /** Severity 0-1: 0 = all type-only imports, 1 = all runtime imports */
  severity?: number;
  /** Suggestion for breaking the cycle (e.g. "Convert X -> Y to type-only import") */
  breakHint?: string;
}

export interface TestMapping {  // imported by 62 files
  sourceToTests: Map<string, string[]>;
  untestedFiles: string[];
  testPattern?: {
    framework: string;
    convention: string;
    filePattern: string;
  };
  /** Classification of each test file by type (unit, integration, e2e) */
  testTypes?: Map<string, TestType>;
}

export interface ParsedCommit {  // imported by 4 files
  hash: string;
  date: string;
  relativeDate: string;
  message: string;
  files: string[];
}

export interface CrossCuttingFile {  // imported by 62 files
  /** Relative file path */
  file: string;
  /** Total number of files that import this file */
  totalImporters: number;
  /** Number of distinct architectural layers importing this file */
  layerSpread: number;
  /** Which layers import this file */
  layers: string[];
}

export interface StructuralTemporalMismatch {  // imported by 62 files
  fileA: string;
  fileB: string;
  /** BFS shortest path distance in the import graph (-1 if unreachable) */
  graphDistance: number;
  /** Co-change confidence from git analysis */
  coChangeConfidence: number;
  /** Number of co-changes */
  coChangeCount: number;
}

export interface Chokepoint {  // imported by 62 files
  /** Relative file path */
  file: string;
  /** Number of disconnected components if this file were removed */
  separates: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Files that would be disconnected from the main component if this file were removed */
  dependents?: string[];
}

export interface AnalysisSnapshot {  // imported by 4 files
  timestamp: string;
  hubFilePaths: string[];
  hubFileRoles: Record<string, string>;
  circularDepChains: string[][];
  deadFiles: string[];
  chokepointPaths: string[];
  layerViolationCount: number;
}

export interface ArchitecturalLayer {  // imported by 62 files
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}

export interface CrossPackageEdge {  // imported by 62 files
  /** Source file (relative path) */
  from: string;
  /** Target file (relative path) */
  to: string;
  /** Source package name */
  fromPackage: string;
  /** Target package name */
  toPackage: string;
  /** Whether this import accesses internal files (not the package's public API) */
  isEncapsulationViolation: boolean;
}

export interface ArchViolation {  // imported by 62 files
  /** File that violates the rule */
  from: string;
  /** File being imported in violation */
  to: string;
  /** Rule identifier (e.g. "no-upward-dep", "test-isolation", "layer-skip") */
  rule: string;
  /** Human-readable message describing the violation */
  message: string;
  /** Severity level */
  severity: "error" | "warning";
}

export interface SnapshotEntry {  // imported by 62 files
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
}

export interface ClaudeSkill {  // imported by 62 files
  /** Skill name (used as directory name) */
  name: string;
  /** Human-readable description */
  description: string;
  /** If true, skill cannot invoke the model; it just injects content */
  disableModelInvocation: boolean;
  /** Comma-separated allowed tools (e.g. "Read, Grep, Glob") */
  allowedTools?: string;
  /** Markdown body of the skill */
  body: string;
}

export interface ArchitectureDelta {  // imported by 4 files
  newHubFiles: string[];
  demotedHubFiles: string[];
  newCircularDeps: string[][];
  resolvedCircularDeps: string[][];
  newDeadFiles: string[];
  resurrectedFiles: string[];
  newChokepoints: string[];
  resolvedChokepoints: string[];
  layerViolationDelta: number;
}

export interface GraphTopology {  // imported by 62 files
  /** Number of connected components */
  componentCount: number;
  /** Sizes of each connected component, sorted descending */
  componentSizes: number[];
  /** Approximate graph diameter (longest shortest path sampled) */
  approximateDiameter: number;
  /** Fraction of files reachable from the largest component */
  reachability: number;
  /** Whether the codebase has independent subsystems (>1 component with 5+ files) */
  isFragmented: boolean;
}

export interface MonorepoAnalysis {  // imported by 62 files
  /** Import edges crossing package boundaries */
  crossPackageEdges: CrossPackageEdge[];
  /** Encapsulation violations (imports of internal files) */
  encapsulationViolations: CrossPackageEdge[];
  /** Dependencies between packages (package name -> set of dependent package names) */
  packageDependencies: Map<string, Set<string>>;
  /** Top hub files per package (package name -> top files by authority) */
  packageHubFiles?: Map<string, PackageHubFile[]>;
}

export interface ChangeCoupling {  // imported by 62 files
  fileA: string;
  fileB: string;
  /** Number of commits both files appeared in together */
  coChangeCount: number;
  /** Fraction of commits containing either file that contain both */
  support: number;
  /** Confidence: coChangeCount / max(commitsA, commitsB) */
  confidence: number;
  /** Directional: P(fileB changes | fileA changes) = coChangeCount / commitsA */
  confidenceAB?: number;
  /** Directional: P(fileA changes | fileB changes) = coChangeCount / commitsB */
  confidenceBA?: number;
}

export interface RawImport {  // imported by 9 files
  specifier: string;
  importedNames: string[];
  isTypeOnly?: boolean;
  isDynamic?: boolean;
}

export interface HubFile {  // imported by 62 files
  /** Relative file path */
  path: string;
  /** Centrality score (0-1) — set to authority for backward compat */
  centrality: number;
  /** HITS authority score (0-1): how much this file is depended upon */
  authority: number;
  /** HITS hub score (0-1): how much this file orchestrates others */
  hubScore: number;
  /** Functional role derived from authority/hub balance */
  role: FileRole;
  /** Number of files that import this file */
  importedBy: number;
  /** Number of internal files this file imports */
  imports: number;
}

export interface ConfigConstraints {  // imported by 62 files
  typescript?: {
    strict: boolean;
    target: string;
    pathAliases: Record<string, string[]>;
    otherStrict: string[];
  };
  linter?: {
    tool: string;
    keyRules: Array<{ rule: string; setting: string; impact: string }>;
  };
  formatter?: {
    tool: string;
    indent: string;
    quotes: string;
    semicolons: boolean;
  };
  go?: {
    version: string;
  };
  rust?: {
    edition: string;
    clippy?: string[];
  };
  python?: {
    version?: string;
    ruff?: string[];
    mypy?: { strict: boolean };
  };
}

export interface GitAnalysis {  // imported by 62 files
  /** Map of relative file path -> commit count in analysis window */
  commitCounts: Map<string, number>;
  /** Files sorted by commit count descending */
  hotFiles: Array<{
    path: string;
    commits: number;
    lastChanged: string;
  }>;
  /** Co-change coupling pairs (files that change together) */
  changeCoupling: ChangeCoupling[];
  /** Lag-adjusted temporal coupling pairs (reactive co-change within 1-3 commits) */
  lagCouplings?: LagCoupling[];
  /** Per-file code churn (lines added/removed) in the analysis window */
  fileChurn?: Map<string, { linesAdded: number; linesRemoved: number }>;
}

export interface ImportEdge {  // imported by 62 files
  /** Source file (relative path) */
  from: string;
  /** Target file or package (relative path or bare specifier) */
  to: string;
  /** Whether this is an external package import */
  isExternal: boolean;
  /** Raw import specifier as written in source */
  specifier: string;
  /** Named imports (e.g. ['useState', 'useEffect']) */
  importedNames: string[];
  /** Whether this is a type-only import (import type { ... }) */
  isTypeOnly?: boolean;
  /** Whether this is a dynamic import (import('...')) */
  isDynamic?: boolean;
  /** Whether this edge crosses monorepo package boundaries */
  crossPackage?: boolean;
}

export interface InferredConventions {  // imported by 62 files
  naming: {
    functions: string;
    types: string;
    constants: string;
    files: string;
  };
  exportStyle: {
    preferNamed: boolean;
    defaultExportPercent: number;
    barrelFileCount: number;
  };
  importOrdering?: string;
  /** Per-directory convention overrides when a directory differs from global conventions */
  directoryOverrides?: Array<{
    directory: string;
    naming: { functions?: string; types?: string; constants?: string; files?: string };
  }>;
  /** Detected function name prefix patterns (e.g., use*, is*, get*) */
  namingPrefixes?: Array<{ prefix: string; count: number; example: string }>;
}

export interface ImportGraph {  // imported by 62 files
  /** All import edges */
  edges: ImportEdge[];
  /** Number of files that import each file */
  inDegree: Map<string, number>;
  /** Centrality scores (0-1) — set to HITS authority for backward compat */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
  /** HITS authority scores (0-1): how much a file is depended upon */
  authority: Map<string, number>;
  /** HITS hub scores (0-1): how much a file depends on others */
  hubScores: Map<string, number>;
  /** Files detected as barrel/index files (>50% re-export statements) */
  barrelFiles?: Set<string>;
  /** Approximate betweenness centrality scores (0-1) from sampled Brandes */
  betweennessScores?: Map<string, number>;
}
```

### Key Functions

```ts
export function findSCCs(graph: ImportGraph): string[][]  // imported by 30 files

export function parseJsImports(content: string): RawImport[]  // imported by 30 files

export function parseGoImports(content: string): RawImport[]  // imported by 30 files

export function parsePythonImports(content: string): RawImport[]  // imported by 30 files

export function parseRustImports(content: string): RawImport[]  // imported by 30 files

export function parseJavaImports(content: string): RawImport[]  // imported by 30 files

export function findUsedExports(edges: ImportEdge[]): Set<string>  // imported by 30 files

export function detectCommunities(graph: ImportGraph): Community[]  // imported by 30 files

export function findChokepoints(graph: ImportGraph): Chokepoint[]  // imported by 30 files

export function computeGraphTopology(graph: ImportGraph): GraphTopology  // imported by 30 files

export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[]  // imported by 30 files

export function computeInstability(graph: ImportGraph): FileInstability[]  // imported by 30 files

export function mergeGraph(target: ImportGraph, source: ImportGraph): void  // imported by 30 files

export function estimateTokens(text: string): number  // imported by 33 files

export function deriveRole(authority: number, hubScore: number, isBarrel = false): FileRole  // imported by 30 files

export function computeBetweenness(  // imported by 30 files
  graph: ImportGraph,
  k = 50,
): Map<string, number>

export function findDeadFiles(  // imported by 30 files
  graph: ImportGraph,
  entryPoints: string[] = [],
): string[]

export function findCircularDeps(  // imported by 30 files
  graph: ImportGraph,
  maxCycles = 10,
): CircularDependency[]

export function findTightCouplings(  // imported by 30 files
  graph: ImportGraph,
  minNames = 5,
  topN = 10,
): TightCoupling[]

export async function detectBarrelFiles(  // imported by 30 files
  rootDir: string,
  fileSet: Set<string>,
): Promise<Set<string>>

export function summarizeDetection(ctx: DetectedContext): string  // imported by 10 files

export async function buildImportGraph(  // imported by 30 files
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph>

export function findCrossCuttingFiles(  // imported by 30 files
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  minLayerSpread = 3,
): CrossCuttingFile[]

export function findFeedbackEdges(  // imported by 30 files
  cycles: CircularDependency[],
  topN = 3,
): Array<{ from: string; to: string; cyclesResolved: number }>

export function computeLayerConsistency(  // imported by 30 files
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): LayerConsistency

export function checkArchitecturalFitness(  // imported by 30 files
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): ArchViolation[]

export function configToAnswers(config: ProjectConfig): UserAnswers  // imported by 5 files

export function formatBytes(bytes: number): string  // imported by 33 files

export function isDeltaEmpty(delta: ArchitectureDelta): boolean  // imported by 4 files

export function detectArchitecturalLayers(  // imported by 30 files
  graph: ImportGraph,
  customLayers?: Array<{ name: string; pattern: string }>,
): { layers: ArchitecturalLayer[]; layerEdges: LayerEdge[] }

export function patchPicocolors(): void  // imported by 24 files

export function unpatchPicocolors(): void  // imported by 24 files

export function resetTerminalColors(): void  // imported by 24 files

export function computeHITS(  // imported by 30 files
  files: string[],
  edges: ImportEdge[],
  maxIterations = 30,
  epsilon = 1e-6,
  barrelFiles?: Set<string>,
): { authority: Map<string, number>; hub: Map<string, number> }

export async function ensureDir(dirPath: string): Promise<void>  // imported by 33 files

export async function fileExists(filePath: string): Promise<boolean>  // imported by 33 files

export async function readDirSafe(dirPath: string): Promise<string[]>  // imported by 33 files

export function initTheme(mode: ColorMode): void  // imported by 24 files

export async function readFileOr(filePath: string): Promise<string | null>  // imported by 33 files

export async function loadCache(rootDir: string): Promise<CacheData | null>  // imported by 4 files

export function findStructuralTemporalMismatches(  // imported by 30 files
  graph: ImportGraph,
  changeCoupling: Array<{ fileA: string; fileB: string; confidence: number; coChangeCount: number }>,
  minConfidence = 0.4,
  minDistance = 3,
  topN = 10,
): StructuralTemporalMismatch[]

export async function writeFileSafe(filePath: string, content: string): Promise<void>  // imported by 33 files

export async function detectIDEs(rootDir: string): Promise<IDETarget[]>  // imported by 10 files

export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null>  // imported by 33 files

export function getGradientBarColors(): { from: RGB; to: RGB }  // imported by 24 files

export function detectTerminalBackground(): "dark" | "light" | null  // imported by 24 files

export function getShimmerColors(): { base: RGB; highlight: RGB }  // imported by 24 files

export function renderSnapshot(entries: SnapshotEntry[], language: Language = "typescript"): string  // imported by 14 files

export async function detectProjectDescription(rootDir: string): Promise<string | null>  // imported by 10 files

export function resetProjectNameCache(): void  // imported by 6 files

export async function loadConfig(  // imported by 5 files
  rootDir: string,
): Promise<ProjectConfig | null>

export function extractSnapshot(analysis: ContextAnalysis): AnalysisSnapshot  // imported by 4 files

export function initTreeSitter(): Promise<void>  // imported by 9 files

export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext>  // imported by 10 files

export function classifyTestType(  // imported by 6 files
  testFile: string,
  sourceImportCount: number,
): TestType

export function renderDeltaSection(  // imported by 4 files
  delta: ArchitectureDelta,
): string | null

export function renderConstraintsSection(constraints: ConfigConstraints): string | null  // imported by 5 files

export async function computeSnapshotHash(  // imported by 5 files
  rootDir: string,
  language: Language,
): Promise<string>

export function buildDeltaDirectives(  // imported by 4 files
  delta: ArchitectureDelta,
): string[]

export function renderConventionsSection(conventions: InferredConventions): string | null  // imported by 5 files

export function gradient(  // imported by 24 files
  text: string,
  from: RGB,
  to: RGB,
  fallbackFn?: (text: string) => string,
): string

export function enrichFrameworksWithUsage(  // imported by 10 files
  frameworks: DetectedFramework[],
  externalImportCounts: Map<string, number>,
): DetectedFramework[]

export async function saveCache(  // imported by 4 files
  rootDir: string,
  data: CacheData,
): Promise<void>

export function migrateConfig(  // imported by 5 files
  raw: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
): Record<string, unknown>

export async function loadPreviousSnapshot(  // imported by 4 files
  rootDir: string,
): Promise<AnalysisSnapshot | null>

export async function loadAnalysisCache(  // imported by 4 files
  rootDir: string,
): Promise<AnalysisCacheData | null>

export async function saveSnapshot(  // imported by 4 files
  rootDir: string,
  snapshot: AnalysisSnapshot,
): Promise<void>

export function computeDelta(  // imported by 4 files
  previous: AnalysisSnapshot,
  current: AnalysisSnapshot,
): ArchitectureDelta

export async function saveConfig(  // imported by 5 files
  rootDir: string,
  answers: UserAnswers,
  snapshotHash?: string,
  language?: Language,
): Promise<void>

export function shouldRebuild(filePath: string): boolean

export function extractUserSections(content: string): UserSection[]  // imported by 3 files

export async function saveAnalysisCache(  // imported by 4 files
  rootDir: string,
  data: AnalysisCacheData,
): Promise<void>

export function annotateCrossPackageEdges(
  graph: ImportGraph,
  monorepo: MonorepoInfo,
): void

export async function computeFileHashes(  // imported by 4 files
  rootDir: string,
  language: Language,
): Promise<Map<string, string>>

export async function refreshSnapshot(rootDir: string): Promise<void>

export function computeAnalysisCacheKey(  // imported by 4 files
  graph: ImportGraph,
  layersConfig?: Array<{ name: string; pattern: string }>,
): string

export async function initPreCommitHook(rootDir: string): Promise<void>

export function adaptiveDecayConstant(totalCommits: number, windowDays: number = 90): number  // imported by 4 files

export function extractFilePaths(content: string): string[]

export async function buildGraphWithCache(  // imported by 4 files
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph>

export function buildTestMapping(  // imported by 6 files
  graph: ImportGraph,
  ctx: DetectedContext,
): TestMapping | null

export function getMainContextFilename(ide: IDETarget): string  // imported by 6 files

export function trimSnapshotToChars(  // imported by 14 files
  snapshot: CodeSnapshot,
  maxChars: number,
  language: Language = "typescript",
): { markdown: string; trimmedCount: number }

export function computeLagCoupling(  // imported by 4 files
  commits: ParsedCommit[],
  couplingResults: ChangeCoupling[],
): LagCoupling[]

export function renderTestMappingSection(  // imported by 6 files
  mapping: TestMapping,
  hubFiles?: Array<{ path: string }>,
): string | null

export async function scanConfigConstraints(  // imported by 5 files
  rootDir: string,
  ctx: DetectedContext,
): Promise<ConfigConstraints>

export async function computeFileComplexity(  // imported by 10 files
  rootDir: string,
  hubFiles: HubFile[],
): Promise<FileComplexityInfo[]>

export function computeChangeCoupling(commits: ParsedCommit[], windowDays: number = 90, referenceMs?: number): ChangeCoupling[]  // imported by 4 files

export function printSummary(
  files: GeneratedFile[],
  snapshot?: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  firstRun?: boolean,
): void

export async function renderDirectivesSection(  // imported by 10 files
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  graph?: ImportGraph,
): Promise<string | null>

export async function generateSnapshot(  // imported by 14 files
  ctx: DetectedContext,
  customPaths: string[],
  graph?: ImportGraph,
  maxTokens?: number,
  onProgress?: ProgressCallback,
  gitActivity?: GitAnalysis | null,
): Promise<CodeSnapshot>

export function analyzeGitActivity(  // imported by 4 files
  rootDir: string,
  onProgress?: ProgressCallback,
  analysisDays: number = 90,
  sinceRef?: string,
): GitAnalysis | null

export function computeFileChurn(  // imported by 4 files
  rootDir: string,
  window: TimeWindow = { days: 90 },
): Map<string, { linesAdded: number; linesRemoved: number }> | null

export async function runPrompts(
  detected: DetectedContext,
  defaults?: ProjectConfig | null,
  isReconfigure = false,
): Promise<UserAnswers>

export function buildDirectives(  // imported by 10 files
  analysis: ContextAnalysis,
  ctx: DetectedContext,
  fileComplexity?: FileComplexityInfo[],
  graph?: ImportGraph,
): string[]

export function renderCursorRule(rule: CursorRule): string

export function renderClaudeSkill(skill: ClaudeSkill): string

export function mergeUserSections(newContent: string, userSections: UserSection[]): string  // imported by 3 files

export function parseImportsAst(content: string, lang: ClarteLanguage, filePath?: string): RawImport[]  // imported by 9 files

export function getFrameworkHintsSection(ctx: DetectedContext): string  // imported by 3 files

export async function inferConventions(  // imported by 5 files
  rootDir: string,
  graph: ImportGraph,
  configConstraints?: ConfigConstraints,
): Promise<InferredConventions | null>

export function scopeCircularDeps<T extends { chain: string[] }>(
  circularDeps: T[],
  changedSet: Set<string>,
  hop1Set: Set<string>,
): T[]

export async function analyzeMonorepoGraph(
  rootDir: string,
  graph: ImportGraph,
  monorepo: MonorepoInfo,
): Promise<MonorepoAnalysis>

export function startShimmer(  // imported by 3 files
  text: string,
  options?: {
    base?: RGB;
    highlight?: RGB;
    width?: number;
    indent?: string;
  },
): ShimmerHandle

export function predictChangeImpact(
  file: string,
  graph: ImportGraph,
  gitActivity: GitAnalysis | null,
): Array<{ file: string; score: number }>

export async function runWatchMode(
  rootDir: string,
  verbose: boolean,
): Promise<void>

export function serializeAnalysis(
  ctx: DetectedContext,
  analysis: ContextAnalysis,
  snapshot: CodeSnapshot | null,
  _graph: ImportGraph,
  directives: string[],
): ClarteJsonOutput

export function computePackageCentrality(
  graph: ImportGraph,
  packagePath: string,
): { authority: Map<string, number>; hub: Map<string, number> }

export function extractSnapshotAst(  // imported by 9 files
  content: string,
  relPath: string,
  lang: ClarteLanguage,
  filePath?: string,
): SnapshotEntry[]

export function detectBarrelAst(content: string, filePath?: string): {  // imported by 9 files
  isBarrel: boolean;
  reExportCount: number;
  totalStatements: number;
}

export function resolveBarrelExportsAst(content: string, filePath?: string): {  // imported by 9 files
  namedExports: Map<string, string>;
  starExports: Set<string>;
}
```
<!-- /CODE SNAPSHOT -->

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 53 | 2 hours ago |
| `README.md` | 39 | 2 days ago |
| `src/summary.ts` | 30 | 3 days ago |
| `src/templates/main-context.ts` | 28 | 2 hours ago |
| `package.json` | 25 | 33 minutes ago |
| `src/snapshot.ts` | 24 | 33 minutes ago |
| `src/types.ts` | 23 | 2 days ago |
| `package-lock.json` | 21 | 33 minutes ago |
| `src/graph.ts` | 20 | 33 minutes ago |
| `CLAUDE.md` | 17 | 2 days ago |

## Change Coupling

Files that frequently change together -- when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `src/index.ts` | `src/summary.ts` | 19 | 42% |
| `src/index.ts` | `src/templates/main-context.ts` | 20 | 41% |
| `src/generate.ts` | `src/index.ts` | 14 | 32% |
| `src/index.ts` | `src/types.ts` | 19 | 41% |
| `package-lock.json` | `package.json` | 19 | 73% |
| `src/__tests__/hooks.test.ts` | `src/hooks.ts` | 5 | 83% |
| `src/graph.ts` | `src/snapshot.ts` | 13 | 52% |
| `src/templates/main-context.ts` | `src/types.ts` | 15 | 45% |
| `src/__tests__/git-analysis.test.ts` | `src/git-analysis.ts` | 3 | 33% |
| `src/templates/aider-context.ts` | `src/templates/main-context.ts` | 11 | 39% |

## Test Coverage Map

- **Must**: When modifying `src/graph.ts`, run its tests: `src/__tests__/bench/algorithms.bench.ts` (unit), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/bench/pipeline.bench.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/eval/benchmark.test.ts` (unit), `src/__tests__/eval/eval.test.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/golden/golden.test.ts` (unit), `src/__tests__/graph-algorithms.test.ts` (unit), `src/__tests__/graph-aliases.test.ts` (unit), `src/__tests__/graph.test.ts` (unit), `src/__tests__/integration/language-pipeline.test.ts` (integration), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (unit), `src/__tests__/summary.test.ts` (integration)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/diff.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/cache.ts`, run its tests: `src/__tests__/cache.test.ts` (unit)
- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/snapshot-ts.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/animations.ts`, `src/templates/framework-hints.ts`
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
src/
  __tests__/
scripts/
docs/
```

## Dead Files

Files not imported by any other source file. Candidates for removal or missing entry points.

- `scripts/copy-wasm.js`

## Cross-Cutting Files

These files are imported across multiple architectural layers. Changes here have wide blast radius.

| File | Imported By | Layers |
|------|------------|--------|
| `src/__tests__/golden/fixtures/ts-layered/types/index.ts` | 6 files | services, types, utils |

## Architectural Chokepoints

Files whose removal would disconnect parts of the codebase. Refactor with extreme care.

| File | Separates | Imported By |
|------|-----------|-------------|
| `src/utils.ts` | 4 components | 33 files |
| `src/graph.ts` | 4 components | 30 files |
| `src/theme.ts` | 4 components | 24 files |
| `src/ast-parse.ts` | 4 components | 9 files |
| `src/git-analysis.ts` | 4 components | 4 files |
| `src/generate.ts` | 4 components | 3 files |
| `src/refresh.ts` | 4 components | 2 files |
| `src/watch.ts` | 4 components | 2 files |
| `src/hooks.ts` | 4 components | 2 files |
| `src/diff.ts` | 4 components | 2 files |

## Key Patterns

- angular commit style

## Development

```bash
npm install
npm run dev
```

```bash
npm run test
```

```bash
npm run build
```

<!-- clarte: generated 2026-02-22T20:17:02Z. Run npx clarte to regenerate. -->

<!-- clarte:user-start -->
## Style Rules

- Angular commit style
<!-- clarte:user-end -->
