import path from "node:path";
import { glob } from "tinyglobby";
import { readFileOr, readJsonFile } from "./utils.js";
import type {
  ArchitecturalLayer,
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
  TransitiveDependencyRisk,
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

/** Java: import com.foo.Bar; or import static com.foo.Bar.method; */
const JAVA_IMPORT = /^import\s+(?:static\s+)?([\w.]+(?:\.\*)?)\s*;/gm;

// ── Comment/string stripping for accurate import parsing ──────────────

/**
 * Strip comments and string literals from JS/TS source code.
 * Replaces stripped content with whitespace to preserve line structure.
 *
 * When `commentsOnly` is true, only strips comments (preserves strings).
 * This is used for import parsing where specifiers live inside strings.
 *
 * When `commentsOnly` is false, strips both comments and strings.
 * This is used for brace counting where string content is noise.
 */
export function stripCommentsAndStrings(content: string, commentsOnly = false): string {
  let result = "";
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];
    const next = i + 1 < len ? content[i + 1] : "";

    // Single-line comment: // ...
    if (ch === "/" && next === "/") {
      result += "  ";
      i += 2;
      while (i < len && content[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }

    // Block comment: /* ... */
    if (ch === "/" && next === "*") {
      result += "  ";
      i += 2;
      while (i < len) {
        if (content[i] === "*" && i + 1 < len && content[i + 1] === "/") {
          result += "  ";
          i += 2;
          break;
        }
        result += content[i] === "\n" ? "\n" : " ";
        i++;
      }
      continue;
    }

    if (!commentsOnly) {
      // Template literal: `...` (handles nested ${} by tracking depth)
      if (ch === "`") {
        result += " ";
        i++;
        let braceDepth = 0;
        while (i < len) {
          if (content[i] === "\\" && i + 1 < len) {
            result += "  ";
            i += 2;
            continue;
          }
          if (content[i] === "$" && i + 1 < len && content[i + 1] === "{") {
            result += "  ";
            i += 2;
            braceDepth++;
            continue;
          }
          if (braceDepth > 0 && content[i] === "}") {
            result += " ";
            i++;
            braceDepth--;
            continue;
          }
          if (braceDepth === 0 && content[i] === "`") {
            result += " ";
            i++;
            break;
          }
          result += content[i] === "\n" ? "\n" : " ";
          i++;
        }
        continue;
      }

      // String literal: "..." or '...'
      if (ch === '"' || ch === "'") {
        const quote = ch;
        result += " ";
        i++;
        while (i < len) {
          if (content[i] === "\\" && i + 1 < len) {
            result += "  ";
            i += 2;
            continue;
          }
          if (content[i] === quote) {
            result += " ";
            i++;
            break;
          }
          if (content[i] === "\n") break; // unterminated string
          result += " ";
          i++;
        }
        continue;
      }
    } else {
      // In commentsOnly mode, skip past strings without stripping them
      // so the parser doesn't confuse string contents with comment starts
      if (ch === "`") {
        result += ch;
        i++;
        let braceDepth = 0;
        while (i < len) {
          result += content[i];
          if (content[i] === "\\" && i + 1 < len) { i++; result += content[i]; i++; continue; }
          if (content[i] === "$" && i + 1 < len && content[i + 1] === "{") { i++; result += content[i]; i++; braceDepth++; continue; }
          if (braceDepth > 0 && content[i] === "}") { i++; braceDepth--; continue; }
          if (braceDepth === 0 && content[i] === "`") { i++; break; }
          i++;
        }
        continue;
      }
      if (ch === '"' || ch === "'") {
        const quote = ch;
        result += ch;
        i++;
        while (i < len) {
          result += content[i];
          if (content[i] === "\\" && i + 1 < len) { i++; result += content[i]; i++; continue; }
          if (content[i] === quote) { i++; break; }
          if (content[i] === "\n") break;
          i++;
        }
        continue;
      }
    }

    result += ch;
    i++;
  }

  return result;
}

/**
 * Strip comments from Python source code.
 * Only strips `#` comments (preserves strings for import parsing).
 */
function stripPythonComments(content: string): string {
  let result = "";
  let i = 0;
  const len = content.length;

  while (i < len) {
    const ch = content[i];

    // Triple-quoted strings: skip past them (don't strip, but don't match # inside)
    if (i + 2 < len) {
      const triple = content.slice(i, i + 3);
      if (triple === '"""' || triple === "'''") {
        result += triple;
        i += 3;
        while (i < len) {
          if (i + 2 < len && content.slice(i, i + 3) === triple) {
            result += triple;
            i += 3;
            break;
          }
          result += content[i];
          i++;
        }
        continue;
      }
    }

    // Single-line strings: skip past them
    if (ch === '"' || ch === "'") {
      const quote = ch;
      result += ch;
      i++;
      while (i < len) {
        result += content[i];
        if (content[i] === "\\" && i + 1 < len) { i++; result += content[i]; i++; continue; }
        if (content[i] === quote) { i++; break; }
        if (content[i] === "\n") break;
        i++;
      }
      continue;
    }

    // Comment: # ...
    if (ch === "#") {
      result += " ";
      i++;
      while (i < len && content[i] !== "\n") {
        result += " ";
        i++;
      }
      continue;
    }

    result += ch;
    i++;
  }

  return result;
}

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
    case "java":
      return ["**/*.java"];
    default:
      return ["**/*.{ts,tsx,js,jsx,py,go,rs,java}"];
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
  const cleaned = stripCommentsAndStrings(content, true);
  const imports: RawImport[] = [];

  // import { a, b } from '...' / import Foo from '...' / import Foo, { a } from '...' / import * as Foo from '...'
  const fromSpecifiers = new Set<string>();
  for (const m of cleaned.matchAll(JS_IMPORT_FROM)) {
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
    fromSpecifiers.add(m[5]);
    imports.push({ specifier: m[5], importedNames: names, isTypeOnly });
  }

  // import '...' (side-effect)
  for (const m of cleaned.matchAll(JS_IMPORT_SIDE)) {
    // Skip if already captured by JS_IMPORT_FROM
    if (!fromSpecifiers.has(m[1])) {
      imports.push({ specifier: m[1], importedNames: [] });
    }
  }

  // require('...')
  for (const m of cleaned.matchAll(JS_REQUIRE)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  // dynamic import('...')
  for (const m of cleaned.matchAll(JS_DYNAMIC)) {
    imports.push({ specifier: m[1], importedNames: [] });
  }

  return imports;
}

export function parsePythonImports(content: string): RawImport[] {
  const cleaned = stripPythonComments(content);
  const imports: RawImport[] = [];

  for (const m of cleaned.matchAll(PY_FROM_IMPORT)) {
    const module = m[1];
    const names = m[2].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean);
    imports.push({ specifier: module, importedNames: names });
  }

  for (const m of cleaned.matchAll(PY_IMPORT)) {
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

export function parseJavaImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  for (const m of content.matchAll(JAVA_IMPORT)) {
    const fullPath = m[1]; // e.g. "com.example.Foo" or "com.example.*"
    const parts = fullPath.split(".");
    const lastName = parts[parts.length - 1];
    const names = lastName === "*" ? [] : [lastName];
    imports.push({ specifier: fullPath, importedNames: names });
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
    case "java":
      return parseJavaImports(content);
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
  pathAliases?: PathAlias[],
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
    default:
      // Go and Rust: module paths are harder to resolve reliably
      // without a full build system. Skip resolution for now.
      return null;
  }
}

// ── Barrel file (re-export) resolution ────────────────────────────────

/** Regex to match re-export statements: export { ... } from '...' / export * from '...' */
const RE_EXPORT_NAMED = /export\s+\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/g;
const RE_EXPORT_STAR = /export\s+\*\s+from\s+['"]([^'"]+)['"]/g;

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
    // Only scan index files as potential barrels
    const basename = path.basename(file).replace(/\.[^.]+$/, "");
    if (basename !== "index") continue;

    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const cleaned = stripCommentsAndStrings(content, true);
    const nameMap = new Map<string, string>();
    const starSet = new Set<string>();

    // export { Foo, Bar as Baz } from './source'
    for (const m of cleaned.matchAll(RE_EXPORT_NAMED)) {
      const namesBlock = m[1];
      const specifier = m[2];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;

      const resolved = resolveJsImport(specifier, file, fileSet);
      if (!resolved) continue;

      for (const nameStr of namesBlock.split(",")) {
        const trimmed = nameStr.trim();
        if (!trimmed) continue;
        // Handle "Foo as Bar" -> exported as Bar, from resolved file
        const parts = trimmed.split(/\s+as\s+/);
        const exportedName = parts.length > 1 ? parts[1].trim() : parts[0].trim();
        nameMap.set(exportedName, resolved);
      }
    }

    // export * from './source'
    for (const m of cleaned.matchAll(RE_EXPORT_STAR)) {
      const specifier = m[1];
      if (!specifier.startsWith("./") && !specifier.startsWith("../")) continue;

      const resolved = resolveJsImport(specifier, file, fileSet);
      if (resolved) starSet.add(resolved);
    }

    if (nameMap.size > 0) namedExports.set(file, nameMap);
    if (starSet.size > 0) starExports.set(file, starSet);
  }

  return { namedExports, starExports };
}

