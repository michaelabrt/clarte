import path from "node:path";
import fg from "fast-glob";
import { readFileOr } from "./utils.js";
import type { ImportEdge, ImportGraph, Language } from "./types.js";

// ── Import regex patterns per language ────────────────────────────────

/** JS/TS: import ... from '...' */
const JS_IMPORT_FROM = /import\s+(?:\{([^}]*)\}|(\w+)(?:\s*,\s*\{([^}]*)\})?)\s+from\s+['"]([^'"]+)['"]/g;
/** JS/TS: import '...' (side-effect) */
const JS_IMPORT_SIDE = /import\s+['"]([^'"]+)['"]/g;
/** JS/TS: require('...') */
const JS_REQUIRE = /require\(\s*['"]([^'"]+)['"]\s*\)/g;
/** JS/TS: dynamic import('...') */
const JS_DYNAMIC = /import\(\s*['"]([^'"]+)['"]\s*\)/g;

/** Python: from foo.bar import baz, qux */
const PY_FROM_IMPORT = /^from\s+([\w.]+)\s+import\s+(.+)/gm;
/** Python: import foo, bar */
const PY_IMPORT = /^import\s+([\w., ]+)/gm;

/** Go: import "pkg" or import ( "pkg" ) */
const GO_IMPORT_SINGLE = /import\s+"([^"]+)"/g;
const GO_IMPORT_BLOCK = /import\s*\(([^)]+)\)/gs;

/** Rust: use crate::foo::bar */
const RUST_USE = /use\s+((?:crate|super|self)::[\w:]+)/g;
/** Rust: mod foo; */
const RUST_MOD = /mod\s+(\w+)\s*;/g;

// ── File extensions to try when resolving relative imports ────────────

const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const INDEX_FILES = JS_EXTENSIONS.map((e) => `/index${e}`);

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

interface RawImport {
  specifier: string;
  importedNames: string[];
}

function parseJsImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  // import { a, b } from '...' / import Foo from '...' / import Foo, { a } from '...'
  for (const m of content.matchAll(JS_IMPORT_FROM)) {
    const names: string[] = [];
    if (m[1]) names.push(...m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    if (m[2]) names.push(m[2].trim());
    if (m[3]) names.push(...m[3].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    imports.push({ specifier: m[4], importedNames: names });
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

function parsePythonImports(content: string): RawImport[] {
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

function parseGoImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(GO_IMPORT_SINGLE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  for (const m of content.matchAll(GO_IMPORT_BLOCK)) {
    const block = m[1];
    for (const line of block.split("\n")) {
      const match = line.match(/["']([^"']+)["']/);
      if (match) {
        imports.push({ specifier: match[1], importedNames: [] });
      }
    }
  }

  return imports;
}

function parseRustImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(RUST_USE)) {
    const path = m[1];
    const parts = path.split("::");
    const name = parts[parts.length - 1];
    imports.push({ specifier: path, importedNames: name ? [name] : [] });
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
  const base = path.join(dir, specifier).replace(/\\/g, "/");

  // Exact match (already has extension)
  if (allFiles.has(base)) return base;

  // Try adding extensions
  for (const ext of JS_EXTENSIONS) {
    const candidate = base + ext;
    if (allFiles.has(candidate)) return candidate;
  }

  // Try index files
  for (const idx of INDEX_FILES) {
    const candidate = base + idx;
    if (allFiles.has(candidate)) return candidate;
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

// ── PageRank centrality ───────────────────────────────────────────────

function computePageRank(
  files: string[],
  edges: ImportEdge[],
  iterations = 5,
  damping = 0.85,
): Map<string, number> {
  const n = files.length;
  if (n === 0) return new Map();

  // Build adjacency: from -> [to, ...]
  const outLinks = new Map<string, string[]>();
  for (const file of files) outLinks.set(file, []);
  for (const edge of edges) {
    if (!edge.isExternal && outLinks.has(edge.from)) {
      outLinks.get(edge.from)!.push(edge.to);
    }
  }

  // Init scores
  let scores = new Map<string, number>();
  const init = 1 / n;
  for (const file of files) scores.set(file, init);

  // Iterate
  for (let iter = 0; iter < iterations; iter++) {
    const next = new Map<string, number>();
    for (const file of files) next.set(file, (1 - damping) / n);

    for (const file of files) {
      const links = outLinks.get(file) ?? [];
      if (links.length === 0) continue;
      const share = (damping * (scores.get(file) ?? 0)) / links.length;
      for (const target of links) {
        next.set(target, (next.get(target) ?? 0) + share);
      }
    }
    scores = next;
  }

  // Normalize to 0–1
  let max = 0;
  for (const v of scores.values()) {
    if (v > max) max = v;
  }
  if (max > 0) {
    for (const [k, v] of scores) {
      scores.set(k, v / max);
    }
  }

  return scores;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Build the import graph for a project.
 */
export async function buildImportGraph(
  rootDir: string,
  language: Language,
): Promise<ImportGraph> {
  const globs = getSourceGlob(language);
  const files = await fg(globs, {
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
    ],
    absolute: false,
  });

  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const inDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  // Init in-degree
  for (const file of files) inDegree.set(file, 0);

  for (const file of files) {
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
          });
          inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
        }
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
        });
        externalImportCounts.set(
          pkgName,
          (externalImportCounts.get(pkgName) ?? 0) + 1,
        );
      }
    }
  }

  const centrality = computePageRank(files, edges);

  return { edges, inDegree, centrality, externalImportCounts };
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
