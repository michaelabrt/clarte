import path from "node:path";
import fg from "fast-glob";
import { readFileOr, readJsonFile } from "./utils.js";
import type {
  ArchitecturalLayer,
  CircularDependency,
  Community,
  ExportCoverage,
  FileInstability,
  FileRole,
  HubFile,
  ImportEdge,
  ImportGraph,
  Language,
  LayerEdge,
  ProgressCallback,
} from "./types.js";

// ── Import regex patterns per language ────────────────────────────────

/** JS/TS: import ... from '...' (including type-only and namespace imports) */
const JS_IMPORT_FROM = /import\s+(type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+|\w+)(?:\s*,\s*\{([^}]*)\})?)\s+from\s+['"]([^'"]+)['"]/g;
/** JS/TS: import '...' (side-effect) */
const JS_IMPORT_SIDE = /import\s+['"]([^'"]+)['"]/g;
/** JS/TS: require('...') */
const JS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
/** JS/TS: dynamic import('...') */
const JS_DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Python: from foo.bar import baz, qux (including relative imports like from . import x) */
const PY_FROM_IMPORT = /^from\s+(\.+[\w.]*|[\w][\w.]*)\s+import\s+(.+)/gm;
/** Python: import foo, bar */
const PY_IMPORT = /^import\s+([\w., ]+)/gm;

/** Go: import "pkg" or import ( "pkg" ) */
const GO_IMPORT_SINGLE = /import\s+"([^"]+)"/g;
const GO_IMPORT_BLOCK = /import\s*\(([^)]+)\)/gs;

/** Rust: use crate::foo::bar (including pub use and glob imports) */
const RUST_USE = /(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)*(?:::\{[^}]*\})?)/g;
/** Rust: mod foo; */
const RUST_MOD = /mod\s+(\w+)\s*;/g;

// ── File extensions to try when resolving relative imports ────────────

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
    default:
      return ["**/*.{ts,tsx,js,jsx,py,go,rs}"];
  }
}

// ── Parse imports from a single file ──────────────────────────────────

export interface RawImport {
  specifier: string;
  importedNames: string[];
  /** Whether this is a type-only import (import type { ... }) */
  isTypeOnly?: boolean;
}

