import path from "node:path";
import { IGNORE_GLOBS } from "./ignore-patterns.js";
import { readFileOr, readJsonFile } from "./utils.js";
import { parseImportsAst } from "./parsers/parse-imports.js";
import { resolveBarrelExportsAst } from "./parsers/barrel.js";
import type { Language } from "./types.js";

export type { RawImport } from "./parsers/types.js";
type RawImport = import("./parsers/types.js").RawImport;

/**
 * Resolution priority: .ts > .tsx > .js > .jsx > .mjs
 * When both foo.ts and foo.tsx exist, .ts wins deterministically
 * because it appears first in this array and we return on first match.
 */
export const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
export const INDEX_FILES = JS_EXTENSIONS.map((e) => `/index${e}`);

/** Ignore patterns matching buildImportGraph in graph.ts */
export const SOURCE_IGNORE = IGNORE_GLOBS;

export interface PathAlias {
  /** The alias prefix (e.g. "@/", "@components/") */
  prefix: string;
  /** The replacement path (relative to rootDir) */
  replacement: string;
}

/**
 * Load path aliases from tsconfig.json, following `extends` chains up to 5 levels.
 * Returns an array of PathAlias objects for resolving aliased imports.
 */
export async function loadTsconfigPaths(rootDir: string): Promise<PathAlias[]> {
  let configPath = path.join(rootDir, "tsconfig.json");
  let baseUrl = ".";
  const paths: Record<string, string[]> = {};

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

    configPath = path.resolve(path.dirname(configPath), ext);
    if (!configPath.endsWith(".json")) configPath += ".json";
  }

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
export function resolveAliasImport(specifier: string, aliases: PathAlias[], allFiles: Set<string>): string | null {
  for (const alias of aliases) {
    if (specifier.startsWith(alias.prefix)) {
      const remainder = specifier.slice(alias.prefix.length);
      const raw = (alias.replacement + remainder).replace(/\\/g, "/");
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

export function getSourceGlob(lang: Language): string[] {
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

export function parseImports(content: string, lang: Language, filePath?: string): RawImport[] {
  return parseImportsAst(content, lang, filePath);
}

export function isRelativeSpecifier(spec: string, lang: Language): boolean {
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
    return (
      spec.startsWith("crate::") || spec.startsWith("super::") || spec.startsWith("self::") || spec.startsWith("mod::")
    );
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
export function resolveJsImport(specifier: string, fromFile: string, allFiles: Set<string>): string | null {
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
export async function loadGoModule(rootDir: string): Promise<string | null> {
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
function resolveGoImport(specifier: string, goModulePath: string, allFiles: Set<string>): string | null {
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
function resolvePythonImport(specifier: string, fromFile: string, allFiles: Set<string>): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.dirname(fromFile);
  let dots = 0;
  while (specifier[dots] === ".") dots++;
  const modulePath = specifier.slice(dots).replace(/\./g, "/");
  let baseDir = dir;
  for (let i = 1; i < dots; i++) {
    baseDir = path.dirname(baseDir);
  }
  const base = modulePath ? path.join(baseDir, modulePath).replace(/\\/g, "/") : baseDir;

  if (allFiles.has(base + ".py")) return base + ".py";
  if (allFiles.has(base + "/__init__.py")) return base + "/__init__.py";

  return null;
}

/**
 * Detect Java source root prefixes from the file list.
 * Looks for common patterns like "src/main/java/" or "src/".
 */
export function detectJavaSourceRoots(allFiles: string[]): string[] {
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
function resolveJavaImport(specifier: string, allFiles: Set<string>, sourceRoots: string[]): string | null {
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
function resolveRustImport(specifier: string, fromFile: string, allFiles: Set<string>): string | null {
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
function resolveRustModDecl(modName: string, fromFile: string, allFiles: Set<string>): string | null {
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
function resolveRustModulePath(baseDir: string, segments: string[], allFiles: Set<string>): string | null {
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

export interface ResolveContext {
  goModulePath?: string | null;
  javaSourceRoots?: string[];
}

export function resolveImport(
  specifier: string,
  fromFile: string,
  lang: Language,
  allFiles: Set<string>,
  ctx: ResolveContext = {},
): string | null {
  switch (lang) {
    case "typescript":
    case "javascript":
      return resolveJsImport(specifier, fromFile, allFiles);
    case "python":
      return resolvePythonImport(specifier, fromFile, allFiles);
    case "go":
      return ctx.goModulePath ? resolveGoImport(specifier, ctx.goModulePath, allFiles) : null;
    case "java":
      return resolveJavaImport(specifier, allFiles, ctx.javaSourceRoots ?? []);
    case "rust":
      return resolveRustImport(specifier, fromFile, allFiles);
    default:
      return null;
  }
}

/** Barrel file export mapping: tracks which names come from which source files */
export interface BarrelExportMap {
  /** barrel file -> { exportedName -> source file } */
  namedExports: Map<string, Map<string, string>>;
  /** barrel file -> set of files re-exported with `export *` (names unknown) */
  starExports: Map<string, Set<string>>;
}

/**
 * Scan barrel files (index.ts, etc.) and build a map from barrel path to
 * the source files and exported names they re-export.
 */
export async function resolveBarrelFiles(rootDir: string, fileSet: Set<string>): Promise<BarrelExportMap> {
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
 * Extract the package name from an import specifier.
 * JS/TS: "@tanstack/react-query" -> "@tanstack/react-query", "react/jsx-runtime" -> "react"
 * Go: "github.com/gin-gonic/gin/middleware" -> "github.com/gin-gonic/gin" (3 segments for domain-style)
 *     "fmt" -> "fmt", "net/http" -> "net"
 * Java: "java.util.HashMap" -> "java.util", "com.example.lib.Foo" -> "com.example.lib"
 * Rust: "std::collections::HashMap" -> "std", "serde::Deserialize" -> "serde"
 */
export function getPackageName(specifier: string, lang?: Language): string {
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
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}