// ── HITS (Kleinberg) centrality ───────────────────────────────────────

/**
 * Compute HITS authority and hub scores for all files.
 *
 * Edge weight: (1 - typeOnlyDiscount) * specificity
 * - typeOnlyDiscount = 0.7 if isTypeOnly, else 0
 * - specificity = log2(importedNames.length + 1) / log2(6), clamped min 0.2
 *
 * Uses teleportation smoothing (alpha=0.15) to avoid extreme score distributions
 * in star-shaped graphs. Hub update uses prior-iteration authority (standard HITS).
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

      if (isRelative || (pathAliases.length > 0 && !isRelative)) {
        const resolved = resolveImport(raw.specifier, file, language, fileSet, pathAliases);
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

            // Create edges to resolved source files
            for (const [source, names] of routedNames) {
              edges.push({
                from: file,
                to: source,
                isExternal: false,
                specifier: raw.specifier,
                importedNames: names,
                isTypeOnly: raw.isTypeOnly,
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
            });
            inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
          }
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
  const shortName = (f: string) => f.split("/").pop()?.replace(/\.[^.]+$/, "") ?? f;
  for (const cycle of allCycles) {
    const edges: Array<{ from: string; to: string; isTypeOnly: boolean }> = [];
    for (let i = 0; i < cycle.chain.length - 1; i++) {
      const key = `${cycle.chain[i]}->${cycle.chain[i + 1]}`;
      const e = edgeLookup.get(key);
      edges.push({ from: cycle.chain[i], to: cycle.chain[i + 1], isTypeOnly: !!e?.isTypeOnly });
    }
    const runtimeEdges = edges.filter((e) => !e.isTypeOnly);
    cycle.severity = edges.length > 0 ? runtimeEdges.length / edges.length : 0;

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
  const sccAdj = new Map<string, string[]>();
  for (const node of scc) {
    const neighbors = adj.get(node);
    if (neighbors) {
      sccAdj.set(node, [...neighbors].filter((n) => sccSet.has(n)));
    } else {
      sccAdj.set(node, []);
    }
  }

  const seenCanonical = new Set<string>();
  const cycles: CircularDependency[] = [];

  // 1. Find all mutual imports (2-cycles) first -- most actionable
  const sortedScc = [...scc].sort();
  for (const a of sortedScc) {
    for (const b of sccAdj.get(a) ?? []) {
      if (a < b && (sccAdj.get(b) ?? []).includes(a)) {
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
  for (const start of sortedScc) {
    if (cycles.length >= maxCycles) break;

    // BFS from start, looking for path back to start
    const visited = new Set<string>();
    const queue: Array<{ node: string; path: string[] }> = [];

    for (const neighbor of sccAdj.get(start) ?? []) {
      queue.push({ node: neighbor, path: [start, neighbor] });
    }

    while (queue.length > 0) {
      const { node, path } = queue.shift()!;

      if (node === start) {
        // path already ends with start, forming a closed cycle
        const chain = path;
        // Skip 2-cycles (already found above)
        if (chain.length > 3) {
          const key = canonicalizeCycle(chain);
          if (!seenCanonical.has(key)) {
            seenCanonical.add(key);
            cycles.push({ chain });
            if (cycles.length >= maxCycles) return cycles;
          }
        }
        continue;
      }

      if (visited.has(node)) continue;
      visited.add(node);

      // Cap path length at SCC size to avoid explosion
      // Use > (not >=) so full-SCC cycles can close (path + closing node = scc.length + 1)
      if (path.length > scc.length) continue;

      for (const next of sccAdj.get(node) ?? []) {
        if (!visited.has(next) || next === start) {
          queue.push({ node: next, path: [...path, next] });
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

/** Threshold above which a file is considered high-instability */
export const INSTABILITY_THRESHOLD = 0.8;

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > INSTABILITY_THRESHOLD and fanIn >= 1 (high-risk zones).
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
    if (instability > INSTABILITY_THRESHOLD && fanIn >= 1) {
      results.push({ path: filePath, fanIn, fanOut, instability });
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

  function dfs(u: string): void {
    disc.set(u, timer);
    low.set(u, timer);
    timer++;
    let childCount = 0;

    for (const v of adj.get(u) ?? []) {
      if (!disc.has(v)) {
        childCount++;
        parent.set(v, u);
        dfs(v);
        low.set(u, Math.min(low.get(u)!, low.get(v)!));

        // Root with 2+ children
        if (parent.get(u) == null && childCount > 1) {
          articulationPoints.add(u);
        }
        // Non-root where no back edge from subtree reaches above u
        if (parent.get(u) != null && low.get(v)! >= disc.get(u)!) {
          articulationPoints.add(u);
        }
      } else if (v !== parent.get(u)) {
        low.set(u, Math.min(low.get(u)!, disc.get(v)!));
      }
    }
  }

  // Run DFS from each unvisited node (handles disconnected components)
  const sortedFiles = [...allFiles].sort();
  for (const file of sortedFiles) {
    if (!disc.has(file)) {
      parent.set(file, null);
      dfs(file);
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
    visited.add(file);
    while (queue.length > 0) {
      const current = queue.shift()!;
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

// ── BFS Shortest Path ──────────────────────────────────────────────────

/**
 * Find the shortest path between two files in the import graph using BFS.
 * Follows directed edges (from -> to). Returns the path as an array of
 * file paths including both endpoints, or null if no path exists.
 */
export function bfsShortestPath(
  graph: ImportGraph,
  from: string,
  to: string,
): string[] | null {
  if (from === to) return [from];

  // Build directed adjacency from internal edges
  const adj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const list = adj.get(edge.from) ?? [];
    list.push(edge.to);
    adj.set(edge.from, list);
  }

  const visited = new Set<string>();
  const parent = new Map<string, string>();
  const queue = [from];
  visited.add(from);

  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const neighbor of adj.get(current) ?? []) {
      if (visited.has(neighbor)) continue;
      visited.add(neighbor);
      parent.set(neighbor, current);
      if (neighbor === to) {
        // Reconstruct path
        const path: string[] = [to];
        let node = to;
        while (node !== from) {
          node = parent.get(node)!;
          path.unshift(node);
        }
        return path;
      }
      queue.push(neighbor);
    }
  }

  return null;
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
    visited.add(file);
    while (queue.length > 0) {
      const current = queue.shift()!;
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

// ── Transitive Dependency Risk ─────────────────────────────────────────

/**
 * Compute transitive dependency risk for each file by weighting instability
 * with dependency volatility. Uses BFS with exponential decay.
 *
 * A file importing 5 stable utilities scores lower than a file importing
 * 1 volatile service, because the transitive risk from volatile dependencies
 * propagates through the graph.
 *
 * Requires git analysis data for churn information. Returns empty array
 * if git data is unavailable.
 */
export function computeTransitiveRisk(
  graph: ImportGraph,
  commitCounts: Map<string, number>,
  maxDepth = 5,
  topN = 15,
): TransitiveDependencyRisk[] {
  if (commitCounts.size === 0) return [];

  // Build directed adjacency from internal edges (outgoing deps)
  const outgoing = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!outgoing.has(edge.from)) outgoing.set(edge.from, new Set());
    outgoing.get(edge.from)!.add(edge.to);
  }

  // Normalize churn across all files
  let maxChurn = 0;
  for (const count of commitCounts.values()) {
    if (count > maxChurn) maxChurn = count;
  }
  if (maxChurn === 0) return [];

  const results: TransitiveDependencyRisk[] = [];

  for (const [file] of graph.inDegree) {
    const visited = new Set<string>();
    const queue: Array<{ node: string; depth: number }> = [{ node: file, depth: 0 }];
    let transitiveRisk = 0;
    let totalWeight = 0;

    while (queue.length > 0) {
      const { node, depth } = queue.shift()!;
      if (depth > maxDepth || visited.has(node)) continue;
      visited.add(node);

      if (depth > 0) {
        const decay = Math.pow(0.5, depth); // half-life per hop
        const volatility = (commitCounts.get(node) ?? 0) / maxChurn;
        transitiveRisk += volatility * decay;
        totalWeight += decay;
      }

      for (const dep of outgoing.get(node) ?? []) {
        if (!visited.has(dep)) {
          queue.push({ node: dep, depth: depth + 1 });
        }
      }
    }

    const directVolatility = (commitCounts.get(file) ?? 0) / maxChurn;
    const transitiveVolatility = totalWeight > 0 ? transitiveRisk / totalWeight : 0;
    const riskScore = directVolatility * 0.3 + transitiveVolatility * 0.7;

    if (riskScore > 0.1) { // Only include files with meaningful risk
      results.push({ path: file, directVolatility, transitiveVolatility, riskScore });
    }
  }

  results.sort((a, b) => b.riskScore - a.riskScore);
  return results.slice(0, topN);
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
    visited.add(from);
    while (queue.length > 0) {
      const { node, dist } = queue.shift()!;
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