export function parseJsImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  // import { a, b } from '...' / import Foo from '...' / import Foo, { a } from '...' / import * as Foo from '...'
  for (const m of content.matchAll(JS_IMPORT_FROM)) {
    const isTypeOnly = !!m[1]; // group 1: "type " keyword
    const names: string[] = [];
    if (m[2]) names.push(...m[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    if (m[3]) {
      const group3 = m[3].trim();
      // Namespace import (* as foo): edge is valid but no named import to extract
      if (!group3.startsWith("*")) {
        names.push(group3);
      }
    }
    if (m[4]) names.push(...m[4].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    imports.push({ specifier: m[5], importedNames: names, isTypeOnly });
  }

  // import '...' (side-effect)
  for (const m of content.matchAll(JS_IMPORT_SIDE)) {
    // Skip if already captured by JS_IMPORT_FROM (side-effect imports have no bindings)
    if (!content.includes(`from '${m[1]}'`) && !content.includes(`from "${m[1]}"`)) {
      imports.push({ specifier: m[1], importedNames: [] });
    }
  }

  // require('...')
  for (const m of content.matchAll(JS_REQUIRE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  // dynamic import('...')
  for (const m of content.matchAll(JS_DYNAMIC)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  return imports;
}

export function parsePythonImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(PY_FROM_IMPORT)) {
    const module = m[1];
    const names = m[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    imports.push({ specifier: module, importedNames: names });
  }

  for (const m of content.matchAll(PY_IMPORT)) {
    const modules = m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    for (const mod of modules) {
      imports.push({ specifier: mod, importedNames: [] });
    }
  }

  return imports;
}

export function parseGoImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(GO_IMPORT_SINGLE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  for (const m of content.matchAll(GO_IMPORT_BLOCK)) {
    const block = m[1];
    for (const line of block.split("\n")) {
      // Skip comment lines
      if (line.trim().startsWith("//")) continue;
      const match = line.match(/["']([^"']+)["']/);
      if (match) {
        imports.push({ specifier: match[1], importedNames: [] });
      }
    }
  }

  return imports;
}

export function parseRustImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(RUST_USE)) {
    const usePath = m[1];
    // Check for glob imports like crate::foo::{Bar, Baz}
    const globMatch = usePath.match(/::\{([^}]*)\}$/);
    if (globMatch) {
      const names = globMatch[1].split(",").map((n) => n.trim()).filter(Boolean);
      imports.push({ specifier: usePath, importedNames: names });
    } else {
      const parts = usePath.split("::");
      const name = parts[parts.length - 1];
      imports.push({ specifier: usePath, importedNames: name ? [name] : [] });
    }
  }

  for (const m of content.matchAll(RUST_MOD)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  return imports;
}

function parseImports(content: string, lang: Language): RawImport[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseJsImports(content);
    case "python":
      return parsePythonImports(content);
    case "go":
      return parseGoImports(content);
    case "rust":
      return parseRustImports(content);
    default:
      return parseJsImports(content);
  }
}

// ── Resolve relative imports to file paths ────────────────────────────

function isRelativeSpecifier(spec: string, lang: Language): boolean {
  if (lang === "typescript" || lang === "javascript") {
    return spec.startsWith("./") || spec.startsWith("../");
  }
  if (lang === "python") {
    return spec.startsWith(".");
  }
  if (lang === "rust") {
    return spec.startsWith("crate::") || spec.startsWith("super::") || spec.startsWith("self::");
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

function resolveImport(
  specifier: string,
  fromFile: string,
  lang: Language,
  allFiles: Set<string>,
): string | null {
  switch (lang) {
    case "typescript":
    case "javascript":
      return resolveJsImport(specifier, fromFile, allFiles);
    case "python":
      return resolvePythonImport(specifier, fromFile, allFiles);
    default:
      // Go and Rust: module paths are harder to resolve reliably
      // without a full build system. Skip resolution for now.
      return null;
  }
}

// ── HITS (Kleinberg) centrality ───────────────────────────────────────

/**
 * Compute HITS authority and hub scores for all files.
 *
 * Edge weight: (1 - typeOnlyDiscount) * specificity
 * - typeOnlyDiscount = 0.7 if isTypeOnly, else 0
 * - specificity = log2(importedNames.length + 1) / log2(6), clamped min 0.2
 */
export function computeHITS(
  files: string[],
  edges: ImportEdge[],
  maxIterations = 30,
  epsilon = 1e-6,
): { authority: Map<string, number>; hub: Map<string, number> } {
  const n = files.length;
  if (n === 0) return { authority: new Map(), hub: new Map() };

  const fileSet = new Set(files);

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
    const nameCount = edge.importedNames.length;
    const specificity = nameCount > 0
      ? Math.max(0.2, Math.log2(nameCount + 1) / Math.log2(6))
      : 0.2;
    const weight = (1 - typeOnlyDiscount) * specificity;

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

    // Update authorities: newAuth[v] = Σ hub[u] * w(u→v)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { from, weight } of reverse.get(file)!) {
        sum += hub[fileIndex.get(from)!] * weight;
      }
      newAuth[vi] = sum;
    }

    // Update hubs (using new auth): newHub[v] = Σ newAuth[w] * w(v→w)
    for (let vi = 0; vi < n; vi++) {
      const file = files[vi];
      let sum = 0;
      for (const { to, weight } of forward.get(file)!) {
        sum += newAuth[fileIndex.get(to)!] * weight;
      }
      newHub[vi] = sum;
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
 */
export function deriveRole(authority: number, hubScore: number): FileRole {
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
  const globs = getSourceGlob(language);
  let files: string[];
  try {
    files = await fg(globs, {
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
      return { edges: [], inDegree: new Map(), centrality: new Map(), externalImportCounts: new Map(), authority: new Map(), hubScores: new Map() };
    }
    throw err;
  }

  onProgress?.(`Found ${files.length} source files to analyze`);

  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const inDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  // Load path aliases for TS/JS projects
  const pathAliases = (language === "typescript" || language === "javascript")
    ? await loadTsconfigPaths(rootDir)
    : [];
  if (pathAliases.length > 0) {
    onProgress?.(`Loaded ${pathAliases.length} path alias(es) from tsconfig`);
  }

  // Init in-degree
  for (const file of files) inDegree.set(file, 0);

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
        const resolved = resolveImport(raw.specifier, file, language, fileSet);
        if (resolved) {
          edges.push({
            from: file,
            to: resolved,
            isExternal: false,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
          });
          inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
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
          });
          inDegree.set(aliasResolved, (inDegree.get(aliasResolved) ?? 0) + 1);
        } else {
          // External package
          // Normalize specifier to package name (e.g. @scope/pkg/path -> @scope/pkg)
          const pkgName = getPackageName(raw.specifier);
          edges.push({
            from: file,
            to: pkgName,
            isExternal: true,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
          });
          externalImportCounts.set(
            pkgName,
            (externalImportCounts.get(pkgName) ?? 0) + 1,
          );
        }
      }
    }
  }

  onProgress?.("Computing centrality (HITS)...");
  const { authority, hub: hubScores } = computeHITS(files, edges);

  // Use authority as centrality for backward compat (snapshot.ts etc.)
  return { edges, inDegree, centrality: authority, externalImportCounts, authority, hubScores };
}

