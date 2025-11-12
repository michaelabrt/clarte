import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import {
  parseJsImports,
  parsePythonImports,
  parseGoImports,
  parseRustImports,
  parseJavaImports,
  computeHITS,
  detectBarrelFiles,
  buildImportGraph,
} from "./graph.js";
import { readFileOr, readJsonFile } from "./utils.js";
import type {
  ArchitecturalLayer,
  Chokepoint,
  CircularDependency,
  Community,
  CrossCuttingFile,
  FileInstability,
  GraphTopology,
  HubFile,
  ImportEdge,
  ImportGraph,
  Language,
  LayerConsistency,
  LayerEdge,
  ProgressCallback,
  TightCoupling,
} from "./types.js";

// ── Constants ─────────────────────────────────────────────────────────

const CACHE_VERSION = 1;
const CACHE_DIR = ".clarte";
const CACHE_FILE = "cache.json";

/** Ignore patterns matching buildImportGraph in graph.ts */
const SOURCE_IGNORE = [
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
];

/** JS/TS file extensions for import resolution */
const JS_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".mjs"];
const INDEX_FILES = JS_EXTENSIONS.map((e) => `/index${e}`);

// ── Types ─────────────────────────────────────────────────────────────

interface SerializedEdge {
  from: string;
  to: string;
  isExternal: boolean;
  specifier: string;
  importedNames: string[];
  isTypeOnly?: boolean;
  isDynamic?: boolean;
}

export interface CacheData {
  version: number;
  createdAt: string;
  language: string;
  fileHashes: Record<string, string>;
  edges: SerializedEdge[];
  barrelFiles: string[];
}

interface PathAlias {
  prefix: string;
  replacement: string;
}

// ── Source globs (mirrored from graph.ts) ──────────────────────────────

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

// ── Import resolution (mirrored from graph.ts private functions) ──────

function parseImports(content: string, lang: Language) {
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

function isRelativeSpecifier(spec: string, lang: Language): boolean {
  if (lang === "typescript" || lang === "javascript") {
    return spec.startsWith("./") || spec.startsWith("../");
  }
  if (lang === "python") {
    return spec.startsWith(".");
  }
  if (lang === "rust") {
    return (
      spec.startsWith("crate::") ||
      spec.startsWith("super::") ||
      spec.startsWith("self::")
    );
  }
  return spec.startsWith("./") || spec.startsWith("../");
}

function resolveJsImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  const dir = path.dirname(fromFile);
  const raw = path.join(dir, specifier).replace(/\\/g, "/");
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

function resolvePythonImport(
  specifier: string,
  fromFile: string,
  allFiles: Set<string>,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const dir = path.dirname(fromFile);
  let dots = 0;
  while (specifier[dots] === ".") dots++;
  const modulePath = specifier.slice(dots).replace(/\./g, "/");
  let baseDir = dir;
  for (let i = 1; i < dots; i++) baseDir = path.dirname(baseDir);
  const base = modulePath
    ? path.join(baseDir, modulePath).replace(/\\/g, "/")
    : baseDir;
  if (allFiles.has(base + ".py")) return base + ".py";
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
      return null;
  }
}

function getPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

// ── Path alias resolution (mirrored from graph.ts) ────────────────────

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
      const configPaths = co.paths as Record<string, string[]>;
      for (const [key, value] of Object.entries(configPaths)) {
        if (!(key in paths)) paths[key] = value;
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
    if (pattern.endsWith("/*") && mappings[0].endsWith("/*")) {
      const prefix = pattern.slice(0, -1);
      const target = mappings[0].slice(0, -1);
      const replacement = path.join(baseUrl, target).replace(/\\/g, "/");
      aliases.push({ prefix, replacement });
    } else if (!pattern.includes("*")) {
      aliases.push({
        prefix: pattern,
        replacement: path.join(baseUrl, mappings[0]).replace(/\\/g, "/"),
      });
    }
  }

  return aliases;
}

