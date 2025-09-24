# clarte

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.

## What Is This

CLI tool to generate AI context files that map codebase's architecture, dependencies, and hotspots

## Tech Stack

- **Vitest** 4.0.18 (used in 9 files)
- **TypeScript**
- **npm** (package manager)

## Project Structure

```
src/
  __tests__/
```

## Code Snapshot

<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->

### Core Types

```ts
export type ProgressCallback = (message: string) => void;  // imported by 20 files

export interface LayerEdge {  // imported by 20 files
  from: string;
  to: string;
}

export interface CircularDependency {  // imported by 20 files
  /** File paths forming the cycle */
  chain: string[];
}

export type Language =  // imported by 20 files
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

export type Linter =  // imported by 20 files
  | "biome"
  | "eslint"
  | "prettier"
  | "ruff"
  | "black"
  | "rustfmt"
  | "gofmt"
  | "none";

export type PackageManager =  // imported by 20 files
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go"
  | "none";

export type IDETarget =  // imported by 20 files
  | "claude"
  | "cursor"
  | "opencode"
  | "copilot"
  | "windsurf"
  | "cline"
  | "continue"
  | "aider"
  | "generic";

export interface DetectedFramework {  // imported by 20 files
  name: string;
  version?: string;
  /** Number of files that import this framework (from import graph) */
  importCount?: number;
}

export interface MonorepoInfo {  // imported by 20 files
  /** Which monorepo tool was detected */
  type: "pnpm-workspaces" | "turborepo" | "nx";
  /** Discovered packages */
  packages: MonorepoPackage[];
}

export interface GeneratedFile {  // imported by 20 files
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

export interface Community {  // imported by 20 files
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

export interface CodeSnapshot {  // imported by 20 files
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}

export type FileRole = "Foundation" | "Orchestrator" | "Bridge" | "Utility" | "Leaf";

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
}

export interface HubFile {
  /** Relative file path */
  path: string;
  /** Centrality score (0-1), set to HITS authority */
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

export interface MonorepoPackage {  // imported by 20 files
  /** Package name from package.json */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Dependency names */
  dependencies: string[];
  /** Detected frameworks for this package */
  frameworks: DetectedFramework[];
}

export interface ExportCoverage {  // imported by 20 files
  /** Relative file path */
  file: string;
  /** Total number of named exports */
  totalExports: number;
  /** Number of exports used by other files */
  usedExports: number;
  /** Coverage ratio: usedExports / totalExports */
  coverage: number;
}

export interface FileInstability {  // imported by 20 files
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1 */
  instability: number;
}

export interface ChangeCoupling {  // imported by 20 files
  fileA: string;
  fileB: string;
  /** Number of commits both files appeared in together */
  coChangeCount: number;
  /** Fraction of commits containing either file that contain both */
  support: number;
  /** Confidence: coChangeCount / max(commitsA, commitsB) */
  confidence: number;
}

export interface ImportGraph {  // imported by 20 files
  /** All import edges */
  edges: ImportEdge[];
  /** Number of files that import each file */
  inDegree: Map<string, number>;
  /** Centrality scores (0-1), set to HITS authority */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
}

export interface ArchitecturalLayer {  // imported by 20 files
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}

export interface GitAnalysis {  // imported by 20 files
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

export interface SnapshotEntry {  // imported by 20 files
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
}

export interface ClaudeSkill {  // imported by 20 files
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

export interface ImportEdge {  // imported by 20 files
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
}

export interface CrossCuttingFile {
  file: string;
  totalImporters: number;
  layerSpread: number;
  layers: string[];
}

export interface LayerViolation {
  from: string;
  to: string;
  fromLayer: string;
  toLayer: string;
}

export interface LayerConsistency {
  consistency: number;
  violations: LayerViolation[];
}

export interface Chokepoint {
  file: string;
  separates: number;
  importedBy: number;
}

export interface InferredConventions {
  naming: { functions: string; types: string; constants: string; files: string };
  exportStyle: { preferNamed: boolean; defaultExportPercent: number; barrelFileCount: number };
  importOrdering?: string;
}

export interface TestMapping {
  sourceToTests: Map<string, string[]>;
  untestedFiles: string[];
  testPattern?: { framework: string; convention: string; filePattern: string };
}

export interface ContextAnalysis {
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  layerEdges: LayerEdge[];
  gitActivity: GitAnalysis | null;
  instabilities: FileInstability[];
  communities: Community[];
  exportCoverage?: ExportCoverage[];
  deadFiles?: string[];
  configConstraints?: ConfigConstraints;
  crossCuttingFiles?: CrossCuttingFile[];
  layerConsistency?: LayerConsistency;
  chokepoints?: Chokepoint[];
  conventions?: InferredConventions;
  testMapping?: TestMapping;
}

export interface UserAnswers {  // imported by 20 files
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

export interface ProjectConfig {  // imported by 20 files
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

export interface DetectedContext {  // imported by 20 files
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
```

