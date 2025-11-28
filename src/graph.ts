import path from "node:path";
import { glob } from "tinyglobby";
import { readFileOr, readJsonFile } from "./utils.js";
import { initTreeSitter, parseImportsAst, detectBarrelAst, resolveBarrelExportsAst } from "./ast-parse.js";
import type {
  ArchitecturalLayer,
  ArchViolation,
  Chokepoint,
  CircularDependency,
  Community,
  CrossCuttingFile,
  FileInstability,
  FileRole,
  GraphTopology,
  HubFile,
  ImportEdge,
  ImportGraph,
  Language,
  LayerConsistency,
  LayerEdge,
  LayerViolation,
  ProgressCallback,
  StructuralTemporalMismatch,
  TightCoupling,
} from "./types.js";

// ── Import parsing (delegated to ast-parse.ts) ───────────────────────

// ── File extensions to try when resolving relative imports ────────────

/**
 * Resolution priority: .ts > .tsx > .js > .jsx > .mjs
 * When both foo.ts and foo.tsx exist, .ts wins deterministically
 * because it appears first in this array and we return on first match.
 */
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const INDEX_FILES = JS_EXTENSIONS.map((e) => `/index${e}`);

// ── tsconfig path alias resolution ─────────────────────────────────────

interface PathAlias {
  /** The alias prefix (e.g. "@/", "@components/") */
  prefix: string;
  /** The replacement path (relative to rootDir) */
  replacement: string;
}

/**
 * Load path aliases from tsconfig.json, following `extends` chains up to 5 levels.
 * Returns an array of PathAlias objects for resolving aliased imports.
 */
async function loadTsconfigPaths(rootDir: string): Promise<PathAlias[]> {
  let configPath = path.join(rootDir, "tsconfig.json");
  let baseUrl = ".";
  let paths: Record<string, string[]> = {};

  for (let depth = 0; depth < 5; depth++) {
    const config = await readJsonFile(configPath);
    if (!config) break;

    const co = config.compilerOptions as Record<string, unknown> | undefined;
    if (co?.baseUrl && typeof co.baseUrl === "string") baseUrl = co.baseUrl;
    if (co?.paths && typeof co.paths === "object") {
      // Child config wins over parent — only set if not already set by child
      const configPaths = co.paths as Record<string, string[]>;
      for (const [key, value] of Object.entries(configPaths)) {
        if (!(key in paths)) {
          paths[key] = value;
        }
      }
    }

    const ext = config.extends as string | undefined;
    if (!ext) break;

    // Resolve relative extends paths
    configPath = path.resolve(path.dirname(configPath), ext);
    if (!configPath.endsWith(".json")) configPath += ".json";
  }

  // Convert to PathAlias array
  const aliases: PathAlias[] = [];
  for (const [pattern, mappings] of Object.entries(paths)) {
    if (!mappings || mappings.length === 0) continue;
    // Only support wildcard patterns: "@/*" -> ["src/*"]
    if (pattern.endsWith("/*") && mappings[0].endsWith("/*")) {
      const prefix = pattern.slice(0, -1); // "@/" from "@/*"
      const target = mappings[0].slice(0, -1); // "src/" from "src/*"
      const replacement = path.join(baseUrl, target).replace(/\\/g, "/");
      aliases.push({ prefix, replacement });
    } else if (!pattern.includes("*")) {
      // Exact alias: "utils" -> ["src/utils"]
      aliases.push({ prefix: pattern, replacement: path.join(baseUrl, mappings[0]).replace(/\\/g, "/") });
    }
  }

  return aliases;
}

/**
 * Try to resolve a path alias import to an actual file path.
 */
function resolveAliasImport(
  specifier: string,
  aliases: PathAlias[],
  allFiles: Set<string>,
): string | null {
  for (const alias of aliases) {
    if (specifier.startsWith(alias.prefix)) {
      const remainder = specifier.slice(alias.prefix.length);
      const raw = (alias.replacement + remainder).replace(/\\/g, "/");
      // Try the same resolution as relative imports
      const stripped = raw.replace(/\.(jsx?|mjs)$/, "");
      const bases = stripped !== raw ? [raw, stripped] : [raw];

      for (const base of bases) {
        if (allFiles.has(base)) return base;
        for (const ext of JS_EXTENSIONS) {
          if (allFiles.has(base + ext)) return base + ext;
        }
        for (const idx of INDEX_FILES) {
          if (allFiles.has(base + idx)) return base + idx;
        }
      }
    }
  }
  return null;
}

// ── Language-specific source file globs ───────────────────────────────

function getSourceGlob(lang: Language): string[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return ["**/*.{ts,tsx,js,jsx,mjs}"];
    case "python":
      return ["**/*.py"];
    case "go":
      return ["**/*.go"];
    case "rust":
      return ["**/*.rs"];
    case "java":
      return ["**/*.java"];
    default:
      return ["**/*.{ts,tsx,js,jsx,py,go,rs,java}"];
  }
}

// ── Parse imports from a single file (delegated to ast-parse.ts) ─────

// Re-export RawImport from ast-parse for backward compatibility
export type { RawImport } from "./ast-parse.js";
type RawImport = import("./ast-parse.js").RawImport;

/** Re-export individual language parsers for backward compatibility with tests */
export function parseJsImports(content: string): RawImport[] {
  return parseImportsAst(content, "typescript");
}

export function parsePythonImports(content: string): RawImport[] {
  return parseImportsAst(content, "python");
}

export function parseGoImports(content: string): RawImport[] {
  return parseImportsAst(content, "go");
}

export function parseRustImports(content: string): RawImport[] {
  return parseImportsAst(content, "rust");
}

export function parseJavaImports(content: string): RawImport[] {
  return parseImportsAst(content, "java");
}

function parseImports(content: string, lang: Language, filePath?: string): RawImport[] {
  return parseImportsAst(content, lang, filePath);
}

// ── Resolve relative imports to file paths ────────────────────────────

function isRelativeSpecifier(spec: string, lang: Language): boolean {
  if (lang === "typescript" || lang === "javascript") {
    return spec.startsWith("./") || spec.startsWith("../");
  }
  if (lang === "python") {
    return spec.startsWith(".");
  }
  if (lang === "go") {
    // All Go imports attempt resolution first; stdlib/third-party fall through
    return true;
  }
  if (lang === "rust") {
    return spec.startsWith("crate::") || spec.startsWith("super::") || spec.startsWith("self::") || spec.startsWith("mod::");
  }
  if (lang === "java") {
    // All Java imports attempt resolution first; unresolved fall through to external
    return true;
  }
  return spec.startsWith("./") || spec.startsWith("../");
}

/**
 * Try to resolve a JS/TS relative import to an actual file path.
 * Returns the resolved relative path or null.
 */
function resolveJsImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  const dir = path.dirname(fromFile);
  const raw = path.join(dir, specifier).replace(/\\/g, "/");

  // Try with original path, then with JS extension stripped (TS ESM convention:
  // source uses `.js` specifiers but actual files are `.ts`)
  const stripped = raw.replace(/\.(jsx?|mjs)$/, "");
  const bases = stripped !== raw ? [raw, stripped] : [raw];

  for (const base of bases) {
    if (allFiles.has(base)) return base;
    for (const ext of JS_EXTENSIONS) {
      if (allFiles.has(base + ext)) return base + ext;
    }
    for (const idx of INDEX_FILES) {
      if (allFiles.has(base + idx)) return base + idx;
    }
  }

  return null;
}

/**
 * Load the Go module path from go.mod.
 * Returns the module path (e.g. "myapp" or "github.com/user/repo") or null.
 */
async function loadGoModule(rootDir: string): Promise<string | null> {
  const content = await readFileOr(path.join(rootDir, "go.mod"));
  if (!content) return null;
  const match = content.match(/^module\s+(\S+)/m);
  return match ? match[1] : null;
}

/**
 * Try to resolve a Go import to a file path.
 * Go imports are package-level: "myapp/internal/handler" resolves to any .go file
 * in that directory. We return the first match (stable via sort).
 */
function resolveGoImport(
  specifier: string,
  goModulePath: string,
  allFiles: Set<string>,
): string | null {
  // Only resolve imports that start with the module path
  if (specifier !== goModulePath && !specifier.startsWith(goModulePath + "/")) {
    return null;
  }
  // Strip module path prefix to get the relative package directory
  const relDir = specifier === goModulePath ? "" : specifier.slice(goModulePath.length + 1);

  // Find all .go files in that directory (not subdirectories)
  const candidates: string[] = [];
  for (const file of allFiles) {
    const dir = path.dirname(file).replace(/\\/g, "/");
    if (dir === relDir && file.endsWith(".go")) {
      candidates.push(file);
    }
  }

  if (candidates.length === 0) return null;
  // Return first alphabetically for determinism
  candidates.sort();
  return candidates[0];
}

/**
 * Try to resolve a Python relative import to a file path.
 */
function resolvePythonImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.dirname(fromFile);
  // Count leading dots
  let dots = 0;
  while (specifier[dots] === ".") dots++;
  const modulePath = specifier.slice(dots).replace(/\./g, "/");
  let baseDir = dir;
  for (let i = 1; i < dots; i++) {
    baseDir = path.dirname(baseDir);
  }
  const base = modulePath ? path.join(baseDir, modulePath).replace(/\\/g, "/") : baseDir;

  // Try as file
  if (allFiles.has(base + ".py")) return base + ".py";
  // Try as package
  if (allFiles.has(base + "/__init__.py")) return base + "/__init__.py";

  return null;
}

/**
 * Detect Java source root prefixes from the file list.
 * Looks for common patterns like "src/main/java/" or "src/".
 */
function detectJavaSourceRoots(allFiles: string[]): string[] {
  const roots = new Set<string>();
  for (const file of allFiles) {
    if (!file.endsWith(".java")) continue;
    // Maven/Gradle convention
    const mavenIdx = file.indexOf("src/main/java/");
    if (mavenIdx >= 0) {
      roots.add(file.slice(0, mavenIdx + "src/main/java/".length));
      continue;
    }
    const testIdx = file.indexOf("src/test/java/");
    if (testIdx >= 0) {
      roots.add(file.slice(0, testIdx + "src/test/java/".length));
      continue;
    }
    // Simple "src/" convention
    const srcIdx = file.indexOf("src/");
    if (srcIdx >= 0) {
      roots.add(file.slice(0, srcIdx + "src/".length));
      continue;
    }
  }
  // Fallback: try root directory
  if (roots.size === 0) roots.add("");
  return [...roots];
}