/**
 * Extract the package name from an import specifier.
 * e.g. "@tanstack/react-query" -> "@tanstack/react-query"
 *      "react/jsx-runtime" -> "react"
 *      "zustand" -> "zustand"
 */
function getPackageName(specifier: string): string {
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
      const role = deriveRole(authority, hubScore);
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

  function strongconnect(v: string): void {
    indices.set(v, index);
    lowlinks.set(v, index);
    index++;
    stack.push(v);
    onStack.add(v);

    for (const w of adj.get(v) ?? []) {
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      if (scc.length > 1) {
        sccs.push(scc);
      }
    }
  }

  for (const file of allFiles) {
    if (!indices.has(file)) {
      strongconnect(file);
    }
  }

  return sccs;
}

/**
 * Detect circular dependencies using Tarjan's SCC algorithm.
 * Each SCC with size > 1 is reported as a circular dependency chain.
 * Returns up to maxCycles results.
 */
export function findCircularDeps(
  graph: ImportGraph,
  maxCycles = 10,
): CircularDependency[] {
  const sccs = findSCCs(graph);

  // Convert SCCs to circular dependency chains
  // Sort by size (smallest first, more actionable)
  sccs.sort((a, b) => a.length - b.length);

  const cycles: CircularDependency[] = [];
  for (const scc of sccs) {
    if (cycles.length >= maxCycles) break;
    // Create a chain by closing the loop
    cycles.push({ chain: [...scc, scc[0]] });
  }

  return cycles;
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
 */
export function detectArchitecturalLayers(graph: ImportGraph): { layers: ArchitecturalLayer[]; layerEdges: LayerEdge[] } {
  // Classify each internal file into a layer
  const layerFiles = new Map<string, string[]>();
  const fileToLayer = new Map<string, string>();

  for (const [filePath] of graph.centrality) {
    for (const { name, pattern } of LAYER_PATTERNS) {
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

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > 0.7 and fanIn >= 1 (high-risk zones).
 */
export function computeInstability(graph: ImportGraph): FileInstability[] {
  // Count outgoing internal edges per file
  const fanOutMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + 1);
    }
  }

  const results: FileInstability[] = [];
  for (const [filePath, fanIn] of graph.inDegree) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    const instability = fanOut / total;
    if (instability > 0.7 && fanIn >= 1) {
      results.push({ path: filePath, fanIn, fanOut, instability });
    }
  }

  // Sort by instability descending
  results.sort((a, b) => b.instability - a.instability);
  return results;
}

