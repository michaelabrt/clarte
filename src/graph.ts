import path from "node:path";
import fg from "fast-glob";
import { readFileOr } from "./utils.js";
import type {
  ArchitecturalLayer,
  CircularDependency,
  Community,
  ExportCoverage,
  FileInstability,
  HubFile,
  ImportEdge,
  ImportGraph,
  Language,
  LayerEdge,
  ProgressCallback,
} from "./types.js";

// ── Import regex patterns per language ────────────────────────────────

/** JS/TS: import ... from '...' (including type-only and namespace imports) */
const JS_IMPORT_FROM = /import\s+(?:type\s+)?(?:\{([^}]*)\}|(\*\s+as\s+\w+|\w+)(?:\s*,\s*\{([^}]*)\})?)\s+from\s+['"]([^'"]+)['"]/g;
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
}

export function parseJsImports(content: string): RawImport[] {
  const imports: RawImport[] = [];

  // import { a, b } from '...' / import Foo from '...' / import Foo, { a } from '...' / import * as Foo from '...'
  for (const m of content.matchAll(JS_IMPORT_FROM)) {
    const names: string[] = [];
    if (m[1]) names.push(...m[1].split(",").map((n) => n.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean));
    if (m[2]) {
      const group2 = m[2].trim();
      // Namespace import (* as foo) — edge is valid but no named import to extract
      if (!group2.startsWith("*")) {
        names.push(group2);
      }
    }
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
      onProgress?.("Warning: permission error scanning files — returning empty graph");
      return { edges: [], inDegree: new Map(), centrality: new Map(), externalImportCounts: new Map() };
    }
    throw err;
  }

  onProgress?.(`Found ${files.length} source files to analyze`);

  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const inDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

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

  onProgress?.("Computing centrality (PageRank)...");
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

/**
 * Get the most interconnected files (hub files) sorted by centrality.
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
  for (const [filePath, centrality] of graph.centrality) {
    const importedBy = graph.inDegree.get(filePath) ?? 0;
    const imports = outCount.get(filePath) ?? 0;
    // Only include files that have some connectivity
    if (importedBy > 0 || imports > 0) {
      files.push({ path: filePath, centrality, importedBy, imports });
    }
  }

  // Sort by centrality descending
  files.sort((a, b) => b.centrality - a.centrality);

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
  // Sort by size (smallest first — more actionable)
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
 * Returns files with instability > 0.7 and fanIn >= 3 (high-risk zones).
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
    if (instability > 0.7 && fanIn >= 3) {
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
 * Compute export coverage for each file — how many of its exports
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
