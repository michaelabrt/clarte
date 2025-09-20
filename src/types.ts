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
  type: "pnpm-workspaces" | "turborepo" | "nx";
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
}

/** Full import graph for a project */
export interface ImportGraph {
  /** All import edges */
  edges: ImportEdge[];
  /** Number of files that import each file */
  inDegree: Map<string, number>;
  /** PageRank-style centrality scores (0-1) */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
}

/** A highly-connected file identified by centrality analysis */
export interface HubFile {
  /** Relative file path */
  path: string;
  /** PageRank centrality score (0-1) */
  centrality: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Number of internal files this file imports */
  imports: number;
}

/** A detected circular dependency chain */
export interface CircularDependency {
  /** File paths forming the cycle */
  chain: string[];
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

/** Export coverage metric for a file */
export interface ExportCoverage {
  /** Relative file path */
  file: string;
  /** Total number of named exports */
  totalExports: number;
  /** Number of exports used by other files */
  usedExports: number;
  /** Coverage ratio: usedExports / totalExports */
  coverage: number;
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
  /** Export coverage metrics per file */
  exportCoverage?: ExportCoverage[];
}