### Key Functions

```ts
export function estimateTokens(text: string): number  // imported by 14 files

export function formatBytes(bytes: number): string  // imported by 14 files

export async function fileExists(filePath: string): Promise<boolean>  // imported by 14 files

export async function readDirSafe(dirPath: string): Promise<string[]>  // imported by 14 files

export async function readFileOr(filePath: string): Promise<string | null>  // imported by 14 files

export async function writeFileSafe(filePath: string, content: string): Promise<void>  // imported by 14 files

export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null>  // imported by 14 files

export function stripCommentsAndStrings(content: string, commentsOnly?: boolean): string

export function findSCCs(graph: ImportGraph): string[][]  // imported by 6 files

export function detectArchitecturalLayers(graph: ImportGraph):  // imported by 6 files

export function computeHITS(graph: ImportGraph): { authority: Map<string, number>; hub: Map<string, number> }

export function deriveRole(authority: number, hubScore: number): FileRole

export function parseJsImports(content: string): RawImport[]  // imported by 6 files

export function parseGoImports(content: string): RawImport[]  // imported by 6 files

export function parsePythonImports(content: string): RawImport[]  // imported by 6 files

export function parseRustImports(content: string): RawImport[]  // imported by 6 files

export function findUsedExports(edges: ImportEdge[]): Set<string>  // imported by 6 files

export function detectCommunities(graph: ImportGraph): Community[]  // imported by 6 files

export function summarizeDetection(ctx: DetectedContext): string  // imported by 7 files

export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[]  // imported by 6 files

export function computeExportCoverage(graph: ImportGraph): ExportCoverage[]  // imported by 6 files

export function computeInstability(graph: ImportGraph): FileInstability[]  // imported by 6 files

export function findDeadFiles( graph: ImportGraph, entryPoints: string[] = [], ): string[]  // imported by 6 files

export function findCircularDeps( graph: ImportGraph, maxCycles = 10, ): CircularDependency[]  // imported by 6 files

export function findCrossCuttingFiles(graph: ImportGraph, layers: ArchitecturalLayer[], minLayerSpread?: number): CrossCuttingFile[]

export function computeLayerConsistency(graph: ImportGraph, layers: ArchitecturalLayer[], layerEdges: LayerEdge[]): LayerConsistency

export function findChokepoints(graph: ImportGraph): Chokepoint[]

export function extractUserSections(content: string): UserSection[]

export function getFrameworkHintsSection(ctx: DetectedContext): string  // imported by 3 files

export function getFrameworkHints(ctx: DetectedContext): string[]  // imported by 3 files

export function configToAnswers(config: ProjectConfig): UserAnswers  // imported by 3 files

export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext>  // imported by 7 files

export async function buildImportGraph( rootDir: string, language: Language, onProgress?: ProgressCallback, ): Promise<ImportGraph>  // imported by 6 files

export function renderClaudeSkill(skill: ClaudeSkill): string

export function getMainContextFilename(ide: IDETarget): string

export function renderCursorRule(rule: CursorRule): string

export function mergeUserSections(newContent: string, userSections: UserSection[]): string

export async function loadConfig( rootDir: string, ): Promise<ProjectConfig | null>  // imported by 3 files

export function enrichFrameworksWithUsage( frameworks: DetectedFramework[], externalImportCounts: Map<string, number>, ): DetectedFramework[]  // imported by 7 files

export function gradient( text: string, from: RGB, to: RGB, fallbackFn?: (text: string) => string,  // imported by 4 files

export async function computeSnapshotHash( rootDir: string, language: Language, ): Promise<string>  // imported by 3 files

export async function animatePageRank(): Promise<void>

export async function refreshSnapshot(rootDir: string): Promise<void>

export async function generateFiles( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, force: boolean = false,

export async function saveConfig( rootDir: string, answers: UserAnswers, snapshotHash?: string, language?: Language,  // imported by 3 files

export async function generateSnapshot( ctx: DetectedContext, customPaths: string[], graph?: ImportGraph, maxTokens?: number,  // imported by 4 files

export async function animateLayerStack( layerNames: string[], ): Promise<void>

export async function animateCycleDetection( cycleCount: number, ): Promise<void>

export async function animateCommunities( communityCount: number, ): Promise<void>

export async function buildMainContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,

export function buildCursorRules( ctx: DetectedContext, answers: UserAnswers, analysis?: ContextAnalysis, ): CursorRule[]

export function buildClaudeSkills( ctx: DetectedContext, answers: UserAnswers, analysis?: ContextAnalysis, scripts?: Record<string, string>,

export function buildAiderContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,

export async function animateGraphBuild( _fileCount: number, _edgeCount: number, ): Promise<void>

export function analyzeGitActivity( rootDir: string, onProgress?: ProgressCallback, ): GitAnalysis | null

export function printSummary( files: GeneratedFile[], ctx: DetectedContext, snapshot?: CodeSnapshot | null, analysis?: ContextAnalysis,

export async function runPrompts( detected: DetectedContext, defaults?: ProjectConfig | null, isReconfigure = false, ): Promise<UserAnswers>
```