/**
 * Try to resolve a Java import (e.g. "com.example.model.User") to a file path.
 * Converts dots to path separators and tries each source root.
 */
function resolveJavaImport(
  specifier: string,
  allFiles: Set<string>,
  sourceRoots: string[],
): string | null {
  // Wildcard import: com.example.model.* -- skip, too ambiguous for single edge
  if (specifier.endsWith(".*")) {
    const dirPath = specifier.slice(0, -2).replace(/\./g, "/");
    // Find the first .java file in the package directory
    for (const root of sourceRoots) {
      for (const file of allFiles) {
        if (file.startsWith(root + dirPath + "/") && file.endsWith(".java")) {
          const afterDir = file.slice((root + dirPath + "/").length);
          if (!afterDir.includes("/")) return file;
        }
      }
    }
    return null;
  }

  // Regular import: com.example.model.User -> com/example/model/User.java
  const filePath = specifier.replace(/\./g, "/") + ".java";
  for (const root of sourceRoots) {
    const candidate = root + filePath;
    if (allFiles.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Try to resolve a Rust use path or mod declaration to a file path.
 * Handles crate::, super::, self::, and mod:: (synthetic prefix for mod declarations).
 */
function resolveRustImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  // Detect crate root (directory containing lib.rs or main.rs)
  let crateRoot = "src";
  for (const f of allFiles) {
    if (f.endsWith("/lib.rs") || f === "src/lib.rs" || f.endsWith("/main.rs") || f === "src/main.rs") {
      crateRoot = path.dirname(f).replace(/\\/g, "/");
      break;
    }
  }

  // mod:: prefix: synthetic for `mod foo;` declarations
  if (specifier.startsWith("mod::")) {
    const modName = specifier.slice("mod::".length);
    return resolveRustModDecl(modName, fromFile, allFiles);
  }

  // Strip scoped import list: "crate::types::{A, B}" -> "crate::types"
  let cleanSpec = specifier;
  const braceIdx = cleanSpec.indexOf("::{");
  if (braceIdx >= 0) {
    cleanSpec = cleanSpec.slice(0, braceIdx);
  }

  if (cleanSpec.startsWith("crate::")) {
    // crate::models::user::User -> strip "crate::", strip trailing item, map :: to /
    const segments = cleanSpec.slice("crate::".length).split("::");
    return resolveRustModulePath(crateRoot, segments, allFiles);
  }

  if (cleanSpec.startsWith("super::")) {
    const fromDir = path.dirname(fromFile).replace(/\\/g, "/");
    const parent = path.dirname(fromDir).replace(/\\/g, "/");
    const segments = cleanSpec.slice("super::".length).split("::");
    return resolveRustModulePath(parent, segments, allFiles);
  }

  if (cleanSpec.startsWith("self::")) {
    const fromDir = path.dirname(fromFile).replace(/\\/g, "/");
    const segments = cleanSpec.slice("self::".length).split("::");
    return resolveRustModulePath(fromDir, segments, allFiles);
  }

  return null;
}

/**
 * Resolve a Rust mod declaration: `mod foo;` -> find foo.rs or foo/mod.rs
 * relative to the declaring file's directory.
 */
function resolveRustModDecl(
  modName: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  const fromDir = path.dirname(fromFile).replace(/\\/g, "/");
  // Try sibling file: src/models.rs
  const asFile = `${fromDir}/${modName}.rs`;
  if (allFiles.has(asFile)) return asFile;
  // Try directory module: src/models/mod.rs
  const asMod = `${fromDir}/${modName}/mod.rs`;
  if (allFiles.has(asMod)) return asMod;
  return null;
}

/**
 * Resolve a Rust module path (segments after crate::/super::/self::) to a file.
 * Tries progressively shorter segment lists to find the module file,
 * since the last segment(s) may be item names rather than module paths.
 */
function resolveRustModulePath(
  baseDir: string,
  segments: string[],
  allFiles: Set<string>,
): string | null {
  // Try full path first, then progressively drop trailing segments (item names)
  for (let len = segments.length; len >= 1; len--) {
    const modPath = segments.slice(0, len).join("/");
    // Try as file: base/models/user.rs
    const asFile = `${baseDir}/${modPath}.rs`;
    if (allFiles.has(asFile)) return asFile;
    // Try as directory module: base/models/user/mod.rs
    const asMod = `${baseDir}/${modPath}/mod.rs`;
    if (allFiles.has(asMod)) return asMod;
  }
  return null;
}

interface ResolveContext {
  goModulePath?: string | null;
  javaSourceRoots?: string[];
}

function resolveImport(
  specifier: string,
  fromFile: string,
  lang: Language,
  allFiles: Set<string>,
  ctx: ResolveContext = {},
): string | null {
  switch (lang) {
    case "typescript":
    case "javascript": {
      // Try tsconfig path aliases first for non-relative specifiers
      if (pathAliases && !specifier.startsWith("./") && !specifier.startsWith("../")) {
        const resolved = resolvePathAlias(specifier, allFiles, pathAliases);
        if (resolved) return resolved;
      }
      return resolveJsImport(specifier, fromFile, allFiles);
    }
    case "python":
      return resolvePythonImport(specifier, fromFile, allFiles);
    case "go":
      return ctx.goModulePath
        ? resolveGoImport(specifier, ctx.goModulePath, allFiles)
        : null;
    case "java":
      return resolveJavaImport(specifier, allFiles, ctx.javaSourceRoots ?? []);
    case "rust":
      return resolveRustImport(specifier, fromFile, allFiles);
    default:
      return null;
  }
}

// ── Barrel file (re-export) resolution ────────────────────────────────

/** Barrel file export mapping: tracks which names come from which source files */
interface BarrelExportMap {
  /** barrel file -> { exportedName -> source file } */
  namedExports: Map<string, Map<string, string>>;
  /** barrel file -> set of files re-exported with `export *` (names unknown) */
  starExports: Map<string, Set<string>>;
}

/**
 * Scan barrel files (index.ts, etc.) and build a map from barrel path to
 * the source files and exported names they re-export.
 */
async function resolveBarrelFiles(
  rootDir: string,
  fileSet: Set<string>,
): Promise<BarrelExportMap> {
  const namedExports = new Map<string, Map<string, string>>();
  const starExports = new Map<string, Set<string>>();

  for (const file of fileSet) {
    const basename = path.basename(file).replace(/\.[^.]+$/, "");
    if (basename !== "index") continue;

    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const { namedExports: barrelNamed, starExports: barrelStars } = resolveBarrelExportsAst(content, file);
    const nameMap = new Map<string, string>();
    const starSet = new Set<string>();

    for (const [exportedName, specifier] of barrelNamed) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = resolveJsImport(specifier, file, fileSet);
      if (resolved) nameMap.set(exportedName, resolved);
    }

    for (const specifier of barrelStars) {
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;
      const resolved = resolveJsImport(specifier, file, fileSet);
      if (resolved) starSet.add(resolved);
    }

    if (nameMap.size > 0) namedExports.set(file, nameMap);
    if (starSet.size > 0) starExports.set(file, starSet);
  }

  return { namedExports, starExports };
}

/**
 * Detect barrel files: files where >50% of top-level statements are re-exports.
 * Returns a Set of relative file paths identified as barrels.
 */
export async function detectBarrelFiles(
  rootDir: string,
  fileSet: Set<string>,
): Promise<Set<string>> {
  const barrels = new Set<string>();

  for (const file of fileSet) {
    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const result = detectBarrelAst(content, file);
    if (result.isBarrel) {
      barrels.add(file);
    }
  }

  return barrels;
}

// ── HITS (Kleinberg) centrality ───────────────────────────────────────

/**
 * Compute HITS authority and hub scores for all files.
 *
 * Edge weight: (1 - typeOnlyDiscount) * dynamicDiscount * specificity
 * - typeOnlyDiscount = 0.7 if isTypeOnly, else 0
 * - dynamicDiscount = 0.5 if isDynamic, else 1.0
 * - specificity = log2(importedNames.length + 1) / log2(6), clamped min 0.2
 *
 * Barrel file correction: edges targeting barrel files contribute 0.3x authority.
 *
 * Uses teleportation smoothing (alpha=0.15) to avoid extreme score distributions
 * in star-shaped graphs. Hub update uses prior-iteration authority (standard HITS).
 */
export function computeHITS(
  files: string[],
  edges: ImportEdge[],
  maxIterations = 30,
  epsilon = 1e-6,
  barrelFiles?: Set<string>,
): { authority: Map<string, number>; hub: Map<string, number> } {
  const n = files.length;
  if (n === 0) return { authority: new Map(), hub: new Map() };

  const fileSet = new Set(files);
  const barrels = barrelFiles ?? new Set<string>();
  const alpha = 0.15; // teleportation smoothing factor
  const baseScore = 1 / n;

  // Build weighted adjacency lists (internal edges only)
  // forward: from -> [{to, weight}]   (for hub update)
  // reverse: to -> [{from, weight}]   (for authority update)
  const forward = new Map<string, Array<{ to: string; weight: number }>>();
  const reverse = new Map<string, Array<{ from: string; weight: number }>>();
  for (const file of files) {
    forward.set(file, []);
    reverse.set(file, []);
  }

  for (const edge of edges) {
    if (edge.isExternal) continue;
    if (!fileSet.has(edge.from) || !fileSet.has(edge.to)) continue;

    const typeOnlyDiscount = edge.isTypeOnly ? 0.7 : 0;
    const dynamicDiscount = edge.isDynamic ? 0.5 : 1.0;
    const nameCount = edge.importedNames.length;
    const specificity = nameCount > 0
      ? Math.max(0.2, Math.log2(nameCount + 1) / Math.log2(6))
      : 0.2;
    let weight = (1 - typeOnlyDiscount) * dynamicDiscount * specificity;

    // Barrel file authority discount: edges targeting barrels contribute less
    if (barrels.has(edge.to)) {
      weight *= 0.3;
    }

    forward.get(edge.from)!.push({ to: edge.to, weight });
    reverse.get(edge.to)!.push({ from: edge.from, weight });
  }

  // Initialize
  let auth = new Float64Array(n).fill(1);
  let hub = new Float64Array(n).fill(1);
  const fileIndex = new Map<string, number>();
  for (let i = 0; i < n; i++) fileIndex.set(files[i], i);

  // Iterate
  for (let iter = 0; iter < maxIterations; iter++) {
    const newAuth = new Float64Array(n);
    const newHub = new Float64Array(n);

    // Update authorities with teleportation:
    // newAuth[v] = alpha * baseScore + (1 - alpha) * Σ hub[u] * w(u->v)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { from, weight } of reverse.get(file)!) {
        sum += hub[fileIndex.get(from)!] * weight;
      }
      newAuth[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // Update hubs with teleportation (using PRIOR auth, not newAuth):
    // newHub[v] = alpha * baseScore + (1 - alpha) * Σ auth[w] * w(v->w)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { to, weight } of forward.get(file)!) {
        sum += auth[fileIndex.get(to)!] * weight;
      }
      newHub[vi] = alpha * baseScore + (1 - alpha) * sum;
    }

    // L2 normalize
    let authNorm = 0;
    let hubNorm = 0;
    for (let i = 0; i < n; i++) {
      authNorm += newAuth[i] * newAuth[i];
      hubNorm += newHub[i] * newHub[i];
    }
    authNorm = Math.sqrt(authNorm) || 1;
    hubNorm = Math.sqrt(hubNorm) || 1;
    for (let i = 0; i < n; i++) {
      newAuth[i] /= authNorm;
      newHub[i] /= hubNorm;
    }

    // Convergence check
    let maxDelta = 0;
    for (let i = 0; i < n; i++) {
      maxDelta = Math.max(maxDelta, Math.abs(newAuth[i] - auth[i]) + Math.abs(newHub[i] - hub[i]));
    }

    auth = newAuth;
    hub = newHub;

    if (maxDelta < epsilon) break;
  }

  // Min-max normalize to 0-1
  let authMin = Infinity, authMax = -Infinity;
  let hubMin = Infinity, hubMax = -Infinity;
  for (let i = 0; i < n; i++) {
    if (auth[i] < authMin) authMin = auth[i];
    if (auth[i] > authMax) authMax = auth[i];
    if (hub[i] < hubMin) hubMin = hub[i];
    if (hub[i] > hubMax) hubMax = hub[i];
  }
  const authRange = authMax - authMin || 1;
  const hubRange = hubMax - hubMin || 1;

  const authorityMap = new Map<string, number>();
  const hubMap = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    authorityMap.set(files[i], (auth[i] - authMin) / authRange);
    hubMap.set(files[i], (hub[i] - hubMin) / hubRange);
  }

  return { authority: authorityMap, hub: hubMap };
}

