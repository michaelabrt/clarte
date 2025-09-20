# Codebrief

> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.
> Scoped rules are in `.cursor/rules/` -- update them when conventions change.

## What Is This

CLI tool that generates optimized AI context files

## Tech Stack

- **Vitest** 4.0.18 (used in 5 files)
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
export type ProgressCallback = (message: string) => void;  // imported by 17 files

export interface LayerEdge {  // imported by 17 files
  from: string;
  to: string;
}

export interface CircularDependency {  // imported by 17 files
  /** File paths forming the cycle */
  chain: string[];
}

export type Language =  // imported by 17 files
  | "typescript"
  | "javascript"
  | "python"
  | "go"
  | "rust"
  | "java"
  | "other";

export type Linter =  // imported by 17 files
  | "biome"
  | "eslint"
  | "prettier"
  | "ruff"
  | "black"
  | "rustfmt"
  | "gofmt"
  | "none";

export type PackageManager =  // imported by 17 files
  | "npm"
  | "pnpm"
  | "yarn"
  | "bun"
  | "pip"
  | "poetry"
  | "cargo"
  | "go"
  | "none";

export type IDETarget =  // imported by 17 files
  | "claude"
  | "cursor"
  | "opencode"
  | "copilot"
  | "windsurf"
  | "cline"
  | "continue"
  | "aider"
  | "generic";

export interface DetectedFramework {  // imported by 17 files
  name: string;
  version?: string;
  /** Number of files that import this framework (from import graph) */
  importCount?: number;
}

export interface MonorepoInfo {  // imported by 17 files
  /** Which monorepo tool was detected */
  type: "pnpm-workspaces" | "turborepo" | "nx";
  /** Discovered packages */
  packages: MonorepoPackage[];
}

export interface GeneratedFile {  // imported by 17 files
  /** Relative path from project root */
  path: string;
  /** File contents */
  content: string;
  /** Whether this file already existed */
  existed: boolean;
}

export interface Community {  // imported by 17 files
  /** Auto-assigned numeric ID */
  id: number;
  /** Files in this community */
  files: string[];
  /** Auto-derived label from common directory prefix */
  label: string;
}

export interface CodeSnapshot {  // imported by 17 files
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}

export interface HubFile {  // imported by 17 files
  /** Relative file path */
  path: string;
  /** PageRank centrality score (0-1) */
  centrality: number;
  /** Number of files that import this file */
  importedBy: number;
  /** Number of internal files this file imports */
  imports: number;
}

export interface MonorepoPackage {  // imported by 17 files
  /** Package name from package.json */
  name: string;
  /** Relative path from project root */
  path: string;
  /** Dependency names */
  dependencies: string[];
  /** Detected frameworks for this package */
  frameworks: DetectedFramework[];
}

export interface ExportCoverage {  // imported by 17 files
  /** Relative file path */
  file: string;
  /** Total number of named exports */
  totalExports: number;
  /** Number of exports used by other files */
  usedExports: number;
  /** Coverage ratio: usedExports / totalExports */
  coverage: number;
}

export interface FileInstability {  // imported by 17 files
  /** Relative file path */
  path: string;
  /** Number of incoming dependencies */
  fanIn: number;
  /** Number of outgoing dependencies */
  fanOut: number;
  /** Instability score: fanOut / (fanIn + fanOut), range 0-1 */
  instability: number;
}

export interface ChangeCoupling {  // imported by 17 files
  fileA: string;
  fileB: string;
  /** Number of commits both files appeared in together */
  coChangeCount: number;
  /** Fraction of commits containing either file that contain both */
  support: number;
  /** Confidence: coChangeCount / max(commitsA, commitsB) */
  confidence: number;
}

export interface ImportGraph {  // imported by 17 files
  /** All import edges */
  edges: ImportEdge[];
  /** Number of files that import each file */
  inDegree: Map<string, number>;
  /** PageRank-style centrality scores (0-1) */
  centrality: Map<string, number>;
  /** How many files import each external package */
  externalImportCounts: Map<string, number>;
}