<!-- /CODE SNAPSHOT -->

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/types.ts` | 20 files | stable |
| `src/utils.ts` | 14 files | stable |
| `src/graph.ts` | 6 files | stable |
| `src/detect.ts` | 7 files | stable |
| `src/theme.ts` | 4 files | stable |
| `src/templates/framework-hints.ts` | 3 files | stable |
| `src/generate.ts` | 2 files | 80% unstable ⚠️ |
| `src/templates/claude-skills.ts` | 2 files | stable |

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `package.json` | 17 | 6 hours ago |
| `src/index.ts` | 16 | 6 hours ago |
| `package-lock.json` | 14 | 6 hours ago |
| `src/types.ts` | 12 | 6 hours ago |
| `CHANGELOG.md` | 11 | 2 hours ago |
| `README.md` | 11 | 6 hours ago |
| `src/templates/main-context.ts` | 9 | 16 hours ago |
| `src/summary.ts` | 8 | 17 hours ago |
| `src/config.ts` | 7 | 6 hours ago |
| `src/templates/aider-context.ts` | 7 | 6 hours ago |

## Change Coupling

Files that frequently change together — when modifying one, check if the other needs updates too.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `package-lock.json` | `package.json` | 14 | 88% |
| `src/config.ts` | `src/refresh.ts` | 5 | 83% |
| `CHANGELOG.md` | `package-lock.json` | 10 | 71% |
| `src/config.ts` | `src/templates/aider-context.ts` | 4 | 67% |
| `src/index.ts` | `src/types.ts` | 10 | 67% |
| `src/prompts.ts` | `src/templates/aider-context.ts` | 4 | 67% |
| `src/refresh.ts` | `src/templates/aider-context.ts` | 4 | 67% |
| `src/templates/main-context.ts` | `src/types.ts` | 7 | 64% |
| `CHANGELOG.md` | `package.json` | 10 | 63% |
| `src/templates/cursor-rules.ts` | `src/templates/main-context.ts` | 5 | 63% |

## Key Patterns

- Angular commit style

## Development

```bash
npm install
npm run dev
```

```bash
npm run test
```

<!-- clarte:user-start -->
## Style Rules

- Never use em dashes (—). Use commas, periods, semicolons, colons, or parentheses instead.
- Angular commit style
<!-- clarte:user-end -->