/**
 * Derive a functional role from HITS authority and hub scores.
 * If isBarrel is true, the file always gets the "Barrel" role (checked before thresholds).
 *
 * Thresholds (0.6, 0.3, 0.4) are empirically tuned for typical project distributions
 * after min-max normalization of HITS scores. Boundary instability is expected in
 * small graphs (<10 files) where score ranges compress.
 *
 * @see docs/algorithm-tuning.md
 */
export function deriveRole(authority: number, hubScore: number, isBarrel = false): FileRole {
  if (isBarrel) return "Barrel";
  if (authority > 0.6 && hubScore < 0.3) return "Foundation";
  if (hubScore > 0.6 && authority < 0.3) return "Orchestrator";
  if (authority > 0.4 && hubScore > 0.4) return "Bridge";
  if (authority >= 0.3 && authority <= 0.6 && hubScore < 0.3) return "Utility";
  return "Leaf";
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build the import graph for a project.
 */
export async function buildImportGraph(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph> {
  await initTreeSitter();
  const globs = getSourceGlob(language);
  let files: string[];
  try {
    files = await glob(globs, {
      cwd: rootDir,
      ignore: [
        "**/node_modules/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/target/**",
        "**/vendor/**",
        "**/__pycache__/**",
        "**/venv/**",
        "**/.venv/**",
        "**/.Trash/**",
        "**/Library/**",
        "**/.git/**",
      ],
      absolute: false,
    });
  } catch (err: unknown) {
    // Gracefully degrade on permission errors (e.g. scanning ~/ on macOS)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      onProgress?.("Warning: permission error scanning files, returning empty graph");
      return { edges: [], inDegree: new Map(), directInDegree: new Map(), centrality: new Map(), externalImportCounts: new Map(), authority: new Map(), hubScores: new Map() };
    }
    throw err;
  }

  onProgress?.(`Found ${files.length} source files to analyze`);

  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const inDegree = new Map<string, number>();
  const directInDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  // Load path aliases for TS/JS projects
  const pathAliases = (language === "typescript" || language === "javascript")
    ? await loadTsconfigPaths(rootDir)
    : [];
  if (pathAliases.length > 0) {
    onProgress?.(`Loaded ${pathAliases.length} path alias(es) from tsconfig`);
  }

  // Load language-specific resolution context
  const resolveCtx: ResolveContext = {};
  if (language === "go") {
    resolveCtx.goModulePath = await loadGoModule(rootDir);
    if (resolveCtx.goModulePath) {
      onProgress?.(`Go module: ${resolveCtx.goModulePath}`);
    }
  }
  if (language === "java") {
    resolveCtx.javaSourceRoots = detectJavaSourceRoots(files);
    if (resolveCtx.javaSourceRoots.length > 0) {
      onProgress?.(`Java source root${resolveCtx.javaSourceRoots.length === 1 ? "" : "s"}: ${resolveCtx.javaSourceRoots.join(", ")}`);
    }
  }

  // Resolve barrel file re-exports for JS/TS projects
  let barrelMap: BarrelExportMap = { namedExports: new Map(), starExports: new Map() };
  if (isJsTs) {
    barrelMap = await resolveBarrelFiles(rootDir, fileSet);
    const barrelCount = barrelMap.namedExports.size + barrelMap.starExports.size;
    if (barrelCount > 0) {
      onProgress?.(`Resolved ${barrelCount} barrel file${barrelCount === 1 ? "" : "s"}`);
    }
  }

  // Init in-degree
  for (const file of files) {
    inDegree.set(file, 0);
    directInDegree.set(file, 0);
  }

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if ((i + 1) % 50 === 0 || i === files.length - 1) {
      onProgress?.(`Parsing imports... ${i + 1}/${files.length} files`);
    }

    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const rawImports = parseImports(content, language);

    for (const raw of rawImports) {
      const isRelative = isRelativeSpecifier(raw.specifier, language);

      if (isRelative) {
        const resolved = resolveImport(raw.specifier, file, language, fileSet, resolveCtx);
        if (resolved) {
          const barrelNamed = barrelMap.namedExports.get(resolved);
          const barrelStars = barrelMap.starExports.get(resolved);

          if (barrelNamed || barrelStars) {
            // Barrel import: route each name to its actual source file
            const routedNames = new Map<string, string[]>();
            const unresolved: string[] = [];

            for (const name of raw.importedNames) {
              const source = barrelNamed?.get(name);
              if (source) {
                const existing = routedNames.get(source) ?? [];
                existing.push(name);
                routedNames.set(source, existing);
              } else {
                unresolved.push(name);
              }
            }

            // Create edges to resolved source files (barrel-routed)
            for (const [source, names] of routedNames) {
              edges.push({
                from: file,
                to: source,
                isExternal: false,
                specifier: raw.specifier,
                importedNames: names,
                isTypeOnly: raw.isTypeOnly,
                isDynamic: raw.isDynamic,
                isBarrelRouted: true,
              });
              inDegree.set(source, (inDegree.get(source) ?? 0) + 1);
            }

            // Unresolved names (could be from star exports): create edges to star sources
            if (unresolved.length > 0 && barrelStars) {
              for (const starSource of barrelStars) {
                edges.push({
                  from: file,
                  to: starSource,
                  isExternal: false,
                  specifier: raw.specifier,
                  importedNames: unresolved,
                  isTypeOnly: raw.isTypeOnly,
                  isDynamic: raw.isDynamic,
                  isBarrelRouted: true,
                });
                inDegree.set(starSource, (inDegree.get(starSource) ?? 0) + 1);
              }
            }

            // Side-effect import to barrel (no names): keep edge to barrel itself
            if (raw.importedNames.length === 0) {
              edges.push({
                from: file,
                to: resolved,
                isExternal: false,
                specifier: raw.specifier,
                importedNames: [],
                isTypeOnly: raw.isTypeOnly,
                isDynamic: raw.isDynamic,
              });
              inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
            }
          } else {
            // Non-barrel import: direct edge
            edges.push({
              from: file,
              to: resolved,
              isExternal: false,
              specifier: raw.specifier,
              importedNames: raw.importedNames,
              isTypeOnly: raw.isTypeOnly,
              isDynamic: raw.isDynamic,
            });
            inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
            directInDegree.set(resolved, (directInDegree.get(resolved) ?? 0) + 1);
          }
        } else if (language === "go" || language === "java" || language === "rust") {
          // For Go/Java/Rust, unresolved "relative" imports are actually external
          // (stdlib, third-party). Fall through to external edge creation.
          // Skip unresolved mod declarations (mod::) -- these are Rust compile errors, not packages.
          if (raw.specifier.startsWith("mod::")) continue;
          const pkgName = getPackageName(raw.specifier, language);
          edges.push({
            from: file,
            to: pkgName,
            isExternal: true,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          externalImportCounts.set(
            pkgName,
            (externalImportCounts.get(pkgName) ?? 0) + 1,
          );
        }
      } else {
        // Try path alias resolution before treating as external
        const aliasResolved = pathAliases.length > 0
          ? resolveAliasImport(raw.specifier, pathAliases, fileSet)
          : null;

        if (aliasResolved) {
          edges.push({
            from: file,
            to: aliasResolved,
            isExternal: false,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          inDegree.set(aliasResolved, (inDegree.get(aliasResolved) ?? 0) + 1);
          directInDegree.set(aliasResolved, (directInDegree.get(aliasResolved) ?? 0) + 1);
        } else {
          // External package
          // Normalize specifier to package name (e.g. @scope/pkg/path -> @scope/pkg)
          const pkgName = getPackageName(raw.specifier, language);
          edges.push({
            from: file,
            to: pkgName,
            isExternal: true,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          externalImportCounts.set(
            pkgName,
            (externalImportCounts.get(pkgName) ?? 0) + 1,
          );
        }
      }
    }
  }

  // Detect barrel files for HITS accuracy correction
  let detectedBarrels = new Set<string>();
  if (isJsTs) {
    detectedBarrels = await detectBarrelFiles(rootDir, fileSet);
    if (detectedBarrels.size > 0) {
      onProgress?.(`Detected ${detectedBarrels.size} barrel file${detectedBarrels.size === 1 ? "" : "s"}`);
    }
  }

  onProgress?.("Computing centrality (HITS)...");
  const { authority, hub: hubScores } = computeHITS(files, edges, 30, 1e-6, detectedBarrels);

  onProgress?.("Computing betweenness centrality...");
  const graphForBetweenness: ImportGraph = {
    edges, inDegree, directInDegree, centrality: authority, externalImportCounts, authority, hubScores, barrelFiles: detectedBarrels,
  };
  const betweennessScores = computeBetweenness(graphForBetweenness);

  // Use authority as centrality for backward compat (snapshot.ts etc.)
  return { edges, inDegree, directInDegree, centrality: authority, externalImportCounts, authority, hubScores, barrelFiles: detectedBarrels, betweennessScores };
}

/**
 * Merge a secondary language graph into the primary graph (in-place).
 * Used for multi-language projects where each language is parsed separately.
 */
export function mergeGraph(target: ImportGraph, source: ImportGraph): void {
  target.edges.push(...source.edges);
  for (const [k, v] of source.inDegree) {
    target.inDegree.set(k, (target.inDegree.get(k) ?? 0) + v);
  }
  if (source.directInDegree) {
    if (!target.directInDegree) target.directInDegree = new Map();
    for (const [k, v] of source.directInDegree) {
      target.directInDegree.set(k, (target.directInDegree.get(k) ?? 0) + v);
    }
  }
  for (const [k, v] of source.centrality) {
    if (!target.centrality.has(k)) target.centrality.set(k, v);
  }
  for (const [k, v] of source.externalImportCounts) {
    target.externalImportCounts.set(k, (target.externalImportCounts.get(k) ?? 0) + v);
  }
  for (const [k, v] of source.authority) {
    if (!target.authority.has(k)) target.authority.set(k, v);
  }
  for (const [k, v] of source.hubScores) {
    if (!target.hubScores.has(k)) target.hubScores.set(k, v);
  }
}

/**
 * Extract the package name from an import specifier.
 * JS/TS: "@tanstack/react-query" -> "@tanstack/react-query", "react/jsx-runtime" -> "react"
 * Go: "github.com/gin-gonic/gin/middleware" -> "github.com/gin-gonic/gin" (3 segments for domain-style)
 *     "fmt" -> "fmt", "net/http" -> "net"
 * Java: "java.util.HashMap" -> "java.util", "com.example.lib.Foo" -> "com.example.lib"
 * Rust: "std::collections::HashMap" -> "std", "serde::Deserialize" -> "serde"
 */
function getPackageName(specifier: string, lang?: Language): string {
  if (lang === "go") {
    const parts = specifier.split("/");
    // Domain-style imports (github.com/user/repo/...) -> first 3 segments
    if (parts.length >= 3 && parts[0].includes(".")) {
      return parts.slice(0, 3).join("/");
    }
    // Stdlib: "fmt" -> "fmt", "net/http" -> "net"
    return parts[0];
  }
  if (lang === "java") {
    const parts = specifier.split(".");
    // Strip trailing class name(s): keep package prefix
    // "java.util.HashMap" -> "java.util"
    // "com.example.service.UserService" -> "com.example.service"
    if (parts.length <= 2) return specifier;
    // Known stdlib: take first 2 segments
    const prefix = parts[0];
    if (prefix === "java" || prefix === "javax") {
      return parts.slice(0, 2).join(".");
    }
    // Third-party: take first 3 segments (com.example.library)
    return parts.slice(0, Math.min(3, parts.length)).join(".");
  }
  if (lang === "rust") {
    // "std::collections::HashMap" -> "std", "serde::Deserialize" -> "serde"
    const idx = specifier.indexOf("::");
    return idx >= 0 ? specifier.slice(0, idx) : specifier;
  }
  // JS/TS default
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

/**
 * Build a set of "filepath::ExportName" pairs that are actually imported
 * somewhere in the project. Used for dead export filtering.
 */
export function findUsedExports(edges: ImportEdge[]): Set<string> {
  const used = new Set<string>();
  for (const edge of edges) {
    if (edge.isExternal) continue;
    for (const name of edge.importedNames) {
      used.add(`${edge.to}::${name}`);
    }
  }
  return used;
}

/**
 * Get the most interconnected files sorted by max(authority, hubScore).
 * Captures both foundations (high authority) and orchestrators (high hub).
 */
export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[] {
  // Count outgoing internal imports per file
  const outCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    }
  }

  // Build list of all files with their scores
  const files: HubFile[] = [];
  for (const [filePath] of graph.centrality) {
    const importedBy = graph.inDegree.get(filePath) ?? 0;
    const imports = outCount.get(filePath) ?? 0;
    // Only include files that have some connectivity
    if (importedBy > 0 || imports > 0) {
      const authority = graph.authority?.get(filePath) ?? graph.centrality.get(filePath) ?? 0;
      const hubScore = graph.hubScores?.get(filePath) ?? 0;
      const isBarrel = graph.barrelFiles?.has(filePath) ?? false;
      const role = deriveRole(authority, hubScore, isBarrel);
      files.push({
        path: filePath,
        centrality: authority,
        authority,
        hubScore,
        role,
        importedBy,
        imports,
      });
    }
  }

  // Sort by max(authority, hubScore) descending — captures both foundations and orchestrators
  files.sort((a, b) => Math.max(b.authority, b.hubScore) - Math.max(a.authority, a.hubScore));

  return files.slice(0, limit);
}

/**
 * Find all strongly connected components using Tarjan's algorithm.
 * Returns SCCs with size > 1 (i.e. actual cycles).
 */
export function findSCCs(graph: ImportGraph): string[][] {
  // Build adjacency list from internal edges only
  const adj = new Map<string, string[]>();
  const allFiles = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  let index = 0;
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const sccs: string[][] = [];

  // Iterative Tarjan's using an explicit call stack.
  // Each frame stores the current node and the index into its neighbor list.
  const callStack: Array<{ v: string; neighborIdx: number }> = [];

  for (const file of allFiles) {
    if (indices.has(file)) continue;

    callStack.push({ v: file, neighborIdx: 0 });
    indices.set(file, index);
    lowlinks.set(file, index);
    index++;
    stack.push(file);
    onStack.add(file);

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;
      const neighbors = adj.get(frame.v) ?? [];

      if (frame.neighborIdx < neighbors.length) {
        const w = neighbors[frame.neighborIdx]!;
        frame.neighborIdx++;

        if (!indices.has(w)) {
          // "Recurse" into w: push a new frame
          callStack.push({ v: w, neighborIdx: 0 });
          indices.set(w, index);
          lowlinks.set(w, index);
          index++;
          stack.push(w);
          onStack.add(w);
        } else if (onStack.has(w)) {
          lowlinks.set(frame.v, Math.min(lowlinks.get(frame.v)!, indices.get(w)!));
        }
      } else {
        // All neighbors processed: check for SCC root
        if (lowlinks.get(frame.v) === indices.get(frame.v)) {
          const scc: string[] = [];
          let w: string;
          do {
            w = stack.pop()!;
            onStack.delete(w);
            scc.push(w);
          } while (w !== frame.v);
          if (scc.length > 1) {
            sccs.push(scc);
          }
        }

        // Pop this frame and update parent's lowlink
        callStack.pop();
        if (callStack.length > 0) {
          const parentFrame = callStack[callStack.length - 1]!;
          lowlinks.set(
            parentFrame.v,
            Math.min(lowlinks.get(parentFrame.v)!, lowlinks.get(frame.v)!),
          );
        }
      }
    }
  }

  return sccs;
}

/**
 * Detect circular dependencies using Tarjan's SCC algorithm,
 * then extract actual valid cycles via BFS within each SCC.
 * Returns up to maxCycles results, shortest first.
 */
export function findCircularDeps(
  graph: ImportGraph,
  maxCycles = 10,
): CircularDependency[] {
  const sccs = findSCCs(graph);

  // Sort SCCs by size (smallest first, more actionable)
  sccs.sort((a, b) => a.length - b.length);

  // Build adjacency restricted to internal edges
  const adj = new Map<string, Set<string>>();
  // Build edge lookup for type-only info: "from->to" -> ImportEdge
  const edgeLookup = new Map<string, ImportEdge>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    adj.get(edge.from)!.add(edge.to);
    // Keep the edge with most imported names (most specific)
    const key = `${edge.from}->${edge.to}`;
    const existing = edgeLookup.get(key);
    if (!existing || edge.importedNames.length > existing.importedNames.length) {
      edgeLookup.set(key, edge);
    }
  }

  const allCycles: CircularDependency[] = [];

  for (const scc of sccs) {
    if (allCycles.length >= maxCycles) break;
    const found = findActualCycles(scc, adj, maxCycles - allCycles.length);
    allCycles.push(...found);
  }

  // Compute severity and break hints for each cycle
  // Severity is a weighted average: type-only edges = 0, dynamic edges = 0.5, static runtime = 1.0
  const shortName = (f: string) => f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? f;
  for (const cycle of allCycles) {
    const edges: Array<{ from: string; to: string; isTypeOnly: boolean; isDynamic: boolean }> = [];
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}->${cycle.chain[i + 1]}`;
      const e = edgeLookup.get(key);
      edges.push({ from: cycle.chain[i], to: cycle.chain[i + 1], isTypeOnly: !!e?.isTypeOnly, isDynamic: !!e?.isDynamic });
    }
    const runtimeEdges = edges.filter((e) => !e.isTypeOnly);
    if (edges.length > 0) {
      let weightSum = 0;
      for (const e of edges) {
        if (e.isTypeOnly) weightSum += 0;
        else if (e.isDynamic) weightSum += 0.5;
        else weightSum += 1.0;
      }
      cycle.severity = weightSum / edges.length;
    } else {
      cycle.severity = 0;
    }

    // Break hint: suggest converting the smallest runtime edge to type-only
    if (runtimeEdges.length === 1) {
      const e = runtimeEdges[0];
      cycle.breakHint = `Convert ${shortName(e.from)} -> ${shortName(e.to)} to type-only import`;
    } else if (runtimeEdges.length > 0 && edges.some((e) => e.isTypeOnly)) {
      // Mixed: some already type-only, suggest converting remaining
      cycle.breakHint = `${runtimeEdges.length} of ${edges.length} edges are runtime; convert more to type-only`;
    } else if (runtimeEdges.length > 0) {
      // All runtime: suggest extracting shared types
      const shortest = runtimeEdges.reduce((a, b) => a.from < b.from ? a : b);
      cycle.breakHint = `Extract shared types from ${shortName(shortest.from)} and ${shortName(shortest.to)}`;
    }
  }

  // Sort: type-only-only cycles last, then by severity desc, then shortest first
  allCycles.sort((a, b) => {
    const sa = a.severity ?? 1;
    const sb = b.severity ?? 1;
    if (sa === 0 && sb > 0) return 1;
    if (sb === 0 && sa > 0) return -1;
    if (sa !== sb) return sb - sa;
    return a.chain.length - b.chain.length;
  });

  return allCycles;
}

/**
 * Find the most impactful edges to break in order to resolve circular dependencies.
 * Uses a greedy approach: count how many cycles each edge participates in,
 * then report the top edges whose removal would resolve the most cycles.
 *
 * @returns Array of { from, to, cyclesResolved } sorted by impact descending, max 3 items.
 */
export function findFeedbackEdges(
  cycles: CircularDependency[],
  topN = 3,
): Array<{ from: string; to: string; cyclesResolved: number }> {
  if (cycles.length === 0) return [];

  // Count how many cycles each directed edge participates in
  const edgeCounts = new Map<string, number>();
  for (const cycle of cycles) {
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}||${cycle.chain[i + 1]}`;
      edgeCounts.set(key, (edgeCounts.get(key) ?? 0) + 1);
    }
  }

  // Sort by count descending and return top N
  const sorted = [...edgeCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, topN);

  return sorted.map(([key, count]) => {
    const [from, to] = key.split("||");
    return { from, to, cyclesResolved: count };
  });
}

/**
 * Canonicalize a cycle by rotating so the lexicographically smallest node is first.
 */
function canonicalizeCycle(cycle: string[]): string {
  // cycle is [a, b, c, a] -- last element duplicates first
  const nodes = cycle.slice(0, -1);
  let minIdx = 0;
  for (let i = 1; i < nodes.length; i++) {
    if (nodes[i] < nodes[minIdx]) minIdx = i;
  }
  const rotated = [...nodes.slice(minIdx), ...nodes.slice(0, minIdx)];
  return rotated.join("||");
}

/**
 * Find actual valid cycles within an SCC using BFS.
 * Returns deduplicated cycles sorted by length (shortest first).
 */
function findActualCycles(
  scc: string[],
  adj: Map<string, Set<string>>,
  maxCycles: number,
): CircularDependency[] {
  const sccSet = new Set(scc);

  // Build SCC-restricted adjacency
  const sccAdj = new Map<string, Set<string>>();
  for (const node of scc) {
    const neighbors = adj.get(node);
    if (neighbors) {
      const filtered = new Set<string>();
      for (const n of neighbors) {
        if (sccSet.has(n)) filtered.add(n);
      }
      sccAdj.set(node, filtered);
    } else {
      sccAdj.set(node, new Set());
    }
  }

  const seenCanonical = new Set<string>();
  const cycles: CircularDependency[] = [];

  // 1. Find all mutual imports (2-cycles) first -- most actionable
  const sortedScc = [...scc].sort();
  for (const a of sortedScc) {
    for (const b of sccAdj.get(a) ?? []) {
      if (a < b && (sccAdj.get(b)?.has(a) ?? false)) {
        const chain = [a, b, a];
        const key = canonicalizeCycle(chain);
        if (!seenCanonical.has(key)) {
          seenCanonical.add(key);
          cycles.push({ chain });
          if (cycles.length >= maxCycles) return cycles;
        }
      }
    }
  }

  // 2. BFS shortest cycle through each node
  // Sort by degree descending: high-degree nodes find diverse cycles faster
  const byDegree = [...scc].sort((a, b) => {
    const degA = (sccAdj.get(a)?.size ?? 0) + (sccAdj.get(b)?.size ?? 0);
    const degB = (sccAdj.get(b)?.size ?? 0) + (sccAdj.get(a)?.size ?? 0);
    return degB - degA;
  });

  for (const start of byDegree) {
    if (cycles.length >= maxCycles) break;

    // BFS from start, looking for path back to start
    // Use parent-pointer map instead of copying path arrays (avoids O(V*E) allocations)
    const parent = new Map<string, string>();
    const depth = new Map<string, number>();
    const queue: string[] = [];

    for (const neighbor of sccAdj.get(start) ?? []) {
      if (!parent.has(neighbor) && neighbor !== start) {
        parent.set(neighbor, start);
        depth.set(neighbor, 1);
        queue.push(neighbor);
      } else if (neighbor === start) {
        // Self-loop; skip (would be a 1-cycle, not meaningful)
      }
    }

    let qi = 0;
    while (qi < queue.length) {
      if (cycles.length >= maxCycles) break;

      const node = queue[qi++];
      const nodeDepth = depth.get(node)!;

      // Cap depth at SCC size to avoid explosion
      if (nodeDepth >= scc.length) continue;

      for (const next of sccAdj.get(node) ?? []) {
        if (next === start) {
          // Found a cycle back to start -- reconstruct via parent pointers
          const reversePath: string[] = [node];
          let rCur = node;
          while (rCur !== start) {
            const p = parent.get(rCur);
            if (p === undefined) break;
            rCur = p;
            if (rCur !== start) reversePath.push(rCur);
          }
          reversePath.reverse();
          const fullChain = [start, ...reversePath, start];

          // Skip 2-cycles (already found above)
          if (fullChain.length > 3) {
            const key = canonicalizeCycle(fullChain);
            if (!seenCanonical.has(key)) {
              seenCanonical.add(key);
              cycles.push({ chain: fullChain });
              if (cycles.length >= maxCycles) return cycles;
            }
          }
          continue;
        }

        if (!parent.has(next)) {
          parent.set(next, node);
          depth.set(next, nodeDepth + 1);
          queue.push(next);
        }
      }
    }
  }

  // Sort by length (shortest = most actionable)
  cycles.sort((a, b) => a.chain.length - b.chain.length);
  return cycles;
}

/**
 * BFS to find the shortest cycle starting and ending at `start` within `sccSet`.
 */
function findShortestCycleInSCC(
  start: string,
  sccSet: Set<string>,
  adj: Map<string, Set<string>>,
): string[] | null {
  // BFS from start, only traversing nodes in the SCC
  const queue: Array<{ node: string; path: string[] }> = [{ node: start, path: [start] }];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const { node, path } = queue.shift()!;
    const neighbors = adj.get(node);
    if (!neighbors) continue;

    for (const next of neighbors) {
      if (!sccSet.has(next)) continue;
      if (next === start && path.length >= 2) {
        // Found a cycle back to start
        return [...path, start];
      }
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ node: next, path: [...path, next] });
      }
    }
  }
  return null;
}

