import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { computeHITS, computeBetweenness } from "./centrality.js";
import { detectBarrelFiles, buildImportGraph } from "./graph-build.js";
import {
  getSourceGlob,
  parseImports,
  isRelativeSpecifier,
  resolveImport,
  resolveAliasImport,
  loadTsconfigPaths,
  getPackageName,
  SOURCE_IGNORE,
  type PathAlias,
} from "./import-resolution.js";
import { initTreeSitter } from "./ast-parse.js";
import { readFileOr } from "./utils.js";
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

const CACHE_VERSION = 2;
const CACHE_DIR = ".clarte";
const CACHE_FILE = "cache.json";

// ── Types ─────────────────────────────────────────────────────────────

interface SerializedEdge {
  from: string;
  to: string;
  isExternal: boolean;
  specifier: string;
  importedNames: string[];
  isTypeOnly?: boolean;
  isDynamic?: boolean;
  isBarrelRouted?: boolean;
}

export interface CacheData {
  version: number;
  createdAt: string;
  language: string;
  fileHashes: Record<string, string>;
  edges: SerializedEdge[];
  barrelFiles: string[];
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

const ANALYSIS_CACHE_VERSION = 2;
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
  // Sort edges deterministically, including properties that affect analysis
  const sortedEdges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => {
      const flags = `${e.importedNames.length}:${e.isTypeOnly ? 1 : 0}:${e.isDynamic ? 1 : 0}`;
      return `${e.from}>${e.to}:${flags}`;
    })
    .sort()
    .join("|");

  // Count external edges so adding a new npm dependency invalidates the cache
  const externalCount = graph.edges.filter((e) => e.isExternal).length;

  const layersPart = layersConfig
    ? JSON.stringify(layersConfig)
    : "";

  return createHash("sha256")
    .update(sortedEdges + `|ext:${externalCount}` + layersPart)
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

  const HASH_CONCURRENCY = 32;
  const hashes = new Map<string, string>();

  // Process in chunks of HASH_CONCURRENCY
  for (let i = 0; i < files.length; i += HASH_CONCURRENCY) {
    const chunk = files.slice(i, i + HASH_CONCURRENCY);
    const results = await Promise.all(
      chunk.map(async (file) => {
        const absPath = path.join(rootDir, file);
        try {
          const content = await fs.readFile(absPath);
          const hash = createHash("sha256").update(content).digest("hex");
          return { file, hash } as const;
        } catch {
          return null;
        }
      }),
    );
    for (const r of results) {
      if (r) hashes.set(r.file, r.hash);
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
  const directInDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  for (const file of allFiles) {
    inDegree.set(file, 0);
    directInDegree.set(file, 0);
  }

  for (const edge of edges) {
    if (!edge.isExternal) {
      inDegree.set(edge.to, (inDegree.get(edge.to) ?? 0) + 1);
      if (!edge.isBarrelRouted) {
        directInDegree.set(edge.to, (directInDegree.get(edge.to) ?? 0) + 1);
      }
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

  const betweennessScores = computeBetweenness({ edges, inDegree, directInDegree, centrality: authority, externalImportCounts, authority, hubScores, barrelFiles });

  return {
    edges,
    inDegree,
    directInDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles,
    betweennessScores,
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
    isBarrelRouted: e.isBarrelRouted || undefined,
  }));
}

// ── Main entry point ──────────────────────────────────────────────────

export async function buildGraphWithCache(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph> {
  // Ensure tree-sitter is ready for AST-based parsing
  await initTreeSitter();

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