function resolveAliasImport(
  specifier: string,
  aliases: PathAlias[],
  allFiles: Set<string>,
): string | null {
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

// ── Cache I/O ─────────────────────────────────────────────────────────

export async function loadCache(rootDir: string): Promise<CacheData | null> {
  const cachePath = path.join(rootDir, CACHE_DIR, CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw) as CacheData;
    if (data.version !== CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveCache(
  rootDir: string,
  data: CacheData,
): Promise<void> {
  const dir = path.join(rootDir, CACHE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
}

// ── Analysis Cache ────────────────────────────────────────────────────

const ANALYSIS_CACHE_VERSION = 1;
const ANALYSIS_CACHE_FILE = "analysis-cache.json";

/** Cached graph-derived analysis results (deterministic given edges + config) */
export interface AnalysisCacheData {
  version: number;
  /** SHA-256 of sorted edge list + layers config */
  cacheKey: string;
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  layerEdges: LayerEdge[];
  instabilities: FileInstability[];
  communities: Community[];
  deadFiles: string[];
  crossCuttingFiles: CrossCuttingFile[];
  layerConsistency?: LayerConsistency;
  chokepoints: Chokepoint[];
  tightCouplings: TightCoupling[];
  graphTopology: GraphTopology;
}

/** Compute a cache key from graph edges and optional custom layer config */
export function computeAnalysisCacheKey(
  graph: ImportGraph,
  layersConfig?: Array<{ name: string; pattern: string }>,
): string {
  // Sort edges deterministically
  const sortedEdges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => `${e.from}>${e.to}`)
    .sort()
    .join("|");

  const layersPart = layersConfig
    ? JSON.stringify(layersConfig)
    : "";

  return createHash("sha256")
    .update(sortedEdges + layersPart)
    .digest("hex");
}

export async function loadAnalysisCache(
  rootDir: string,
): Promise<AnalysisCacheData | null> {
  const cachePath = path.join(rootDir, CACHE_DIR, ANALYSIS_CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw) as AnalysisCacheData;
    if (data.version !== ANALYSIS_CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveAnalysisCache(
  rootDir: string,
  data: AnalysisCacheData,
): Promise<void> {
  const dir = path.join(rootDir, CACHE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, ANALYSIS_CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
}

// ── File hash computation ─────────────────────────────────────────────

export async function computeFileHashes(
  rootDir: string,
  language: Language,
): Promise<Map<string, string>> {
  const globs = getSourceGlob(language);
  let files: string[];
  try {
    files = await glob(globs, {
      cwd: rootDir,
      ignore: SOURCE_IGNORE,
      absolute: false,
    });
  } catch {
    return new Map();
  }

  const hashes = new Map<string, string>();
  for (const file of files) {
    const absPath = path.join(rootDir, file);
    try {
      const content = await fs.readFile(absPath);
      const hash = createHash("sha256").update(content).digest("hex");
      hashes.set(file, hash);
    } catch {
      // File disappeared between glob and read
    }
  }
  return hashes;
}

// ── Incremental edge parsing ──────────────────────────────────────────

async function parseFileEdges(
  rootDir: string,
  file: string,
  language: Language,
  fileSet: Set<string>,
  pathAliases: PathAlias[],
): Promise<ImportEdge[]> {
  const absPath = path.join(rootDir, file);
  const content = await readFileOr(absPath);
  if (!content) return [];

  const rawImports = parseImports(content, language);
  const edges: ImportEdge[] = [];

  for (const raw of rawImports) {
    if (isRelativeSpecifier(raw.specifier, language)) {
      const resolved = resolveImport(raw.specifier, file, language, fileSet);
      if (resolved) {
        edges.push({
          from: file,
          to: resolved,
          isExternal: false,
          specifier: raw.specifier,
          importedNames: raw.importedNames,
          isTypeOnly: raw.isTypeOnly,
          isDynamic: raw.isDynamic,
        });
      }
    } else {
      const aliasResolved =
        pathAliases.length > 0
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
      } else {
        const pkgName = getPackageName(raw.specifier);
        edges.push({
          from: file,
          to: pkgName,
          isExternal: true,
          specifier: raw.specifier,
          importedNames: raw.importedNames,
          isTypeOnly: raw.isTypeOnly,
          isDynamic: raw.isDynamic,
        });
      }
    }
  }

  return edges;
}

// ── Graph rebuilding from edges ───────────────────────────────────────

function rebuildGraph(
  edges: ImportEdge[],
  allFiles: string[],
  barrelFiles: Set<string>,
): ImportGraph {
  const inDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  for (const file of allFiles) inDegree.set(file, 0);

  for (const edge of edges) {
    if (!edge.isExternal) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
    } else {
      externalImportCounts.set(
        edge.to,
        (externalImportCounts.get(edge.to) ?? 0) + 1,
      );
    }
  }

  const { authority, hub: hubScores } = computeHITS(
    allFiles,
    edges,
    30,
    1e-6,
    barrelFiles,
  );

  return {
    edges,
    inDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles,
  };
}

function serializeEdges(edges: ImportEdge[]): SerializedEdge[] {
  return edges.map((e) => ({
    from: e.from,
    to: e.to,
    isExternal: e.isExternal,
    specifier: e.specifier,
    importedNames: [...e.importedNames],
    isTypeOnly: e.isTypeOnly,
    isDynamic: e.isDynamic,
  }));
}

// ── Main entry point ──────────────────────────────────────────────────

export async function buildGraphWithCache(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph> {
  // 1. Compute current file hashes
  onProgress?.("Computing file hashes...");
  const currentHashes = await computeFileHashes(rootDir, language);

  // 2. Load existing cache
  const cache = await loadCache(rootDir);

  // 3. Attempt incremental rebuild
  if (cache && cache.language === language) {
    const cachedHashes = new Map(Object.entries(cache.fileHashes));
    const allCurrentFiles = new Set(currentHashes.keys());

    // Identify changed, new, and deleted files
    const changedFiles: string[] = [];
    const newFiles: string[] = [];
    const deletedFiles = new Set<string>();

    for (const [file, hash] of currentHashes) {
      const cachedHash = cachedHashes.get(file);
      if (!cachedHash) {
        newFiles.push(file);
      } else if (cachedHash !== hash) {
        changedFiles.push(file);
      }
    }
    for (const file of cachedHashes.keys()) {
      if (!currentHashes.has(file)) {
        deletedFiles.add(file);
      }
    }

    const totalChanged =
      changedFiles.length + newFiles.length + deletedFiles.size;
    const changeRatio = totalChanged / Math.max(currentHashes.size, 1);

    // Barrel file changes require full rebuild (re-exports affect many edges)
    const barrelSet = new Set(cache.barrelFiles);
    const barrelChanged =
      changedFiles.some((f) => barrelSet.has(f)) ||
      [...deletedFiles].some((f) => barrelSet.has(f));

    if (totalChanged === 0) {
      // Nothing changed; rebuild graph maps from cached edges
      onProgress?.("No files changed, using cached graph");
      const allFiles = [...currentHashes.keys()];
      const barrels = new Set(cache.barrelFiles);
      return rebuildGraph(cache.edges, allFiles, barrels);
    }

    if (!barrelChanged && changeRatio < 0.1) {
      // Incremental rebuild
      onProgress?.(
        `Incremental rebuild: ${totalChanged} file${totalChanged === 1 ? "" : "s"} changed`,
      );

      // Remove stale edges (from changed/deleted files, to deleted files)
      const staleFromFiles = new Set([...changedFiles, ...deletedFiles]);
      const keptEdges: ImportEdge[] = cache.edges.filter(
        (e) => !staleFromFiles.has(e.from) && !deletedFiles.has(e.to),
      );

      // Parse changed/new files
      const isJsTs = language === "typescript" || language === "javascript";
      const pathAliases = isJsTs ? await loadTsconfigPaths(rootDir) : [];
      const newEdges: ImportEdge[] = [];
      for (const file of [...changedFiles, ...newFiles]) {
        const edges = await parseFileEdges(
          rootDir,
          file,
          language,
          allCurrentFiles,
          pathAliases,
        );
        newEdges.push(...edges);
      }

      const mergedEdges = [...keptEdges, ...newEdges];
      const allFiles = [...currentHashes.keys()];
      const detectedBarrels = await detectBarrelFiles(rootDir, allCurrentFiles);
      const graph = rebuildGraph(mergedEdges, allFiles, detectedBarrels);

      // Save updated cache
      try {
        const hashRecord: Record<string, string> = {};
        for (const [k, v] of currentHashes) hashRecord[k] = v;
        await saveCache(rootDir, {
          version: CACHE_VERSION,
          createdAt: new Date().toISOString(),
          language,
          fileHashes: hashRecord,
          edges: serializeEdges(graph.edges),
          barrelFiles: [...(graph.barrelFiles ?? [])],
        });
      } catch {
        // Cache save failed; non-critical
      }

      return graph;
    }
  }

  // 4. Full rebuild (no cache, language changed, >10% changed, or barrel changed)
  onProgress?.("Full graph rebuild...");
  const graph = await buildImportGraph(rootDir, language, onProgress);

  // 5. Save cache
  try {
    const hashRecord: Record<string, string> = {};
    for (const [k, v] of currentHashes) hashRecord[k] = v;
    await saveCache(rootDir, {
      version: CACHE_VERSION,
      createdAt: new Date().toISOString(),
      language,
      fileHashes: hashRecord,
      edges: serializeEdges(graph.edges),
      barrelFiles: [...(graph.barrelFiles ?? [])],
    });
  } catch {
    // Cache save failed; non-critical
  }

  return graph;
}
