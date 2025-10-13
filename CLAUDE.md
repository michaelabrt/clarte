# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool that pre-generates context files for AI coding agents.

## Tech Stack

- **Vitest** 4.0.18 (used in 42 files)
- **TypeScript**
- **npm** (package manager)

## Config Constraints

- **Must**: TypeScript strict mode — no implicit any, strict null checks
- **Target**: TypeScript target `ES2022`

## Working Guidelines

> Analysis-derived guidelines. Follow these when making changes.

- When modifying `src/graph.ts` (Foundation, imported by 26 files), check dependents for breaking changes.
- `src/types.ts` is a structural chokepoint (separates 4 components). Refactor with extreme care.
- `src/graph.ts` is a structural chokepoint (separates 3 components). Refactor with extreme care.
- `src/utils.ts` is a structural chokepoint (separates 2 components). Refactor with extreme care.
- `src/graph.ts` is a Foundation file with high complexity (45 exports, 2800+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/index.ts` is a Orchestrator file with high complexity (3 exports, 1300+ lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- `src/brief.ts` is a Orchestrator file with medium complexity (1 exports, 176 lines). Read thoroughly before modifying; changes are likely to have non-obvious side effects.
- When modifying `src/graph.ts`, also check: `src/brief.ts`, `src/cache.ts`, `src/monorepo-analysis.ts`, `src/utils.ts`.
- When modifying `src/utils.ts`, also check: `src/brief.ts`, `src/cache.ts`, `src/config.ts`, `src/detect.ts`.
- When modifying `src/cache.ts`, also check: `src/brief.ts`, `src/graph.ts`, `src/config.ts`, `src/detect.ts`.
- When modifying `src/watch.ts`, also check: `src/config.ts`, `src/detect.ts`, `src/graph.ts`, `src/cache.ts`.
- When modifying `src/brief.ts`, also check: `src/config.ts`, `src/detect.ts`, `src/graph.ts`, `src/cache.ts`.

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/graph.ts` (Foundation) | 26 files | stable |
| `src/index.ts` (Orchestrator) | 1 file | 96% unstable ⚠️ |
| `src/brief.ts` (Orchestrator) | 2 files | 87% unstable ⚠️ |
| `src/watch.ts` (Orchestrator) | 2 files | 83% unstable ⚠️ |
| `src/mcp-server.ts` (Orchestrator) | 1 file | 91% unstable ⚠️ |
| `src/utils.ts` (Utility) | 33 files | stable |
| `src/cache.ts` | 5 files | stable |
| `src/__tests__/bench/pipeline.bench.ts` | 0 files | stable |

## Inferred Conventions

- **Prefer**: camelCase for functions, PascalCase for types, camelCase for constants, camelCase for files
- **Prefer**: In `src/templates/`, use kebab-case for files (overrides project-wide camelCase)
- **Prefer**: Follow the `get` prefix convention for accessor functions (e.g., `getHubFiles`)
- **Prefer**: Named exports (no default exports)
- **Style**: Import ordering: external-first

## Code Snapshot

<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->

### Core Types

```ts
export type TestType = "unit" | "integration" | "e2e";  // imported by 60 files

export type RGB = [number, number, number];  // imported by 7 files

export type TimeWindow = { days: number } | { ref: string };  // imported by 5 files

export type ProgressCallback = (message: string) => void;  // imported by 60 files

export interface LayerEdge {  // imported by 60 files
  from: string;
  to: string;
}

export interface RawImport {  // imported by 26 files
  specifier: string;
  importedNames: string[];
  /** Whether this is a type-only import (import type { ... }) */
  isTypeOnly?: boolean;
  /** Whether this is a dynamic import (import('...')) */
  isDynamic?: boolean;
}

export type FileRole = "Foundation" | "Orchestrator" | "Bridge" | "Utility" | "Leaf" | "Barrel";  // imported by 60 files

export type Language =  // imported by 60 files
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

export type Linter =  // imported by 60 files
  | "biome"
  | "eslint"
  | "prettier"
  | "ruff"
  | "black"
  | "rustfmt"
  | "gofmt"
  | "none";

export type PackageManager =  // imported by 60 files
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go"
  | "none";

export type IDETarget =  // imported by 60 files
  | "claude"
  | "cursor"
  | "opencode"
  | "copilot"
  | "windsurf"
  | "cline"
  | "continue"
  | "aider"
  | "generic";

export interface PackageHubFile {  // imported by 60 files
  /** Relative file path */
  path: string;
  /** HITS authority score within the package subgraph */
  authority: number;
}

export interface DetectedFramework {  // imported by 60 files
  name: string;
  version?: string;
  /** Number of files that import this framework (from import graph) */
  importCount?: number;
}

export interface FileComplexityInfo {  // imported by 9 files
  path: string;
  exports: number;
  lines: number;
  branchPoints: number;
}

export interface MonorepoInfo {  // imported by 60 files
  /** Which monorepo tool was detected */
  type: "pnpm-workspaces" | "turborepo" | "nx";
  /** Discovered packages */
  packages: MonorepoPackage[];
}

export interface GeneratedFile {  // imported by 60 files
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

export interface Community {  // imported by 60 files
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

export interface ParsedCommit {  // imported by 5 files
  hash: string;
  date: string;
  relativeDate: string;
  message: string;
  files: string[];
}

export interface LagCoupling {  // imported by 60 files
  fileA: string;
  fileB: string;
  /** Number of same-commit co-changes */
  sameCommitCount: number;
  /** Weighted lag coupling score (inverse-lag weighted) */
  lagScore: number;
}

export interface LayerConsistency {  // imported by 60 files
  /** Fraction of cross-layer imports that follow the expected direction (0-1) */
  consistency: number;
  /** Import edges that violate the expected layer ordering */
  violations: LayerViolation[];
}

export interface LayerViolation {  // imported by 60 files
  /** File that contains the import */
  from: string;
  /** File being imported */
  to: string;
  /** Layer of the importing file */
  fromLayer: string;
  /** Layer of the imported file */
  toLayer: string;
}

export interface TightCoupling {  // imported by 60 files
  /** The file doing the importing */
  from: string;
  /** The file being imported from */
  to: string;
  /** Number of named imports */
  importedNames: number;
  /** The actual imported names */
  names: string[];
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

export interface CodeSnapshot {  // imported by 60 files
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}

export interface ContextSection {  // imported by 60 files
  /** Unique section identifier */
  id: string;
  /** Priority level: 0 = always included, 1 = highest, 10 = lowest */
  priority: number;
  /** Rendered markdown content */
  content: string;
  /** Estimated token count */
  tokens: number;
}

export interface MonorepoPackage {  // imported by 60 files
  /** Package name from package.json */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Dependency names */
  dependencies: string[];
  /** Detected frameworks for this package */
  frameworks: DetectedFramework[];
}

export interface FileInstability {  // imported by 60 files
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1 */
  instability: number;
}

export interface CircularDependency {  // imported by 60 files
  /** File paths forming the cycle */
  chain: string[];
  /** Severity 0-1: 0 = all type-only imports, 1 = all runtime imports */
  severity?: number;
  /** Suggestion for breaking the cycle (e.g. "Convert X -> Y to type-only import") */
  breakHint?: string;
}

export interface TestMapping {  // imported by 60 files
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

export interface CacheData {  // imported by 5 files
  version: number;
  createdAt: string;
  language: string;
  fileHashes: Record<string, string>;
  edges: SerializedEdge[];
  barrelFiles: string[];
}

export interface CrossCuttingFile {  // imported by 60 files
  /** Relative file path */
  file: string;
  /** Total number of files that import this file */
  totalImporters: number;
  /** Number of distinct architectural layers importing this file */
  layerSpread: number;
  /** Which layers import this file */
  layers: string[];
}

export interface StructuralTemporalMismatch {  // imported by 60 files
  fileA: string;
  fileB: string;
  /** BFS shortest path distance in the import graph (-1 if unreachable) */
  graphDistance: number;
  /** Co-change confidence from git analysis */
  coChangeConfidence: number;
  /** Number of co-changes */
  coChangeCount: number;
}

export interface ChangeCoupling {  // imported by 60 files
  fileA: string;
  fileB: string;
  /** Number of commits both files appeared in together */
  coChangeCount: number;
  /** Fraction of commits containing either file that contain both */
  support: number;
  /** Confidence: coChangeCount / max(commitsA, commitsB) */
  confidence: number;
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

export interface Chokepoint {  // imported by 60 files
  /** Relative file path */
  file: string;
  /** Number of disconnected components if this file were removed */
  separates: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Files that would be disconnected from the main component if this file were removed */
  dependents?: string[];
}

export interface ArchitecturalLayer {  // imported by 60 files
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}

export interface CrossPackageEdge {  // imported by 60 files
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

export interface TransitiveDependencyRisk {  // imported by 60 files
  /** Relative file path */
  path: string;
  /** Direct volatility (own churn normalized 0-1) */
  directVolatility: number;
  /** Weighted transitive volatility from dependencies */
  transitiveVolatility: number;
  /** Composite risk score: directVolatility * 0.3 + transitiveVolatility * 0.7 */
  riskScore: number;
}

export interface ArchViolation {  // imported by 60 files
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

export interface SnapshotEntry {  // imported by 60 files
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
}

export interface ClaudeSkill {  // imported by 60 files
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

export interface GraphTopology {  // imported by 60 files
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

export interface MonorepoAnalysis {  // imported by 60 files
  /** Import edges crossing package boundaries */
  crossPackageEdges: CrossPackageEdge[];
  /** Encapsulation violations (imports of internal files) */
  encapsulationViolations: CrossPackageEdge[];
  /** Dependencies between packages (package name -> set of dependent package names) */
  packageDependencies: Map<string, Set<string>>;
  /** Top hub files per package (package name -> top files by authority) */
  packageHubFiles?: Map<string, PackageHubFile[]>;
}

export interface HubFile {  // imported by 60 files
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

export interface ConfigConstraints {  // imported by 60 files
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

export interface GitAnalysis {  // imported by 60 files
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

export interface ImportEdge {  // imported by 60 files
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

export interface InferredConventions {  // imported by 60 files
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

export interface ShimmerHandle {
  /** Stop the shimmer and clear the line */
  stop: () => void;
  /** Update the shimmer text mid-animation */
  message: (text: string) => void;
}

export interface ImportGraph {  // imported by 60 files
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
export function findSCCs(graph: ImportGraph): string[][]  // imported by 26 files

export function estimateTokens(text: string): number  // imported by 33 files

export function parseJsImports(content: string): RawImport[]  // imported by 26 files

export function parseGoImports(content: string): RawImport[]  // imported by 26 files

export function parsePythonImports(content: string): RawImport[]  // imported by 26 files

export function parseRustImports(content: string): RawImport[]  // imported by 26 files

export function parseJavaImports(content: string): RawImport[]  // imported by 26 files

export function findUsedExports(edges: ImportEdge[]): Set<string>  // imported by 26 files

export function detectCommunities(graph: ImportGraph): Community[]  // imported by 26 files

export function findChokepoints(graph: ImportGraph): Chokepoint[]  // imported by 26 files

export function computeGraphTopology(graph: ImportGraph): GraphTopology  // imported by 26 files

export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[]  // imported by 26 files

export function computeInstability(graph: ImportGraph): FileInstability[]  // imported by 26 files

export function stripCommentsAndStrings(content: string, commentsOnly = false): string  // imported by 26 files

export function computeBetweenness( graph: ImportGraph, k = 50, ): Map<string, number>  // imported by 26 files

export function deriveRole(authority: number, hubScore: number, isBarrel = false): FileRole  // imported by 26 files

export function findDeadFiles( graph: ImportGraph, entryPoints: string[] = [], ): string[]  // imported by 26 files

export function findCircularDeps( graph: ImportGraph, maxCycles = 10, ): CircularDependency[]  // imported by 26 files

export function configToAnswers(config: ProjectConfig): UserAnswers  // imported by 6 files

export function bfsShortestPath( graph: ImportGraph, from: string, to: string, ): string[] | null  // imported by 26 files

export function findTightCouplings( graph: ImportGraph, minNames = 5, topN = 10, ): TightCoupling[]  // imported by 26 files

export function computeHITS( files: string[], edges: ImportEdge[], maxIterations = 30, epsilon = 1e-6,  // imported by 26 files

export function summarizeDetection(ctx: DetectedContext): string  // imported by 11 files

export async function detectBarrelFiles( rootDir: string, fileSet: Set<string>, ): Promise<Set<string>>  // imported by 26 files

export function formatBytes(bytes: number): string  // imported by 33 files

export function computeTransitiveRisk( graph: ImportGraph, commitCounts: Map<string, number>, maxDepth = 5, topN = 15,  // imported by 26 files

export function detectArchitecturalLayers( graph: ImportGraph, customLayers?: Array<{ name: string; pattern: string }>, ):  // imported by 26 files

export function isDeltaEmpty(delta: ArchitectureDelta): boolean  // imported by 4 files

export async function buildImportGraph( rootDir: string, language: Language, onProgress?: ProgressCallback, ): Promise<ImportGraph>  // imported by 26 files

export function findCrossCuttingFiles( graph: ImportGraph, layers: ArchitecturalLayer[], minLayerSpread = 3, ): CrossCuttingFile[]  // imported by 26 files

export function computeLayerConsistency( graph: ImportGraph, layers: ArchitecturalLayer[], layerEdges: LayerEdge[], ): LayerConsistency  // imported by 26 files

export function checkArchitecturalFitness( graph: ImportGraph, layers: ArchitecturalLayer[], layerEdges: LayerEdge[], ): ArchViolation[]  // imported by 26 files

export async function ensureDir(dirPath: string): Promise<void>  // imported by 33 files

export function resetProjectNameCache(): void  // imported by 7 files

export async function fileExists(filePath: string): Promise<boolean>  // imported by 33 files

export async function readDirSafe(dirPath: string): Promise<string[]>  // imported by 33 files

export async function readFileOr(filePath: string): Promise<string | null>  // imported by 33 files

export async function writeFileSafe(filePath: string, content: string): Promise<void>  // imported by 33 files

export function findStructuralTemporalMismatches( graph: ImportGraph, changeCoupling: Array<{ fileA: string; fileB: string; confidence: number; coChangeCount: number }>, minConfidence = 0.4, minDistance = 3,  // imported by 26 files

export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null>  // imported by 33 files

export function renderConstraintsSection(constraints: ConfigConstraints): string | null  // imported by 7 files

export function renderConventionsSection(conventions: InferredConventions): string | null  // imported by 7 files

export function classifyTestType( testFile: string, sourceImportCount: number, ): TestType  // imported by 7 files

export async function loadConfig( rootDir: string, ): Promise<ProjectConfig | null>  // imported by 6 files

export async function loadCache(rootDir: string): Promise<CacheData | null>  // imported by 5 files

export async function installHooks(): Promise<void>

export function getShimmerColors():  // imported by 7 files

export function getGradientBarColors():  // imported by 7 files

export async function computeSnapshotHash( rootDir: string, language: Language, ): Promise<string>  // imported by 6 files

export function extractSnapshot(analysis: ContextAnalysis): AnalysisSnapshot  // imported by 4 files

export async function saveColorScheme( rootDir: string, colorScheme: "dark" | "light", ): Promise<void>  // imported by 6 files

export function annotateCrossPackageEdges( graph: ImportGraph, monorepo: MonorepoInfo, ): void  // imported by 3 files

export function renderDeltaSection( delta: ArchitectureDelta, ): string | null  // imported by 4 files

export function buildDeltaDirectives( delta: ArchitectureDelta, ): string[]  // imported by 4 files

export async function saveConfig( rootDir: string, answers: UserAnswers, snapshotHash?: string, language?: Language,  // imported by 6 files

export function initTheme(mode: ColorMode): void  // imported by 7 files

export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext>  // imported by 11 files

export function migrateConfig( raw: Record<string, unknown>, fromVersion: number, toVersion: number, ): Record<string, unknown>  // imported by 6 files

export function getMainContextFilename(ide: IDETarget): string  // imported by 7 files

export async function loadPreviousSnapshot( rootDir: string, ): Promise<AnalysisSnapshot | null>  // imported by 4 files

export function computeDelta( previous: AnalysisSnapshot, current: AnalysisSnapshot, ): ArchitectureDelta  // imported by 4 files

export function startShimmer( text: string, options?:

export async function saveSnapshot( rootDir: string, snapshot: AnalysisSnapshot, ): Promise<void>  // imported by 4 files

export async function generateSnapshot( ctx: DetectedContext, customPaths: string[], graph?: ImportGraph, maxTokens?: number,  // imported by 13 files

export function computeFileChurn( rootDir: string, window: TimeWindow =  // imported by 5 files

export function enrichFrameworksWithUsage( frameworks: DetectedFramework[], externalImportCounts: Map<string, number>, ): DetectedFramework[]  // imported by 11 files

export function shouldRebuild(filePath: string): boolean

export function applyBudget( sections: ContextSection[], budget: number, ):  // imported by 7 files

export async function saveCache( rootDir: string, data: CacheData, ): Promise<void>  // imported by 5 files

export async function uninstallHooks(): Promise<void>

export function adaptiveDecayConstant(totalCommits: number, windowDays: number = 90): number  // imported by 5 files

export function buildTestMapping( graph: ImportGraph, ctx: DetectedContext, ): TestMapping | null  // imported by 7 files

export async function scanConfigConstraints( rootDir: string, ctx: DetectedContext, ): Promise<ConfigConstraints>  // imported by 7 files

export function extractFilePaths(content: string): string[]

export function computePackageCentrality( graph: ImportGraph, packagePath: string, ):  // imported by 3 files

export function extractUserSections(content: string): UserSection[]

export function computeChangeCoupling(commits: ParsedCommit[], windowDays: number = 90): ChangeCoupling[]  // imported by 5 files

export function renderTestMappingSection( mapping: TestMapping, hubFiles?: Array<{ path: string }>, ): string | null  // imported by 7 files

export function computeLagCoupling( commits: ParsedCommit[], couplingResults: ChangeCoupling[], ): LagCoupling[]  // imported by 5 files

export async function refreshSnapshot(rootDir: string): Promise<void>

export async function computeFileHashes( rootDir: string, language: Language, ): Promise<Map<string, string>>  // imported by 5 files

export function gradient( text: string, from: RGB, to: RGB, fallbackFn?: (text: string) => string,  // imported by 7 files

export async function initPreCommitHook(rootDir: string): Promise<void>

export function analyzeGitActivity( rootDir: string, onProgress?: ProgressCallback, analysisDays: number = 90, sinceRef?: string,  // imported by 5 files

export async function buildGraphWithCache( rootDir: string, language: Language, onProgress?: ProgressCallback, ): Promise<ImportGraph>  // imported by 5 files

export async function buildSections( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,  // imported by 7 files

export async function inferConventions( rootDir: string, graph: ImportGraph, configConstraints?: ConfigConstraints, ): Promise<InferredConventions | null>  // imported by 7 files

export async function buildMainContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,  // imported by 7 files

export async function analyzeMonorepoGraph( rootDir: string, graph: ImportGraph, monorepo: MonorepoInfo, ): Promise<MonorepoAnalysis>  // imported by 3 files

export async function withShimmer<T>( text: string, work: Promise<T>, options?:

export function createDebounce<T>( fn: (items: T[]) => void,

export function serializeAnalysis( ctx: DetectedContext, analysis: ContextAnalysis, snapshot: CodeSnapshot | null, _graph: ImportGraph,

export async function computeFileComplexity( rootDir: string, hubFiles: HubFile[], ): Promise<FileComplexityInfo[]>  // imported by 9 files

export async function runBriefMode( rootDir: string, budget: number = DEFAULT_BRIEF_BUDGET, _verbose: boolean = false, ): Promise<void>

export function printSummary( files: GeneratedFile[], ctx: DetectedContext, snapshot?: CodeSnapshot | null, analysis?: ContextAnalysis,

export async function runPrompts( detected: DetectedContext, defaults?: ProjectConfig | null, isReconfigure = false, ): Promise<UserAnswers>

export function predictChangeImpact( file: string, graph: ImportGraph, gitActivity: GitAnalysis | null, ): Array<{ file: string; score: number }>

export function renderClaudeSkill(skill: ClaudeSkill): string

export function renderCursorRule(rule: CursorRule): string

export function buildDirectives( analysis: ContextAnalysis, ctx: DetectedContext, fileComplexity?: FileComplexityInfo[], graph?: ImportGraph,  // imported by 9 files

export async function renderDirectivesSection( analysis: ContextAnalysis, ctx: DetectedContext, graph?: ImportGraph, ): Promise<string | null>  // imported by 9 files

export function getFrameworkHintsSection(ctx: DetectedContext): string  // imported by 3 files

export async function runWatchMode( rootDir: string, verbose: boolean, ): Promise<void>

export function mergeUserSections(newContent: string, userSections: UserSection[]): string

export async function validateContextPaths( rootDir: string, config: ProjectConfig, ): Promise<{ broken: string[]; file: string } | null>

export async function generateFiles( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, force: boolean = false,

export function getFrameworkHints(ctx: DetectedContext): string[]  // imported by 3 files

export async function buildAiderContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,

export function queryLayers( analysis: ContextAnalysis, ):
```

<!-- /CODE SNAPSHOT -->

## Test Coverage Map

- **Must**: When modifying `src/graph.ts`, run its tests: `src/__tests__/bench/algorithms.bench.ts` (unit), `src/__tests__/bench/graph-generator.ts` (unit), `src/__tests__/bench/pipeline.bench.ts` (unit), `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/eval/eval.test.ts` (unit), `src/__tests__/eval/helpers.ts` (unit), `src/__tests__/graph-algorithms.test.ts` (unit), `src/__tests__/graph-aliases.test.ts` (unit), `src/__tests__/graph.test.ts` (unit), `src/__tests__/p3-quickwins.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-oxc.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/structural-analysis.test.ts` (unit)
- **Must**: When modifying `src/index.ts`, run its tests: `src/__tests__/diff-relevance.test.ts` (unit)
- **Must**: When modifying `src/brief.ts`, run its tests: `src/__tests__/brief.test.ts` (unit)
- **Must**: When modifying `src/watch.ts`, run its tests: `src/__tests__/watch.test.ts` (unit)
- **Must**: When modifying `src/mcp-server.ts`, run its tests: `src/__tests__/mcp-server.test.ts` (unit)
- **Must**: When modifying `src/utils.ts`, run its tests: `src/__tests__/code-quality.test.ts` (integration), `src/__tests__/config-scan.test.ts` (integration), `src/__tests__/conventions.test.ts` (integration), `src/__tests__/snapshot-depth.test.ts` (integration), `src/__tests__/snapshot-go.test.ts` (integration), `src/__tests__/snapshot-java.test.ts` (integration), `src/__tests__/snapshot-oxc.test.ts` (integration), `src/__tests__/snapshot-python.test.ts` (integration), `src/__tests__/snapshot-rust.test.ts` (integration), `src/__tests__/utils.test.ts` (unit)
- **Must**: When modifying `src/cache.ts`, run its tests: `src/__tests__/cache.test.ts` (unit)
- **Prefer**: Add tests for uncovered files: `src/animations.ts`, `src/prompts.ts`, `src/refresh.ts`, `src/summary.ts`, `src/templates/cursor-rules.ts`, `src/templates/framework-hints.ts`, `src/theme.ts`
- **Style**: Test convention: co-located .test files (`*.test.{ts,tsx,js,jsx}`)

## Project Structure

```
src/
  __tests__/
docs/
```

## Architectural Chokepoints

Files whose removal would disconnect parts of the codebase. Refactor with extreme care.

| File | Separates | Imported By |
|------|-----------|-------------|
| `src/types.ts` | 4 components | 60 files |
| `src/graph.ts` | 3 components | 26 files |
| `src/utils.ts` | 2 components | 33 files |
| `src/git-analysis.ts` | 2 components | 5 files |
| `src/cache.ts` | 2 components | 5 files |
| `src/hooks.ts` | 2 components | 2 files |
| `src/watch.ts` | 2 components | 2 files |
| `src/generate.ts` | 2 components | 2 files |
| `src/deep-analysis.ts` | 2 components | 2 files |
| `src/brief.ts` | 2 components | 2 files |

## Tight Coupling

File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.

- `src/graph.ts` imports 20 names from `src/types.ts`
- `src/index.ts` imports 14 names from `src/graph.ts`
- `src/brief.ts` imports 13 names from `src/graph.ts`
- `src/mcp-server.ts` imports 13 names from `src/graph.ts`
- `src/watch.ts` imports 13 names from `src/graph.ts`
- `src/__tests__/bench/pipeline.bench.ts` imports 12 names from `src/graph.ts`
- `src/mcp-server.ts` imports 9 names from `src/types.ts`
- `src/__tests__/graph-algorithms.test.ts` imports 9 names from `src/graph.ts`
- `src/__tests__/mcp-server.test.ts` imports 9 names from `src/mcp-server.ts`
- `src/cache.ts` imports 8 names from `src/graph.ts`

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

<!-- clarte:user-start -->
## Style Rules

- Never use em dashes (—). Use commas, periods, semicolons, colons, or parentheses instead.
- Angular commit style
<!-- clarte:user-end -->