export interface ArchitecturalLayer {  // imported by 17 files
  /** Layer name (e.g. "types", "stores", "hooks", "components", "pages") */
  name: string;
  /** Files belonging to this layer */
  files: string[];
  /** Number of other layers that import this layer */
  importedByLayers: number;
  /** Names of layers this layer depends on (imports from) */
  dependsOn: string[];
}

export interface GitAnalysis {  // imported by 17 files
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

export interface ImportEdge {  // imported by 17 files
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

export interface SnapshotEntry {  // imported by 17 files
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
}

export interface ClaudeSkill {  // imported by 17 files
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

export interface ContextAnalysis {  // imported by 17 files
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

export interface UserAnswers {  // imported by 17 files
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

export interface ProjectConfig {  // imported by 17 files
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
}

export interface DetectedContext {  // imported by 17 files
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
export function estimateTokens(text: string): number  // imported by 11 files

export function formatBytes(bytes: number): string  // imported by 11 files

export const theme =  // imported by 4 files

export async function fileExists(filePath: string): Promise<boolean>  // imported by 11 files

export async function readDirSafe(dirPath: string): Promise<string[]>  // imported by 11 files

export async function readFileOr(filePath: string): Promise<string | null>  // imported by 11 files

export async function writeFileSafe(filePath: string, content: string): Promise<void>  // imported by 11 files

export async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null>  // imported by 11 files

export function findSCCs(graph: ImportGraph): string[][]  // imported by 5 files

export function detectArchitecturalLayers(graph: ImportGraph):  // imported by 5 files

export function parseJsImports(content: string): RawImport[]  // imported by 5 files

export function parseGoImports(content: string): RawImport[]  // imported by 5 files

export function parsePythonImports(content: string): RawImport[]  // imported by 5 files

export function parseRustImports(content: string): RawImport[]  // imported by 5 files

export function findUsedExports(edges: ImportEdge[]): Set<string>  // imported by 5 files

export function detectCommunities(graph: ImportGraph): Community[]  // imported by 5 files

export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[]  // imported by 5 files

export function computeExportCoverage(graph: ImportGraph): ExportCoverage[]  // imported by 5 files

export function summarizeDetection(ctx: DetectedContext): string  // imported by 6 files

export function computeInstability(graph: ImportGraph): FileInstability[]  // imported by 5 files

export function findCircularDeps( graph: ImportGraph, maxCycles = 10, ): CircularDependency[]  // imported by 5 files

export function getFrameworkHintsSection(ctx: DetectedContext): string  // imported by 3 files

export function getFrameworkHints(ctx: DetectedContext): string[]  // imported by 3 files

export async function buildImportGraph( rootDir: string, language: Language, onProgress?: ProgressCallback, ): Promise<ImportGraph>  // imported by 5 files

export function renderClaudeSkill(skill: ClaudeSkill): string

export async function detectContext(rootDir: string, onProgress?: ProgressCallback): Promise<DetectedContext>  // imported by 6 files

export function getMainContextFilename(ide: IDETarget): string

export function gradient( text: string, from: RGB, to: RGB, fallbackFn?: (text: string) =>  // imported by 4 files

export function renderCursorRule(rule: CursorRule): string

export function configToAnswers(config: ProjectConfig): UserAnswers

export function enrichFrameworksWithUsage( frameworks: DetectedFramework[], externalImportCounts: Map<string, number>, ): DetectedFramework[]  // imported by 6 files

export async function animatePageRank(): Promise<void>

export async function refreshSnapshot(rootDir: string): Promise<void>

export async function loadConfig( rootDir: string, ): Promise<ProjectConfig | null>

export async function computeSnapshotHash( rootDir: string, language: Language, ): Promise<string>

export async function animateLayerStack( layerNames: string[], ): Promise<void>

export async function generateSnapshot( ctx: DetectedContext, customPaths: string[], graph?: ImportGraph, maxTokens?: number,  // imported by 3 files

export async function animateCycleDetection( cycleCount: number, ): Promise<void>

export async function animateCommunities( communityCount: number, ): Promise<void>

export async function saveConfig( rootDir: string, answers: UserAnswers, snapshotHash?: string, language?: Language,

export function buildClaudeSkills( ctx: DetectedContext, answers: UserAnswers, analysis?: ContextAnalysis, scripts?: Record<string, string>,

export function buildCursorRules( ctx: DetectedContext, answers: UserAnswers, analysis?: ContextAnalysis, ): CursorRule[]

export function buildMainContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,

export async function runPrompts( detected: DetectedContext, defaults?: ProjectConfig | null, ): Promise<UserAnswers>

export async function animateGraphBuild( _fileCount: number, _edgeCount: number, ): Promise<void>

export function analyzeGitActivity( rootDir: string, onProgress?: ProgressCallback, ): GitAnalysis | null

export function printSummary( files: GeneratedFile[], ctx: DetectedContext, snapshot?: CodeSnapshot | null, analysis?: ContextAnalysis,

export async function generateFiles( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, force: boolean = false,

export function buildAiderContext( ctx: DetectedContext, answers: UserAnswers, snapshot: CodeSnapshot | null, analysis?: ContextAnalysis,
```

<!-- /CODE SNAPSHOT -->

## Key Files

These are the most interconnected files. Read these first for architectural understanding.

| File | Imported By | Stability |
|------|-------------|-----------|
| `src/types.ts` | 17 files | stable |
| `src/utils.ts` | 11 files | stable |
| `src/graph.ts` | 5 files | stable |
| `src/theme.ts` | 4 files | stable |
| `src/detect.ts` | 6 files | stable |
| `src/templates/framework-hints.ts` | 3 files | stable |
| `src/templates/claude-skills.ts` | 2 files | stable |
| `src/snapshot.ts` | 3 files | stable |

## Recently Active Files

| File | Commits (90d) | Last Changed |
|------|--------------|--------------|
| `src/index.ts` | 13 | 3 hours ago |
| `package.json` | 11 | 3 hours ago |
| `package-lock.json` | 9 | 3 hours ago |
| `src/types.ts` | 9 | 4 hours ago |
| `README.md` | 7 | 33 minutes ago |
| `src/summary.ts` | 7 | 3 hours ago |
| `src/templates/main-context.ts` | 7 | 4 hours ago |
| `src/detect.ts` | 6 | 3 hours ago |
| `src/graph.ts` | 6 | 3 hours ago |
| `src/snapshot.ts` | 6 | 3 hours ago |

## Change Coupling

Files that frequently change together. Consider whether they should be colocated or decoupled.

| File A | File B | Co-changes | Confidence |
|--------|--------|------------|------------|
| `package-lock.json` | `package.json` | 9 | 82% |
| `src/templates/main-context.ts` | `src/types.ts` | 7 | 78% |
| `src/config.ts` | `src/refresh.ts` | 3 | 75% |
| `src/config.ts` | `src/templates/aider-context.ts` | 3 | 75% |
| `src/prompts.ts` | `src/templates/aider-context.ts` | 3 | 75% |
| `src/refresh.ts` | `src/templates/aider-context.ts` | 3 | 75% |
| `src/detect.ts` | `src/templates/main-context.ts` | 5 | 71% |
| `src/index.ts` | `src/types.ts` | 8 | 62% |
| `src/graph.ts` | `src/snapshot.ts` | 3 | 60% |
| `README.md` | `src/prompts.ts` | 4 | 57% |

## Module Clusters

Automatically detected groups of tightly-connected files.

- **src** (23 files): `src/__tests__/claude-skills.test.ts`, `src/__tests__/graph-algorithms.test.ts`, `src/__tests__/graph.test.ts`, `src/__tests__/utils.test.ts`, `src/animations.ts`, `src/config.ts`, `src/detect.ts`, `src/generate.ts`, `src/git-analysis.ts`, `src/graph.ts`, `src/index.ts`, `src/prompts.ts`, `src/refresh.ts`, `src/snapshot.ts`, `src/summary.ts`, `src/templates/aider-context.ts`, `src/templates/claude-skills.ts`, `src/templates/cursor-rules.ts`, `src/templates/framework-hints.ts`, `src/templates/main-context.ts`, `src/theme.ts`, `src/types.ts`, `src/utils.ts`

## Key Patterns

- Angular conventional commits

## Development

```bash
npm install
npm run dev
```
