import type { IDETarget, Language } from "./detection";

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
  /** Custom section ordering for context file (prefix with "-" to exclude) */
  sectionOrder?: string[];
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
  /** Custom section ordering for context file (prefix with "-" to exclude) */
  sectionOrder?: string[];
  /** Whether to generate Claude Code hooks for graph context delivery (default: true) */
  hooks?: boolean;
  /** Progressive disclosure delivery experiments */
  delivery?: {
    /** Exp 1: Generate path-scoped .claude/rules/ files with paths: frontmatter */
    scopedRules?: boolean;
    /** Exp 2: Enrich hook context-map with instability, layers, tight coupling, directives */
    enrichedHooks?: boolean;
    /** Exp 3: Move heavy sections (coupling, health, tests) into on-demand skills */
    onDemandSkills?: boolean;
  };
}
