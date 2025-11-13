/** Functional role derived from HITS authority/hub scores */
export type FileRole = "Foundation" | "Orchestrator" | "Bridge" | "Utility" | "Leaf" | "Barrel";

/** Extracted constraints from tsconfig, linter, and formatter configs */
export interface ConfigConstraints {
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

/** Supported AI IDE/tool targets */
export type IDETarget =
  | "claude"
  | "cursor"
  | "opencode"
  | "copilot"
  | "windsurf"
  | "cline"
  | "continue"
  | "aider"
  | "generic";

/** Detected programming language */
export type Language =
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

/** Detected package manager */
export type PackageManager =
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go"
  | "none";

/** Detected linter/formatter */
export type Linter =
  | "biome"
  | "eslint"
  | "prettier"
  | "ruff"
  | "black"
  | "rustfmt"
  | "gofmt"
  | "none";

/** A detected framework or major library */
export interface DetectedFramework {
  name: string;
  version?: string;
  /** Number of files that import this framework (from import graph) */
  importCount?: number;
}

/** Monorepo package info */
export interface MonorepoPackage {
  /** Package name from package.json */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Dependency names */
  dependencies: string[];
  /** Detected frameworks for this package */
  frameworks: DetectedFramework[];
}

/** Monorepo detection result */
export interface MonorepoInfo {
  /** Which monorepo tool was detected */
  type: "pnpm-workspaces" | "turborepo" | "nx" | "npm-workspaces";
  /** Discovered packages */
  packages: MonorepoPackage[];
}

/** Result of auto-detecting a project's tech stack */
export interface DetectedContext {
  /** Root directory being analyzed */
  rootDir: string;
  /** Primary language */
  language: Language;
  /** Whether TypeScript is used (for JS projects) */
  hasTypeScript: boolean;
  /** Package manager detected */
  packageManager: PackageManager;
  /** Linter/formatter detected */
  linter: Linter;
  /** Frameworks and major libraries detected */
  frameworks: DetectedFramework[];
  /** Key directories found (relative to root) */
  directories: string[];
  /** All dependency names (for framework detection) */
  dependencies: string[];
  /** Whether this is a git repository */
  isGitRepo: boolean;
  /** Total size of source files in bytes (for token estimation) */
  totalSourceBytes: number;
  /** Number of source files found */
  sourceFileCount: number;
  /** Monorepo info (null if not a monorepo) */
  monorepo: MonorepoInfo | null;
  /** Detected testing framework (e.g. "Vitest", "Jest") */
  testFramework?: string;
  /** Detected CI provider (e.g. "GitHub Actions") */
  ciProvider?: string;
  /** Secondary languages with >15% of source files */
  secondaryLanguages?: Language[];
  /** File count per language */
  languageBreakdown?: Record<string, number>;
  /** Non-fatal warnings collected during detection (e.g. parse failures, ambiguous detection) */
  warnings?: string[];
}

/** User-provided answers from the interactive prompts */
export interface UserAnswers {
  /** Which IDE/tools to generate config for */
  ides: IDETarget[];
  /** User's description of the project (1-2 sentences) */
  projectPurpose: string;
  /** Key patterns and conventions described by user */
  keyPatterns: string;
  /** Critical gotchas or anti-patterns */
  gotchas: string;
  /** Whether to generate code snapshots */
  generateSnapshot: boolean;
  /** Custom paths to scan for snapshots (empty = auto-detect) */
  snapshotPaths: string[];
  /** Whether the user confirmed the detected stack is correct */
  stackConfirmed: boolean;
  /** User corrections to detected stack (free text, empty if confirmed) */
  stackCorrections: string;
  /** Whether to generate per-package context files in a monorepo */
  generatePerPackage: boolean;
  /** Custom architectural layer patterns (name + regex string) */
  layers?: Array<{ name: string; pattern: string }>;
}

/** Persisted project config (.clarte.json) */
export interface ProjectConfig {
  /** Which IDE/tools to generate config for */
  ides: IDETarget[];
  /** @deprecated Old single-IDE field for backward compatibility when loading old configs */
  ide?: IDETarget;
  /** User's description of the project */
  projectPurpose: string;
  /** Key patterns and conventions */
  keyPatterns: string;
  /** Critical gotchas or anti-patterns */
  gotchas: string;
  /** Whether to generate code snapshots */
  generateSnapshot: boolean;
  /** Custom paths to scan for snapshots */
  snapshotPaths: string[];
  /** User corrections to detected stack */
  stackCorrections: string;
  /** Whether to generate per-package context files */
  generatePerPackage: boolean;
  /** Hash of source files at last snapshot generation */
  snapshotHash?: string;
  /** Timestamp of last snapshot generation */
  snapshotGeneratedAt?: number;
  /** Detected language (for --check fast path) */
  language?: Language;
  /** Number of days before snapshot is considered stale (default: 7) */
  staleDays?: number;
  /** Terminal color scheme preference */
  colorScheme?: "dark" | "light";
  /** Custom architectural layer patterns (name + regex string) */
  layers?: Array<{ name: string; pattern: string }>;
  /** Number of days to analyze in git history (default: 90) */
  analysisDays?: number;
  /** Auto-refresh context on pre-commit if stale */
  autoRefreshOnCommit?: boolean;
}

/** A generated file ready to be written */
export interface GeneratedFile {
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

/** Progress callback for reporting sub-step progress */
export type ProgressCallback = (message: string) => void;

/** Extracted code snapshot entry */
export interface SnapshotEntry {
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
}

/** Full code snapshot result */
export interface CodeSnapshot {
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}

/** A single import edge in the project graph */
export interface ImportEdge {
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

/** Full import graph for a project */
export interface ImportGraph {
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

/** A highly-connected file identified by HITS analysis */
export interface HubFile {
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

/** A detected circular dependency chain */
export interface CircularDependency {
  /** File paths forming the cycle */
  chain: string[];
  /** Severity 0-1: 0 = all type-only imports, 1 = all runtime imports */
  severity?: number;
  /** Suggestion for breaking the cycle (e.g. "Convert X -> Y to type-only import") */
  breakHint?: string;
}

/** Instability metric (Robert C. Martin) for a file */
export interface FileInstability {
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1 */
  instability: number;
}

/** Co-change coupling between two files */
export interface ChangeCoupling {
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

/** A detected community/cluster of tightly-connected files */
export interface Community {
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

/** A directed edge between two architectural layers */
export interface LayerEdge {
  from: string;
  to: string;
}

/** A detected architectural layer (e.g. types, stores, hooks) */
export interface ArchitecturalLayer {
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}

/** Lag-adjusted temporal coupling (files that change within 1-3 commits of each other) */
export interface LagCoupling {
  fileA: string;
  fileB: string;
  /** Number of same-commit co-changes */
  sameCommitCount: number;
  /** Weighted lag coupling score (inverse-lag weighted) */
  lagScore: number;
}

/** Git activity analysis results */
export interface GitAnalysis {
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

/** A Claude Code skill definition */
export interface ClaudeSkill {
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

/** A file imported across multiple architectural layers */
export interface CrossCuttingFile {
  /** Relative file path */
  file: string;
  /** Total number of files that import this file */
  totalImporters: number;
  /** Number of distinct architectural layers importing this file */
  layerSpread: number;
  /** Which layers import this file */
  layers: string[];
}

/** A layer dependency violation (import flowing upward) */
export interface LayerViolation {
  /** File that contains the import */
  from: string;
  /** File being imported */
  to: string;
  /** Layer of the importing file */
  fromLayer: string;
  /** Layer of the imported file */
  toLayer: string;
}

/** Layer dependency consistency result */
export interface LayerConsistency {
  /** Fraction of cross-layer imports that follow the expected direction (0-1) */
  consistency: number;
  /** Import edges that violate the expected layer ordering */
  violations: LayerViolation[];
}

/** An articulation point (chokepoint) in the import graph */
export interface Chokepoint {
  /** Relative file path */
  file: string;
  /** Number of disconnected components if this file were removed */
  separates: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Files that would be disconnected from the main component if this file were removed */
  dependents?: string[];
}

/** Inferred coding conventions from source analysis */
export interface InferredConventions {
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

/** File pair that co-changes frequently but is structurally distant */
export interface StructuralTemporalMismatch {
  fileA: string;
  fileB: string;
  /** BFS shortest path distance in the import graph (-1 if unreachable) */
  graphDistance: number;
  /** Co-change confidence from git analysis */
  coChangeConfidence: number;
  /** Number of co-changes */
  coChangeCount: number;
}

/** File pair with high import specificity (many named imports) */
export interface TightCoupling {
  /** The file doing the importing */
  from: string;
  /** The file being imported from */
  to: string;
  /** Number of named imports */
  importedNames: number;
  /** The actual imported names */
  names: string[];
}

/** Graph topology metrics (connected components, diameter, reachability) */
export interface GraphTopology {
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

/** Classification of test file type */
export type TestType = "unit" | "integration" | "e2e";

/** Test-to-source file mapping */
export interface TestMapping {
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

/** A rendered section of the context file with priority and token estimate */
export interface ContextSection {
  /** Unique section identifier */
  id: string;
  /** Priority level: 0 = always included, 1 = highest, 10 = lowest */
  priority: number;
  /** Rendered markdown content */
  content: string;
  /** Estimated token count */
  tokens: number;
}

/** A cross-package import edge in a monorepo */
export interface CrossPackageEdge {
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

/** Top hub file within a package, derived from per-package HITS */
export interface PackageHubFile {
  /** Relative file path */
  path: string;
  /** HITS authority score within the package subgraph */
  authority: number;
}

/** Monorepo-specific analysis results */
export interface MonorepoAnalysis {
  /** Import edges crossing package boundaries */
  crossPackageEdges: CrossPackageEdge[];
  /** Encapsulation violations (imports of internal files) */
  encapsulationViolations: CrossPackageEdge[];
  /** Dependencies between packages (package name -> set of dependent package names) */
  packageDependencies: Map<string, Set<string>>;
  /** Top hub files per package (package name -> top files by authority) */
  packageHubFiles?: Map<string, PackageHubFile[]>;
}

/** An architectural fitness violation */
export interface ArchViolation {
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

/** Bundle of all structural analysis results */
export interface ContextAnalysis {
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  /** Directed edges between architectural layers */
  layerEdges: LayerEdge[];
  gitActivity: GitAnalysis | null;
  /** Instability scores for files */
  instabilities: FileInstability[];
  /** Detected module clusters/communities */
  communities: Community[];
  /** Files with zero in-degree (not imported by anything) */
  deadFiles?: string[];
  /** Extracted config constraints (tsconfig, linter, formatter) */
  configConstraints?: ConfigConstraints;
  /** Files imported across multiple architectural layers */
  crossCuttingFiles?: CrossCuttingFile[];
  /** Layer dependency consistency score and violations */
  layerConsistency?: LayerConsistency;
  /** Architectural chokepoints (articulation points) */
  chokepoints?: Chokepoint[];
  /** Inferred coding conventions (naming, export style, import ordering) */
  conventions?: InferredConventions;
  /** Test-to-source file mapping */
  testMapping?: TestMapping;
  /** Graph topology metrics */
  graphTopology?: GraphTopology;
  /** File pairs that co-change frequently but are structurally distant */
  structuralMismatches?: StructuralTemporalMismatch[];
  /** File pairs with high import specificity (tight coupling) */
  tightCouplings?: TightCoupling[];
  /** Monorepo-specific analysis (cross-package edges, encapsulation violations) */
  monorepoAnalysis?: MonorepoAnalysis;
  /** Change impact predictions for hub files (file -> top affected files with RRF scores) */
  changeImpact?: Map<string, Array<{ file: string; score: number }>>;
  /** Architectural fitness violations */
  archViolations?: ArchViolation[];
}