/** Directory patterns for classifying files into architectural layers */
const LAYER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "types", pattern: /(?:^|\/)types?\// },
  { name: "stores", pattern: /(?:^|\/)stores?\// },
  { name: "hooks", pattern: /(?:^|\/)hooks?\// },
  { name: "services", pattern: /(?:^|\/)(?:services?|api)\// },
  { name: "components", pattern: /(?:^|\/)components?\// },
  { name: "pages", pattern: /(?:^|\/)(?:pages?|app|routes?)\// },
  { name: "utils", pattern: /(?:^|\/)(?:utils?|lib|helpers?)\// },
  { name: "config", pattern: /(?:^|\/)config\// },
];

/**
 * Classify files into architectural layers and determine their dependency ordering.
 * Returns both the layers and directed edges between them.
 *
 * When customLayers is provided, those patterns are matched first (before the
 * hardcoded LAYER_PATTERNS). Each entry's `pattern` string is compiled to a RegExp.
 */
export function detectArchitecturalLayers(
  graph: ImportGraph,
  customLayers?: Array<{ name: string; pattern: string }>,
): { layers: ArchitecturalLayer[]; layerEdges: LayerEdge[] } {
  // Build the effective pattern list: user patterns first, then built-in defaults
  const userPatterns: Array<{ name: string; pattern: RegExp }> = (customLayers ?? []).map((l) => ({
    name: l.name,
    pattern: new RegExp(l.pattern),
  }));
  const effectivePatterns = [...userPatterns, ...LAYER_PATTERNS];

  // Classify each internal file into a layer
  const layerFiles = new Map<string, string[]>();
  const fileToLayer = new Map<string, string>();

  for (const [filePath] of graph.centrality) {
    for (const { name, pattern } of effectivePatterns) {
      if (pattern.test(filePath)) {
        const files = layerFiles.get(name) ?? [];
        files.push(filePath);
        layerFiles.set(name, files);
        fileToLayer.set(filePath, name);
        break; // First match wins
      }
    }
  }

  // Track both directions: who imports each layer, and who each layer depends on
  const layerImportedBy = new Map<string, Set<string>>();
  const layerDependsOn = new Map<string, Set<string>>();
  for (const name of layerFiles.keys()) {
    layerImportedBy.set(name, new Set());
    layerDependsOn.set(name, new Set());
  }

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (fromLayer && toLayer && fromLayer !== toLayer) {
      layerImportedBy.get(toLayer)?.add(fromLayer);
      layerDependsOn.get(fromLayer)?.add(toLayer);
    }
  }

  // Build layer edges from dependsOn data
  const layerEdges: LayerEdge[] = [];
  const edgeSet = new Set<string>();
  for (const [from, deps] of layerDependsOn) {
    for (const to of deps) {
      const key = `${from}->${to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        layerEdges.push({ from, to });
      }
    }
  }

  // Build result sorted by importedByLayers descending (most foundational first)
  const layers: ArchitecturalLayer[] = [];
  for (const [name, files] of layerFiles) {
    layers.push({
      name,
      files,
      importedByLayers: layerImportedBy.get(name)?.size ?? 0,
      dependsOn: [...(layerDependsOn.get(name) ?? [])],
    });
  }

  // Sort: most imported layers first (foundational), then by name
  layers.sort((a, b) => b.importedByLayers - a.importedByLayers || a.name.localeCompare(b.name));

  return { layers, layerEdges };
}

/** Threshold above which a file is considered high-instability */
export const INSTABILITY_THRESHOLD = 0.8;

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > INSTABILITY_THRESHOLD and fanIn >= 1 (high-risk zones).
 */
export function computeInstability(graph: ImportGraph): FileInstability[] {
  /** Type-only imports carry less coupling risk (erased at runtime) */
  const TYPE_ONLY_WEIGHT = 0.3;

  // Count weighted outgoing internal edges per file
  const fanOutMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + weight);
    }
  }

  // Count weighted incoming internal edges per file
  const fanInMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanInMap.set(edge.to, (fanInMap.get(edge.to) ?? 0) + weight);
    }
  }

  const results: FileInstability[] = [];
  for (const [filePath] of graph.inDegree) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const fanIn = fanInMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    const instability = fanOut / total;
    if (instability > INSTABILITY_THRESHOLD && fanIn >= 1) {
      results.push({ path: filePath, fanIn: Math.round(fanIn), fanOut: Math.round(fanOut), instability });
    }
  }

  // Sort by instability descending
  results.sort((a, b) => b.instability - a.instability);
  return results;
}

/**
 * Detect communities of tightly-connected files using directory-seeded
 * modularity optimization. Deterministic (no random shuffling).
 *
 * Phase 1: Seed communities from directory structure.
 * Phase 2: Merge tiny communities (< 3 files) into their best neighbor.
 * Phase 3: Reassign files with majority cross-community imports.
 * Phase 4: Validate novelty (skip if communities just mirror directories).
 */
export function detectCommunities(graph: ImportGraph): Community[] {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  // Sort files deterministically for reproducible community detection
  const files = [...allFiles].sort();
  if (files.length === 0) return [];

  // Phase 1: Seed from directory structure (deepest meaningful directory)
  const dirLabels = new Map<string, number>();
  const fileToCommunity = new Map<string, number>();
  let nextLabel = 0;

  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirLabels.has(dir)) {
      dirLabels.set(dir, nextLabel++);
    }
    fileToCommunity.set(file, dirLabels.get(dir)!);
  }

  // Phase 2: Merge tiny communities (< 3 files) into best neighbor
  for (let round = 0; round < 3; round++) {
    const groups = groupByCommunity(fileToCommunity);
    let merged = false;

    for (const [label, members] of groups) {
      if (members.length >= 3) continue;

      // Find neighboring community with most edges
      const neighborCounts = new Map<number, number>();
      for (const file of members) {
        for (const neighbor of adj.get(file) ?? []) {
          const nLabel = fileToCommunity.get(neighbor);
          if (nLabel != null && nLabel !== label) {
            neighborCounts.set(nLabel, (neighborCounts.get(nLabel) ?? 0) + 1);
          }
        }
      }

      if (neighborCounts.size === 0) continue;

      // Merge into most-connected neighbor
      let bestNeighbor = label;
      let bestCount = 0;
      for (const [nLabel, count] of neighborCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestNeighbor = nLabel;
        }
      }

      if (bestNeighbor !== label) {
        for (const file of members) {
          fileToCommunity.set(file, bestNeighbor);
        }
        merged = true;
      }
    }

    if (!merged) break;
  }

  // Phase 3: Reassign files with >50% cross-community imports
  for (let round = 0; round < 3; round++) {
    let changed = false;
    // Process in deterministic sorted order
    for (const file of files.sort()) {
      const currentLabel = fileToCommunity.get(file)!;
      const neighbors = adj.get(file);
      if (!neighbors || neighbors.size === 0) continue;

      // Count which communities neighbors belong to
      const communityEdges = new Map<number, number>();
      for (const neighbor of neighbors) {
        const nLabel = fileToCommunity.get(neighbor);
        if (nLabel != null) {
          communityEdges.set(nLabel, (communityEdges.get(nLabel) ?? 0) + 1);
        }
      }

      // If majority of edges go to a different community, reassign
      let bestCommunity = currentLabel;
      let bestEdges = communityEdges.get(currentLabel) ?? 0;
      for (const [cLabel, count] of communityEdges) {
        if (count > bestEdges) {
          bestEdges = count;
          bestCommunity = cLabel;
        }
      }

      if (bestCommunity !== currentLabel && bestEdges > neighbors.size / 2) {
        fileToCommunity.set(file, bestCommunity);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Build final communities
  const finalGroups = groupByCommunity(fileToCommunity);
  const communities: Community[] = [];
  let id = 0;

  for (const memberFiles of finalGroups.values()) {
    if (memberFiles.length < 3) continue;
    const label = deriveLabel(memberFiles);
    communities.push({ id: id++, files: memberFiles.sort(), label });
  }

  // Phase 4: Validate novelty using Adjusted Rand Index
  // If communities closely mirror directory structure, return empty
  const dirOnlyCommunities = new Map<string, number>();
  let dirNextLabel = 0;
  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirOnlyCommunities.has(dir)) dirOnlyCommunities.set(dir, dirNextLabel++);
  }
  const ari = computeARI(files, fileToCommunity, file => dirOnlyCommunities.get(getDeepestDir(file))!);
  if (ari > 0.85) {
    // Communities just restate directory tree; no novel insight
    return [];
  }

  // Sort by size descending
  communities.sort((a, b) => b.files.length - a.files.length);
  return communities;
}

/**
 * Get the deepest meaningful directory for a file path.
 * e.g. "src/components/Button.tsx" -> "src/components"
 */
function getDeepestDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/**
 * Group files by their community label.
 */
function groupByCommunity(fileToCommunity: Map<string, number>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const [file, label] of fileToCommunity) {
    const group = groups.get(label) ?? [];
    group.push(file);
    groups.set(label, group);
  }
  return groups;
}

/**
 * Compute Adjusted Rand Index between two clusterings of the same files.
 * Returns a value between -1 and 1, where 1 means identical clusterings.
 */
function computeARI(
  files: string[],
  labelingA: Map<string, number>,
  getLabelB: (file: string) => number,
): number {
  const n = files.length;
  if (n < 2) return 1;

  // Build contingency table
  const contingency = new Map<string, number>();
  const aCounts = new Map<number, number>();
  const bCounts = new Map<number, number>();

  for (const file of files) {
    const a = labelingA.get(file)!;
    const b = getLabelB(file);
    const key = `${a}|${b}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }

  // Choose-2 helper
  const c2 = (x: number) => (x * (x - 1)) / 2;

  let sumNij = 0;
  for (const nij of contingency.values()) sumNij += c2(nij);

  let sumAi = 0;
  for (const ai of aCounts.values()) sumAi += c2(ai);

  let sumBj = 0;
  for (const bj of bCounts.values()) sumBj += c2(bj);

  const totalC2 = c2(n);
  const expected = (sumAi * sumBj) / totalC2;
  const maxIndex = (sumAi + sumBj) / 2;
  const denominator = maxIndex - expected;

  if (denominator === 0) return 1;
  return (sumNij - expected) / denominator;
}

/**
 * Derive a human-readable label from a group of file paths
 * by finding their common directory prefix.
 */
function deriveLabel(files: string[]): string {
  if (files.length === 0) return "unknown";

  const dirs = files.map((f) => {
    const parts = f.split("/");
    return parts.slice(0, -1).join("/");
  });

  // Find common prefix
  const first = dirs[0];
  let prefixLen = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < prefixLen && i < dir.length && first[i] === dir[i]) i++;
    prefixLen = i;
  }

  let common = first.slice(0, prefixLen);
  // Trim to last full directory segment
  if (common.includes("/")) {
    common = common.slice(0, common.lastIndexOf("/") + 1);
  }
  common = common.replace(/\/$/, "");

  return common || files[0].split("/")[0] || "root";
}

/**
 * Find dead files: files with zero in-degree (not imported by anything).
 * Excludes entry points, test files, and config files.
 */
export function findDeadFiles(
  graph: ImportGraph,
  entryPoints: string[] = [],
): string[] {
  const entrySet = new Set(entryPoints);
  const dead: string[] = [];

  for (const [file, degree] of graph.inDegree) {
    if (degree > 0) continue;
    if (entrySet.has(file)) continue;
    // Skip test files
    if (/\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/")) continue;
    // Skip config files
    if (/\.(config|rc)\.[jt]sx?$/.test(file)) continue;
    // Skip entry points by convention
    const basename = file.split("/").pop() ?? "";
    if (/^(index|main|app|server|cli|worker|seed|migrate|setup|cron|bootstrap|handler|lambda)\.[jt]sx?$/.test(basename)) continue;
    if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") continue;
    if (basename === "main.go" || basename === "main.py" || basename === "manage.py" || basename === "wsgi.py" || basename === "asgi.py") continue;

    dead.push(file);
  }

  return dead.sort();
}


// ── §1.7 Cross-Layer Fan-In Analysis ──────────────────────────────────

/**
 * Find files imported across multiple architectural layers.
 * A file imported by 10 files all in `components/` is local.
 * A file imported across `components/`, `services/`, `hooks/`, and `pages/`
 * is a cross-cutting concern where changes ripple across boundaries.
 */
export function findCrossCuttingFiles(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  minLayerSpread = 3,
): CrossCuttingFile[] {
  if (layers.length < minLayerSpread) return [];

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // For each target file, collect which layers import it
  const importerLayers = new Map<string, Set<string>>();
  const importerCounts = new Map<string, number>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    if (!fromLayer) continue;

    if (!importerLayers.has(edge.to)) importerLayers.set(edge.to, new Set());
    importerLayers.get(edge.to)!.add(fromLayer);
    importerCounts.set(edge.to, (importerCounts.get(edge.to) ?? 0) + 1);
  }

  const results: CrossCuttingFile[] = [];
  for (const [file, layerSet] of importerLayers) {
    if (layerSet.size >= minLayerSpread) {
      results.push({
        file,
        totalImporters: importerCounts.get(file) ?? 0,
        layerSpread: layerSet.size,
        layers: [...layerSet].sort(),
      });
    }
  }

  // Sort by layer spread descending, then by total importers descending
  results.sort((a, b) => b.layerSpread - a.layerSpread || b.totalImporters - a.totalImporters);
  return results;
}

// ── §1.8 Layer Dependency Consistency Score ────────────────────────────

/**
 * Topological sort of layers using Kahn's algorithm.
 * Returns layers ordered from most foundational to most consumer.
 * Falls back to input order for cycles.
 */
function topologicalSortLayers(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): string[] {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDeg.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: from depends on to (from imports to)
  // For topological order: to is more foundational, from is more consumer
  // Edge direction for topo sort: to -> from (foundational -> consumer)
  for (const edge of layerEdges) {
    if (!layerNames.has(edge.from) || !layerNames.has(edge.to)) continue;
    adj.get(edge.to)!.push(edge.from);
    inDeg.set(edge.from, (inDeg.get(edge.from) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }
  queue.sort(); // deterministic tie-breaking

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position for determinism
        const insertIdx = queue.findIndex((q) => q > neighbor);
        if (insertIdx === -1) queue.push(neighbor);
        else queue.splice(insertIdx, 0, neighbor);
      }
    }
  }

  // If cycle exists, append remaining layers
  if (sorted.length < layerNames.size) {
    for (const name of layerNames) {
      if (!sorted.includes(name)) sorted.push(name);
    }
  }

  return sorted;
}

/**
 * Measure how well the codebase follows its own layering conventions.
 * For each detected layer pair, count edges in the "correct" direction
 * (foundational -> consumer) vs. the "wrong" direction (upward imports).
 */
export function computeLayerConsistency(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): LayerConsistency {
  if (layers.length < 2) return { consistency: 1, violations: [] };

  // Build topological order and rank map
  const order = topologicalSortLayers(layers, layerEdges);
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    rank.set(order[i], i);
  }

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  const violations: LayerViolation[] = [];
  let correctCount = 0;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const fromRank = rank.get(fromLayer);
    const toRank = rank.get(toLayer);
    if (fromRank == null || toRank == null) continue;

    if (fromRank < toRank) {
      // Foundational layer importing from a consumer layer = violation
      violations.push({
        from: edge.from,
        to: edge.to,
        fromLayer,
        toLayer,
      });
    } else {
      correctCount++;
    }
  }

  const total = correctCount + violations.length;
  const consistency = total === 0 ? 1 : correctCount / total;

  // Sort violations by layer rank distance (most egregious first)
  violations.sort((a, b) => {
    const distA = (rank.get(a.toLayer) ?? 0) - (rank.get(a.fromLayer) ?? 0);
    const distB = (rank.get(b.toLayer) ?? 0) - (rank.get(b.fromLayer) ?? 0);
    return distB - distA;
  });

  return { consistency, violations: violations.slice(0, 10) };
}

// ── §1.9 Articulation Point Detection ─────────────────────────────────

/**
 * Find articulation points (chokepoints) in the import graph using
 * Tarjan's algorithm. These are files whose removal would disconnect
 * parts of the codebase.
 *
 * Runs in O(V + E), same complexity as SCC detection.
 */
export function findChokepoints(graph: ImportGraph): Chokepoint[] {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  if (allFiles.size === 0) return [];

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const articulationPoints = new Set<string>();
  let timer = 0;

  // Iterative articulation point detection using an explicit call stack.
  // Each frame stores the current node, its neighbor list as an array,
  // the iteration index into that list, and the tree-child count.
  const callStack: Array<{
    u: string;
    neighbors: string[];
    neighborIdx: number;
    childCount: number;
  }> = [];

  // Run DFS from each unvisited node (handles disconnected components)
  const sortedFiles = [...allFiles].sort();
  for (const file of sortedFiles) {
    if (disc.has(file)) continue;

    parent.set(file, null);
    disc.set(file, timer);
    low.set(file, timer);
    timer++;
    callStack.push({
      u: file,
      neighbors: [...(adj.get(file) ?? [])],
      neighborIdx: 0,
      childCount: 0,
    });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;

      if (frame.neighborIdx < frame.neighbors.length) {
        const v = frame.neighbors[frame.neighborIdx]!;
        frame.neighborIdx++;

        if (!disc.has(v)) {
          frame.childCount++;
          parent.set(v, frame.u);
          disc.set(v, timer);
          low.set(v, timer);
          timer++;
          // "Recurse" into v: push a new frame
          callStack.push({
            u: v,
            neighbors: [...(adj.get(v) ?? [])],
            neighborIdx: 0,
            childCount: 0,
          });
        } else if (v !== parent.get(frame.u)) {
          low.set(frame.u, Math.min(low.get(frame.u)!, disc.get(v)!));
        }
      } else {
        // All neighbors processed: pop frame and update parent
        callStack.pop();
        if (callStack.length > 0) {
          const parentFrame = callStack[callStack.length - 1]!;
          low.set(parentFrame.u, Math.min(low.get(parentFrame.u)!, low.get(frame.u)!));

          // Root with 2+ children
          if (parent.get(parentFrame.u) == null && parentFrame.childCount > 1) {
            articulationPoints.add(parentFrame.u);
          }
          // Non-root where no back edge from subtree reaches above u
          if (parent.get(parentFrame.u) != null && low.get(frame.u)! >= disc.get(parentFrame.u)!) {
            articulationPoints.add(parentFrame.u);
          }
        }
      }
    }
  }

  // For each articulation point, find components without it and disconnected files
  const results: Chokepoint[] = [];
  for (const cp of articulationPoints) {
    const { componentCount, disconnected } = analyzeComponentsWithout(adj, allFiles, cp);
    results.push({
      file: cp,
      separates: componentCount,
      importedBy: graph.inDegree.get(cp) ?? 0,
      dependents: disconnected.slice(0, 10), // Cap at 10 for context size
    });
  }

  // Sort by separates descending, then importedBy descending
  results.sort((a, b) => b.separates - a.separates || b.importedBy - a.importedBy);
  return results;
}

