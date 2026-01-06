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
export type Language = "typescript" | "javascript" | "python" | "go" | "rust" | "java" | "other";

/** Detected package manager */
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "cargo" | "go" | "none";

/** Detected linter/formatter */
export type Linter = "biome" | "eslint" | "prettier" | "ruff" | "black" | "rustfmt" | "gofmt" | "none";

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