/**
 * Detect communities of tightly-connected files using label propagation.
 * Each file starts with a unique label; iteratively adopts the most common
 * label among its neighbors (both directions). Returns communities with size >= 3.
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

  const files = [...allFiles];
  if (files.length === 0) return [];

  // Initialize: each file gets its own numeric label
  const labels = new Map<string, number>();
  for (let i = 0; i < files.length; i++) {
    labels.set(files[i], i);
  }

  // Iterate label propagation (~10 rounds)
  for (let iter = 0; iter < 10; iter++) {
    let changed = false;
    // Shuffle order for better convergence
    const shuffled = [...files];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    for (const file of shuffled) {
      const neighbors = adj.get(file);
      if (!neighbors || neighbors.size === 0) continue;

      // Count neighbor labels
      const labelCounts = new Map<number, number>();
      for (const neighbor of neighbors) {
        const lbl = labels.get(neighbor)!;
        labelCounts.set(lbl, (labelCounts.get(lbl) ?? 0) + 1);
      }

      // Find most common label
      let maxCount = 0;
      let bestLabel = labels.get(file)!;
      for (const [lbl, count] of labelCounts) {
        if (count > maxCount) {
          maxCount = count;
          bestLabel = lbl;
        }
      }

      if (bestLabel !== labels.get(file)) {
        labels.set(file, bestLabel);
        changed = true;
      }
    }

    if (!changed) break;
  }

  // Group files by label
  const groups = new Map<number, string[]>();
  for (const [file, label] of labels) {
    const group = groups.get(label) ?? [];
    group.push(file);
    groups.set(label, group);
  }

  // Filter to communities with size >= 3, derive labels from common dir prefix
  const communities: Community[] = [];
  let id = 0;
  for (const files of groups.values()) {
    if (files.length < 3) continue;
    const label = deriveLabel(files);
    communities.push({ id: id++, files: files.sort(), label });
  }

  // Sort by size descending
  communities.sort((a, b) => b.files.length - a.files.length);
  return communities;
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
    if (/^(index|main|app|server|cli)\.[jt]sx?$/.test(basename)) continue;
    if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") continue;
    if (basename === "main.go" || basename === "main.py") continue;

    dead.push(file);
  }

  return dead.sort();
}

/**
 * Compute export coverage for each file: how many of its exports
 * are actually imported by other files in the project.
 */
export function computeExportCoverage(graph: ImportGraph): ExportCoverage[] {
  const usedExports = findUsedExports(graph.edges);

  // Count total named exports per file (from outgoing edges' importedNames at target)
  // We know a file exports a name if any edge targets it with that name
  const allExportsByFile = new Map<string, Set<string>>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    for (const name of edge.importedNames) {
      if (!allExportsByFile.has(edge.to)) allExportsByFile.set(edge.to, new Set());
      allExportsByFile.get(edge.to)!.add(name);
    }
  }

  const results: ExportCoverage[] = [];
  for (const [file, exports] of allExportsByFile) {
    const totalExports = exports.size;
    if (totalExports === 0) continue;
    let usedCount = 0;
    for (const name of exports) {
      if (usedExports.has(`${file}::${name}`)) usedCount++;
    }
    results.push({
      file,
      totalExports,
      usedExports: usedCount,
      coverage: usedCount / totalExports,
    });
  }

  // Sort by coverage ascending (worst coverage first)
  results.sort((a, b) => a.coverage - b.coverage);
  return results;
}
