import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import { computeHITS, computeBetweenness } from "./centrality.js";
import { buildImportGraph } from "./build.js";
import { detectBarrelAst } from "../parsers/barrel.js";
import {
  getSourceGlob,
  parseImports,
  isRelativeSpecifier,
  resolveImport,
  resolveAliasImport,
  loadTsconfigPaths,
  getPackageName,
  loadGoModule,
  detectJavaSourceRoots,
  resolveBarrelFiles,
  SOURCE_IGNORE,
  type PathAlias,
  type ResolveContext,
  type BarrelExportMap,
} from "./import-resolution.js";
import { routeBarrelImport } from "./barrel-routing.js";
import { initForLanguage, parseSource } from "../parsers/init.js";
import { extractSymbolNamesFromRoot } from "../parsers/extract-symbols.js";
import { errorMessage, readFileOr } from "../utils.js";
import type { ImportEdge, ImportGraph, Language, ProgressCallback } from "../types.js";
import { HASH_CONCURRENCY } from "../config/thresholds.js";
import { CLARTE_DIR } from "../config/config.js";

const CACHE_VERSION = 3;
const CACHE_DIR = CLARTE_DIR;
const CACHE_FILE = "cache.json";

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
  symbolNames?: Record<string, string[]>;
}

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

export async function saveCache(rootDir: string, data: CacheData): Promise<void> {
  const dir = path.join(rootDir, CACHE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
}

// Re-export analysis cache for backward compatibility
export {
  ANALYSIS_CACHE_VERSION,
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  type AnalysisCacheData,
} from "./analysis-cache.js";

export async function computeFileHashes(rootDir: string, language: Language): Promise<Map<string, string>> {
  const globs = getSourceGlob(language);
  let files: string[];
  try {
    files = await glob(globs, {
      cwd: rootDir,
      ignore: SOURCE_IGNORE,
      absolute: false,
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EACCES") return new Map();
    throw err;
  }

  const hashes = new Map<string, string>();

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

async function parseFileEdges(
  rootDir: string,
  file: string,
  language: Language,
  fileSet: Set<string>,
  pathAliases: PathAlias[],
  resolveCtx?: ResolveContext,
): Promise<ImportEdge[]> {
  const absPath = path.join(rootDir, file);
  const content = await readFileOr(absPath);
  if (!content) return [];

  const rawImports = parseImports(content, language);
  const edges: ImportEdge[] = [];

  for (const raw of rawImports) {
    if (isRelativeSpecifier(raw.specifier, language)) {
      const resolved = resolveImport(raw.specifier, file, language, fileSet, resolveCtx);
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
      const aliasResolved = pathAliases.length > 0 ? resolveAliasImport(raw.specifier, pathAliases, fileSet) : null;

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
      }
    }
  }

  return edges;
}

function rebuildGraph(
  edges: ImportEdge[],
  allFiles: string[],
  barrelFiles: Set<string>,
  symbolNames?: Map<string, string[]>,
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
      // Mirror build.ts: barrel-targeted edges only count when barrel-routed;
      // side-effect imports to barrels (no isBarrelRouted) are excluded.
      const countsAsDirect = barrelFiles.has(edge.to)
        ? edge.isBarrelRouted && !barrelFiles.has(edge.from)
        : !barrelFiles.has(edge.from);
      if (countsAsDirect) {
        directInDegree.set(edge.to, (directInDegree.get(edge.to) ?? 0) + 1);
      }
    } else {
      externalImportCounts.set(edge.to, (externalImportCounts.get(edge.to) ?? 0) + 1);
    }
  }

  const { authority, hub: hubScores } = computeHITS(allFiles, edges, 30, 1e-6, barrelFiles);

  const betweennessScores = computeBetweenness({
    edges,
    inDegree,
    directInDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles,
  });

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
    symbolNames,
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

async function persistCacheData(
  rootDir: string,
  language: Language,
  currentHashes: Map<string, string>,
  graph: ImportGraph,
  onProgress?: ProgressCallback,
): Promise<void> {
  try {
    const hashRecord: Record<string, string> = {};
    for (const [k, v] of currentHashes) hashRecord[k] = v;
    const symbolRecord: Record<string, string[]> = {};
    if (graph.symbolNames) {
      for (const [k, v] of graph.symbolNames) symbolRecord[k] = v;
    }
    await saveCache(rootDir, {
      version: CACHE_VERSION,
      createdAt: new Date().toISOString(),
      language,
      fileHashes: hashRecord,
      edges: serializeEdges(graph.edges),
      barrelFiles: [...(graph.barrelFiles ?? [])],
      symbolNames: symbolRecord,
    });
  } catch (err) {
    onProgress?.(`Warning: cache save failed: ${errorMessage(err)}`);
  }
}

export async function buildGraphWithCache(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph> {
  await initForLanguage(language);

  onProgress?.("Computing file hashes...");
  const currentHashes = await computeFileHashes(rootDir, language);

  const cache = await loadCache(rootDir);

  if (cache && cache.language === language) {
    const cachedHashes = new Map(Object.entries(cache.fileHashes));
    const allCurrentFiles = new Set(currentHashes.keys());

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

    const totalChanged = changedFiles.length + newFiles.length + deletedFiles.size;
    const changeRatio = totalChanged / Math.max(currentHashes.size, 1);

    // Barrel file changes require full rebuild (re-exports affect many edges)
    const barrelSet = new Set(cache.barrelFiles);
    const barrelChanged = changedFiles.some((f) => barrelSet.has(f)) || [...deletedFiles].some((f) => barrelSet.has(f));

    if (totalChanged === 0) {
      // Nothing changed; rebuild graph maps from cached edges
      onProgress?.("No files changed, using cached graph");
      const allFiles = [...currentHashes.keys()];
      const barrels = new Set(cache.barrelFiles);
      const cachedSymbols = cache.symbolNames ? new Map(Object.entries(cache.symbolNames)) : undefined;
      return rebuildGraph(cache.edges, allFiles, barrels, cachedSymbols);
    }

    if (!barrelChanged && changeRatio < 0.1) {
      onProgress?.(`Incremental rebuild: ${totalChanged} file${totalChanged === 1 ? "" : "s"} changed`);

      const staleFromFiles = new Set([...changedFiles, ...deletedFiles]);
      const keptEdges: ImportEdge[] = cache.edges.filter((e) => !staleFromFiles.has(e.from) && !deletedFiles.has(e.to));

      const isJsTs = language === "typescript" || language === "javascript";
      const pathAliases = isJsTs ? await loadTsconfigPaths(rootDir) : [];
      const resolveCtx: ResolveContext = {};
      if (language === "go") {
        resolveCtx.goModulePath = await loadGoModule(rootDir);
      }
      if (language === "java") {
        resolveCtx.javaSourceRoots = detectJavaSourceRoots([...allCurrentFiles]);
      }
      const rawNewEdges: ImportEdge[] = [];
      for (const file of [...changedFiles, ...newFiles]) {
        const edges = await parseFileEdges(rootDir, file, language, allCurrentFiles, pathAliases, resolveCtx);
        rawNewEdges.push(...edges);
      }

      // Detect barrels for changed/new files, merge with cached set
      const detectedBarrels = new Set(cache.barrelFiles);
      for (const f of deletedFiles) detectedBarrels.delete(f);
      for (const file of [...changedFiles, ...newFiles]) {
        const absPath = path.join(rootDir, file);
        const content = await readFileOr(absPath);
        if (content) {
          const { isBarrel } = detectBarrelAst(content, file);
          if (isBarrel) detectedBarrels.add(file);
          else detectedBarrels.delete(file);
        }
      }

      // Apply barrel routing to new edges so incremental matches full rebuild.
      // Resolve barrel exports from the detected barrel set, then re-route edges
      // that target barrel files to their actual source files.
      let barrelMap: BarrelExportMap = { namedExports: new Map(), starExports: new Map() };
      if (isJsTs && detectedBarrels.size > 0) {
        barrelMap = await resolveBarrelFiles(rootDir, allCurrentFiles, detectedBarrels);
      }

      const newEdges: ImportEdge[] = [];
      for (const edge of rawNewEdges) {
        if (edge.isExternal) {
          newEdges.push(edge);
          continue;
        }

        const routed = routeBarrelImport(edge, barrelMap);
        if (routed.length > 0) {
          newEdges.push(...routed);
        } else {
          newEdges.push(edge);
        }
      }

      // Merge symbol names: keep cached, re-extract for changed/new, drop deleted
      const mergedSymbols = new Map<string, string[]>();
      if (cache.symbolNames) {
        for (const [fp, syms] of Object.entries(cache.symbolNames)) {
          if (!deletedFiles.has(fp) && !changedFiles.includes(fp)) mergedSymbols.set(fp, syms);
        }
      }
      for (const file of [...changedFiles, ...newFiles]) {
        const absPath = path.join(rootDir, file);
        const content = await readFileOr(absPath);
        if (content) {
          try {
            const root = parseSource(content, language, file);
            const syms = extractSymbolNamesFromRoot(root, language);
            if (syms.length > 0) mergedSymbols.set(file, syms);
          } catch {
            // skip files that fail to parse
          }
        }
      }

      const mergedEdges = [...keptEdges, ...newEdges];
      const allFiles = [...currentHashes.keys()];

      const graph = rebuildGraph(mergedEdges, allFiles, detectedBarrels, mergedSymbols);
      await persistCacheData(rootDir, language, currentHashes, graph, onProgress);
      return graph;
    }
  }

  // 4. Full rebuild (no cache, language changed, >10% changed, or barrel changed)
  onProgress?.("Full graph rebuild...");
  const graph = await buildImportGraph(rootDir, language, onProgress);
  await persistCacheData(rootDir, language, currentHashes, graph, onProgress);
  return graph;
}