/**
 * Analyze the graph after removing a node: count components and find
 * files disconnected from the largest remaining component.
 */
function analyzeComponentsWithout(
  adj: Map<string, Set<string>>,
  allFiles: Set<string>,
  removed: string,
): { componentCount: number; disconnected: string[] } {
  const visited = new Set<string>();
  visited.add(removed);
  const componentMembers: string[][] = [];

  for (const file of allFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    let qHead = 0;
    visited.add(file);
    while (qHead < queue.length) {
      const current = queue[qHead++];
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    componentMembers.push(component);
  }

  // Find the largest component; all other files are "disconnected"
  componentMembers.sort((a, b) => b.length - a.length);
  const disconnected: string[] = [];
  for (let i = 1; i < componentMembers.length; i++) {
    disconnected.push(...componentMembers[i]);
  }
  disconnected.sort();

  return { componentCount: componentMembers.length, disconnected };
}

// ── Graph Topology Analysis ────────────────────────────────────────────

/**
 * Compute graph topology metrics: connected components, approximate diameter,
 * and reachability. Helps LLMs understand whether a project has independent
 * subsystems or is a tightly connected monolith.
 */
export function computeGraphTopology(graph: ImportGraph): GraphTopology {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const totalFiles = allFiles.size;
  if (totalFiles === 0) {
    return { componentCount: 0, componentSizes: [], approximateDiameter: 0, reachability: 0, isFragmented: false };
  }

  // 1. Find connected components via BFS
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const file of allFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    let qHead = 0;
    visited.add(file);
    while (qHead < queue.length) {
      const current = queue[qHead++];
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const componentSizes = components.map((c) => c.length);

  // 2. Approximate diameter of the largest component using multi-source BFS
  const largest = components[0];
  let approximateDiameter = 0;

  if (largest.length > 1) {
    // Sample up to 3 nodes deterministically (first, middle, last)
    const samples = [
      largest[0],
      largest[Math.floor(largest.length / 2)],
      largest[largest.length - 1],
    ];

    for (const start of samples) {
      // BFS to find max distance from start
      const dist = new Map<string, number>();
      dist.set(start, 0);
      const bfsQueue = [start];
      let maxDist = 0;

      while (bfsQueue.length > 0) {
        const current = bfsQueue.shift()!;
        const d = dist.get(current)!;
        for (const neighbor of adj.get(current) ?? []) {
          if (!dist.has(neighbor)) {
            const nd = d + 1;
            dist.set(neighbor, nd);
            if (nd > maxDist) maxDist = nd;
            bfsQueue.push(neighbor);
          }
        }
      }

      if (maxDist > approximateDiameter) approximateDiameter = maxDist;
    }
  }

  // 3. Reachability: fraction of files in the largest component
  const reachability = totalFiles > 0 ? largest.length / totalFiles : 0;

  // 4. Fragmentation: more than one component with 5+ files
  const isFragmented = components.length > 1 && components[1].length >= 5;

  return { componentCount: components.length, componentSizes, approximateDiameter, reachability, isFragmented };
}

// ── Structural-Temporal Mismatch Detection ────────────────────────────

/**
 * Find file pairs that co-change frequently (high temporal coupling)
 * but are structurally distant in the import graph (no direct or short path).
 *
 * These mismatches suggest hidden dependencies: the files are coupled in
 * practice but the import graph doesn't reflect it. Common causes:
 * - Shared database schema or API contract
 * - Copy-paste duplication
 * - Missing shared module that should be extracted
 */
export function findStructuralTemporalMismatches(
  graph: ImportGraph,
  changeCoupling: Array<{ fileA: string; fileB: string; confidence: number; coChangeCount: number }>,
  minConfidence = 0.4,
  minDistance = 3,
  topN = 10,
): StructuralTemporalMismatch[] {
  if (changeCoupling.length === 0) return [];

  // Build undirected adjacency for BFS distance
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const bfsDistance = (from: string, to: string): number => {
    if (from === to) return 0;
    if (!adj.has(from) || !adj.has(to)) return -1;
    const visited = new Set<string>();
    const queue: Array<{ node: string; dist: number }> = [{ node: from, dist: 0 }];
    let qHead = 0;
    visited.add(from);
    while (qHead < queue.length) {
      const { node, dist } = queue[qHead++];
      for (const neighbor of adj.get(node) ?? []) {
        if (neighbor === to) return dist + 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, dist: dist + 1 });
        }
      }
    }
    return -1; // unreachable
  };

  const results: StructuralTemporalMismatch[] = [];

  for (const pair of changeCoupling) {
    if (pair.confidence < minConfidence) continue;

    const dist = bfsDistance(pair.fileA, pair.fileB);
    if (dist >= minDistance || dist === -1) {
      results.push({
        fileA: pair.fileA,
        fileB: pair.fileB,
        graphDistance: dist,
        coChangeConfidence: pair.confidence,
        coChangeCount: pair.coChangeCount,
      });
    }
  }

  // Sort by confidence descending (strongest hidden coupling first)
  results.sort((a, b) => b.coChangeConfidence - a.coChangeConfidence);
  return results.slice(0, topN);
}

