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
}

/** User-provided answers from the interactive prompts */
export interface UserAnswers {
  /** Which IDE/tool to generate config for */
  ide: IDETarget;
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

/** Persisted project config (.context-pilot.json) */
export interface ProjectConfig {
  /** Which IDE/tool to generate config for */
  ide: IDETarget;
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

/** Extracted code snapshot entry */
export interface SnapshotEntry {
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
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
  /** PageRank-style centrality scores (0–1) */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
}