// ── Tight Coupling Detection ──────────────────────────────────────────

/**
 * Find file pairs where one file imports many named exports from another,
 * indicating tight coupling. High import specificity means the importing
 * file depends on many implementation details of the imported file.
 *
 * Threshold: 5+ named imports from a single file suggests the importing
 * file may be too tightly coupled and could benefit from an intermediate
 * interface or facade.
 */
export function findTightCouplings(
  graph: ImportGraph,
  minNames = 5,
  topN = 10,
): TightCoupling[] {
  // Aggregate named imports per (from, to) pair
  const pairNames = new Map<string, { from: string; to: string; names: Set<string> }>();

  for (const edge of graph.edges) {
    if (edge.isExternal || edge.importedNames.length === 0) continue;
    const key = `${edge.from}->${edge.to}`;
    let entry = pairNames.get(key);
    if (!entry) {
      entry = { from: edge.from, to: edge.to, names: new Set() };
      pairNames.set(key, entry);
    }
    for (const name of edge.importedNames) {
      entry.names.add(name);
    }
  }

  const results: TightCoupling[] = [];

  for (const entry of pairNames.values()) {
    if (entry.names.size >= minNames) {
      results.push({
        from: entry.from,
        to: entry.to,
        importedNames: entry.names.size,
        names: [...entry.names].sort(),
      });
    }
  }

  // Sort by number of imported names descending
  results.sort((a, b) => b.importedNames - a.importedNames);
  return results.slice(0, topN);
}

// ── Approximate Betweenness Centrality (sampled Brandes) ──────────────

/**
 * Compute a simple deterministic hash from a string.
 * Used to seed the random sampler for reproducible betweenness results.
 */
function simpleHash(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  }
  return h >>> 0; // unsigned
}

/**
 * Simple seeded PRNG (xorshift32). Returns values in [0, 1).
 */
function seededRandom(seed: number): () => number {
  let state = seed || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

/**
 * Compute approximate betweenness centrality using sampled Brandes algorithm.
 *
 * Full Brandes is O(V*E); this samples min(k, V) source nodes for O(k*E).
 * Uses BFS on an undirected view of the import graph, tracking predecessors,
 * path counts (sigma), and dependency scores (delta).
 *
 * Results are normalized to 0-1 range (divided by max score).
 * Uses a seeded random for deterministic results across runs.
 */
export function computeBetweenness(
  graph: ImportGraph,
  k = 50,
): Map<string, number> {
  // Build directed adjacency from internal edges.
  // We follow the actual import direction (importer -> imported) so betweenness
  // measures how many directed dependency chains pass through a file. A true
  // bottleneck sits on many transitive import paths; undirected conversion inflates
  // scores for leaf files that gain reverse-direction paths they don't actually have.
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    adj.get(edge.from)!.add(edge.to);
  }

  const files = [...allFiles].sort();
  const n = files.length;
  if (n === 0) return new Map();

  // Initialize betweenness scores
  const betweenness = new Map<string, number>();
  for (const f of files) betweenness.set(f, 0);

  // Seed from sorted file list hash for determinism
  const seedStr = files.join(",");
  const rng = seededRandom(simpleHash(seedStr));

  // Sample min(k, n) source nodes
  const sampleSize = Math.min(k, n);
  let sources: string[];

  if (sampleSize >= n) {
    sources = files;
  } else {
    // Fisher-Yates partial shuffle to pick sampleSize elements
    const shuffled = [...files];
    for (let i = 0; i < sampleSize; i++) {
      const j = i + Math.floor(rng() * (n - i));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    sources = shuffled.slice(0, sampleSize);
  }

  // Brandes single-source BFS for each sampled source
  for (const s of sources) {
    // BFS from source s
    const stack: string[] = [];
    const pred = new Map<string, string[]>();
    const sigma = new Map<string, number>();
    const dist = new Map<string, number>();
    const delta = new Map<string, number>();

    for (const f of files) {
      pred.set(f, []);
      sigma.set(f, 0);
      dist.set(f, -1);
      delta.set(f, 0);
    }

    sigma.set(s, 1);
    dist.set(s, 0);
    const queue: string[] = [s];
    let qHead = 0;

    while (qHead < queue.length) {
      const v = queue[qHead++];
      stack.push(v);

      const dv = dist.get(v)!;
      for (const w of adj.get(v) ?? []) {
        // w found for the first time?
        if (dist.get(w)! < 0) {
          dist.set(w, dv + 1);
          queue.push(w);
        }
        // Shortest path to w via v?
        if (dist.get(w) === dv + 1) {
          sigma.set(w, sigma.get(w)! + sigma.get(v)!);
          pred.get(w)!.push(v);
        }
      }
    }

    // Accumulate dependencies (back-propagation)
    while (stack.length > 0) {
      const w = stack.pop()!;
      for (const v of pred.get(w)!) {
        const contribution = (sigma.get(v)! / sigma.get(w)!) * (1 + delta.get(w)!);
        delta.set(v, delta.get(v)! + contribution);
      }
      if (w !== s) {
        betweenness.set(w, betweenness.get(w)! + delta.get(w)!);
      }
    }
  }

  // Normalize to 0-1 range (divide by max score)
  let maxScore = 0;
  for (const score of betweenness.values()) {
    if (score > maxScore) maxScore = score;
  }

  if (maxScore > 0) {
    for (const [file, score] of betweenness) {
      betweenness.set(file, score / maxScore);
    }
  }

  return betweenness;
}

// ── Architectural Fitness Functions ───────────────────────────────────

/**
 * Derive a topological ordering of layers from layer dependency edges.
 * Returns a map of layer name to its depth (0 = lowest/most foundational).
 * Uses Kahn's algorithm; layers in cycles get the same depth.
 */
function computeLayerOrdering(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): Map<string, number> {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: {from: "components", to: "types"} means components depends on types.
  // For topological ordering: types is more foundational (lower).
  // Build graph: to -> from (foundational -> consumer) for topo sort.
  for (const e of layerEdges) {
    if (!layerNames.has(e.from) || !layerNames.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
    inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const ordering = new Map<string, number>();
  let depth = 0;

  while (queue.length > 0) {
    const nextQueue: string[] = [];
    for (const node of queue) {
      ordering.set(node, depth);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          nextQueue.push(neighbor);
        }
      }
    }
    queue.length = 0;
    queue.push(...nextQueue);
    depth++;
  }

  // Assign remaining (cycle members) to the max depth
  for (const name of layerNames) {
    if (!ordering.has(name)) {
      ordering.set(name, depth);
    }
  }

  return ordering;
}

/**
 * Check architectural fitness rules against the import graph.
 *
 * Rules:
 * 1. No upward dependencies: lower layers should not import higher layers
 * 2. Test isolation: test files should not import other test files
 *    (except fixtures/test-utils)
 * 3. Layer skip detection: imports skipping 2+ intermediate layers
 *
 * Returns at most 20 violations to avoid noise.
 */
export function checkArchitecturalFitness(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const MAX_VIOLATIONS = 20;

  // Build file-to-layer mapping
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // Compute layer ordering (depth: 0 = most foundational)
  const hasLayers = layers.length >= 2;
  const layerOrder = hasLayers ? computeLayerOrdering(layers, layerEdges) : new Map<string, number>();

  // Test file patterns
  const testFilePattern = /(?:\.test\.|\.spec\.|__tests__\/|tests?\/)/;
  const testUtilPattern = /(?:__fixtures__|test[-_]?utils?|test[-_]?helpers?|test[-_]?setup|fixtures)/;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (violations.length >= MAX_VIOLATIONS) break;

    // Rule 1 and 3 only apply when we have 2+ layers
    if (hasLayers) {
      const fromLayer = fileToLayer.get(edge.from);
      const toLayer = fileToLayer.get(edge.to);

      if (fromLayer && toLayer && fromLayer !== toLayer) {
        const fromDepth = layerOrder.get(fromLayer) ?? 0;
        const toDepth = layerOrder.get(toLayer) ?? 0;

        // Rule 1: No upward dependencies
        // If fromLayer is lower (more foundational) than toLayer, it's an upward dep
        if (fromDepth < toDepth) {
          violations.push({
            from: edge.from,
            to: edge.to,
            rule: "no-upward-dep",
            message: `\`${edge.from}\` (${fromLayer} layer) should not import from \`${edge.to}\` (${toLayer} layer). Extract shared logic to a lower layer.`,
            severity: "warning",
          });
          if (violations.length >= MAX_VIOLATIONS) break;
        }

        // Rule 3: Layer skip detection
        const skipDistance = Math.abs(toDepth - fromDepth);
        if (skipDistance >= 2) {
          // Only flag when going from higher to lower (normal direction but skipping)
          // i.e., fromDepth > toDepth means consumer importing foundational, but skipping
          if (fromDepth > toDepth) {
            violations.push({
              from: edge.from,
              to: edge.to,
              rule: "layer-skip",
              message: `\`${edge.from}\` imports directly from \`${edge.to}\`, skipping ${skipDistance - 1} intermediate layer${skipDistance - 1 === 1 ? "" : "s"}. Consider adding an abstraction in an intermediate layer.`,
              severity: "warning",
            });
            if (violations.length >= MAX_VIOLATIONS) break;
          }
        }
      }
    }

    // Rule 2: Test isolation (works regardless of layer count)
    const fromIsTest = testFilePattern.test(edge.from);
    const toIsTest = testFilePattern.test(edge.to);

    if (fromIsTest && toIsTest) {
      // Allow imports from fixtures/test-utils
      const toIsUtility = testUtilPattern.test(edge.to);
      if (!toIsUtility) {
        violations.push({
          from: edge.from,
          to: edge.to,
          rule: "test-isolation",
          message: `\`${edge.from}\` imports another test file \`${edge.to}\`. Extract shared setup to a test utility.`,
          severity: "warning",
        });
        if (violations.length >= MAX_VIOLATIONS) break;
      }
    }
  }

  return violations.slice(0, MAX_VIOLATIONS);
}
