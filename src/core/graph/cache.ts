import { createHash } from "node:crypto";
import path from "node:path";
import { glob } from "tinyglobby";
import { computeHITS, computeBetweenness } from "./centrality";
import { buildImportGraph } from "./build";
import { detectBarrelAst } from "../parsers/barrel";
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
} from "./import-resolution";
import { routeBarrelImport } from "./barrel-routing";
import { initForLanguage, parseSource } from "../parsers/init";
import { extractSymbolNamesFromRoot } from "../parsers/extract-symbols";
import { errorMessage, readFileOr } from "../utils";
import type { ImportEdge, ImportGraph, Language, ProgressCallback } from "../types";
import { HASH_CONCURRENCY } from "../config/thresholds";
import { CLARTE_DIR } from "../config/config";
import { openGraphStore } from "../../storage/loader";
import type { GraphStore } from "../../storage/graph-store";
import type { FileRecord, FileEdgeRecord, SymbolRecord } from "../../storage/types";

export const CACHE_VERSION = 3;

// ── CacheData type preserved for backward compatibility ────────────────────────

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

// ── SQLite-backed loadCache / saveCache ────────────────────────────────────────

/**
 * Load the graph cache from SQLite.
 * Returns null if no database exists or the database is empty.
 */
export async function loadCache(rootDir: string): Promise<CacheData | null> {
  let store: GraphStore | null = null;
  try {
    store = await openGraphStore(rootDir);
    return loadCacheFromStore(store);
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Save the graph cache to SQLite.
 */
export async function saveCache(rootDir: string, data: CacheData): Promise<void> {
  const store = await openGraphStore(rootDir);
  try {
    saveCacheToStore(store, data);
  } finally {
    store.close();
  }
}

// ── Store-level read/write helpers ─────────────────────────────────────────────

function loadCacheFromStore(store: GraphStore): CacheData | null {
  const hashes = store.getAllHashes();
  if (hashes.size === 0) return null;

  const language = store.getMeta("build_language") ?? "typescript";
  const createdAt = store.getMeta("created_at") ?? new Date().toISOString();

  // Reconstruct edges from file_edges table
  const fileGraph = store.loadFileGraph();
  const edges: SerializedEdge[] = [];
  for (const edgeList of fileGraph.forward.values()) {
    for (const e of edgeList) {
      edges.push({
        from: e.fromPath,
        to: e.toPath,
        isExternal: false,
        specifier: e.toPath,
        importedNames: e.importedNames,
        isTypeOnly: e.isTypeOnly || undefined,
        isDynamic: e.isDynamic || undefined,
        isBarrelRouted: e.isBarrelRouted || undefined,
      });
    }
  }

  // Collect barrel files
  const barrelFiles: string[] = [];
  for (const [p, node] of fileGraph.nodes) {
    if (node.isBarrel) barrelFiles.push(p);
  }

  // Collect symbol names from symbol graph
  const symbolGraph = store.loadSymbolGraph();
  const symbolNames: Record<string, string[]> = {};
  for (const [filePath, ids] of symbolGraph.byFile) {
    const names = ids.map((id) => symbolGraph.symbols.get(id)?.name).filter((n): n is string => typeof n === "string");
    if (names.length > 0) symbolNames[filePath] = names;
  }

  // Exclude stub files (hash="" inserted purely for FK satisfaction)
  const fileHashes: Record<string, string> = {};
  for (const [p, h] of hashes) {
    if (h !== "") fileHashes[p] = h;
  }

  return {
    version: CACHE_VERSION,
    createdAt,
    language,
    fileHashes,
    edges,
    barrelFiles,
    symbolNames: Object.keys(symbolNames).length > 0 ? symbolNames : undefined,
  };
}

function saveCacheToStore(store: GraphStore, data: CacheData): void {
  const now = new Date().toISOString();
  const barrelSet = new Set(data.barrelFiles ?? []);

  // Collect all file paths referenced in edges but not in fileHashes
  const knownFiles = new Set(Object.keys(data.fileHashes));
  const extraPaths = new Set<string>();
  for (const e of data.edges) {
    if (!e.isExternal) {
      if (!knownFiles.has(e.from)) extraPaths.add(e.from);
      if (!knownFiles.has(e.to)) extraPaths.add(e.to);
    }
  }

  // Build file records (hash files + stub records for edge targets not in hashes)
  const fileRecords: FileRecord[] = [
    ...Object.entries(data.fileHashes).map(([p, hash]) => ({
      path: p,
      hash,
      is_barrel: barrelSet.has(p) ? 1 : 0,
      updated_at: now,
    })),
    ...[...extraPaths].map((p) => ({
      path: p,
      hash: "",
      is_barrel: barrelSet.has(p) ? 1 : 0,
      updated_at: now,
    })),
  ];

  // Build edge records (internal edges only)
  const edgeRecords: FileEdgeRecord[] = data.edges
    .filter((e) => !e.isExternal)
    .map((e) => ({
      from_path: e.from,
      to_path: e.to,
      imported_names: e.importedNames,
      is_type_only: e.isTypeOnly ? 1 : 0,
      is_dynamic: e.isDynamic ? 1 : 0,
      is_barrel_routed: e.isBarrelRouted ? 1 : 0,
    }));

  // Build symbol records
  const symbolRecords: SymbolRecord[] = [];
  if (data.symbolNames) {
    for (const [filePath, names] of Object.entries(data.symbolNames)) {
      for (const name of names) {
        symbolRecords.push({
          file_path: filePath,
          name,
          kind: "unknown",
          start_line: 0,
        });
      }
    }
  }

  store.upsertFiles(fileRecords);
  store.upsertFileEdges(edgeRecords);
  if (symbolRecords.length > 0) store.upsertSymbols(symbolRecords);
  store.setMeta("build_language", data.language);
  store.setMeta("created_at", data.createdAt ?? now);
}

// Re-export analysis cache for backward compatibility
export {
  ANALYSIS_CACHE_VERSION,
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  type AnalysisCacheData,
} from "./analysis-cache";

// ── File hashing ──────────────────────────────────────────────────────────────

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
          const { readFile } = await import("node:fs/promises");
          const content = await readFile(absPath);
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

// ── Graph building ────────────────────────────────────────────────────────────

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

async function persistCacheData(
  rootDir: string,
  language: Language,
  currentHashes: Map<string, string>,
  graph: ImportGraph,
  store: GraphStore,
  onProgress?: ProgressCallback,
): Promise<void> {
  try {
    const hashRecord: Record<string, string> = {};
    for (const [k, v] of currentHashes) hashRecord[k] = v;
    const symbolRecord: Record<string, string[]> = {};
    if (graph.symbolNames) {
      for (const [k, v] of graph.symbolNames) symbolRecord[k] = v;
    }
    saveCacheToStore(store, {
      version: CACHE_VERSION,
      createdAt: new Date().toISOString(),
      language,
      fileHashes: hashRecord,
      edges: graph.edges.map((e) => ({
        from: e.from,
        to: e.to,
        isExternal: e.isExternal,
        specifier: e.specifier,
        importedNames: [...e.importedNames],
        isTypeOnly: e.isTypeOnly,
        isDynamic: e.isDynamic,
        isBarrelRouted: e.isBarrelRouted || undefined,
      })),
      barrelFiles: [...(graph.barrelFiles ?? [])],
      symbolNames: symbolRecord,
    });
    void rootDir; // rootDir used for context only; store is already bound to this rootDir
  } catch (err) {
    onProgress?.(`Warning: cache save failed: ${errorMessage(err)}`);
  }
}

/**
 * Build the import graph, using the SQLite cache for incremental updates.
 * Creates or reuses the GraphStore for this rootDir.
 */
export async function buildGraphWithCache(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
  extraAliases?: Array<{ prefix: string; replacement: string }>,
  store?: GraphStore,
): Promise<ImportGraph> {
  // Open or reuse store
  const ownStore = !store;
  const activeStore = store ?? (await openGraphStore(rootDir));

  try {
    return await buildGraphWithStore(rootDir, language, activeStore, onProgress, extraAliases);
  } finally {
    if (ownStore) activeStore.close();
  }
}

async function buildGraphWithStore(
  rootDir: string,
  language: Language,
  store: GraphStore,
  onProgress?: ProgressCallback,
  extraAliases?: Array<{ prefix: string; replacement: string }>,
): Promise<ImportGraph> {
  await initForLanguage(language);

  onProgress?.("Computing file hashes...");
  const currentHashes = await computeFileHashes(rootDir, language);

  const cachedHashes = store.getAllHashes();
  const storedLanguage = store.getMeta("build_language");

  // Classify changes
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

  if (storedLanguage === language && cachedHashes.size > 0) {
    const changeRatio = totalChanged / Math.max(currentHashes.size, 1);

    // Reconstruct stored graph data
    const fileGraph = store.loadFileGraph();
    const symbolGraph = store.loadSymbolGraph();
    const barrelSet = new Set<string>();
    for (const [p, node] of fileGraph.nodes) {
      if (node.isBarrel) barrelSet.add(p);
    }

    const barrelChanged = changedFiles.some((f) => barrelSet.has(f)) || [...deletedFiles].some((f) => barrelSet.has(f));

    if (totalChanged === 0) {
      onProgress?.("No files changed, using cached graph");
      const allFiles = [...currentHashes.keys()];
      const cachedSymbols = new Map<string, string[]>();
      for (const [fp, ids] of symbolGraph.byFile) {
        const names = ids
          .map((id) => symbolGraph.symbols.get(id)?.name)
          .filter((n): n is string => typeof n === "string");
        if (names.length > 0) cachedSymbols.set(fp, names);
      }
      // Reconstruct cached edges
      const cachedEdges: ImportEdge[] = [];
      for (const edgeList of fileGraph.forward.values()) {
        for (const e of edgeList) {
          cachedEdges.push({
            from: e.fromPath,
            to: e.toPath,
            isExternal: false,
            specifier: e.toPath,
            importedNames: e.importedNames,
            isTypeOnly: e.isTypeOnly,
            isDynamic: e.isDynamic,
            isBarrelRouted: e.isBarrelRouted,
          });
        }
      }
      return rebuildGraph(cachedEdges, allFiles, barrelSet, cachedSymbols);
    }

    if (!barrelChanged && changeRatio < 0.25) {
      onProgress?.(`Incremental rebuild: ${totalChanged} file${totalChanged === 1 ? "" : "s"} changed`);

      const allCurrentFiles = new Set(currentHashes.keys());
      const staleFromFiles = new Set([...changedFiles, ...deletedFiles]);

      // Reconstruct kept edges from SQLite
      const keptEdges: ImportEdge[] = [];
      for (const edgeList of fileGraph.forward.values()) {
        for (const e of edgeList) {
          if (!staleFromFiles.has(e.fromPath) && !deletedFiles.has(e.toPath)) {
            keptEdges.push({
              from: e.fromPath,
              to: e.toPath,
              isExternal: false,
              specifier: e.toPath,
              importedNames: e.importedNames,
              isTypeOnly: e.isTypeOnly,
              isDynamic: e.isDynamic,
              isBarrelRouted: e.isBarrelRouted,
            });
          }
        }
      }

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

      // Update barrel set for changed/new files
      const detectedBarrels = new Set(barrelSet);
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

      // Apply barrel routing to new edges
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

      // Merge symbol names
      const mergedSymbols = new Map<string, string[]>();
      for (const [fp, ids] of symbolGraph.byFile) {
        if (!deletedFiles.has(fp) && !changedFiles.includes(fp)) {
          const names = ids
            .map((id) => symbolGraph.symbols.get(id)?.name)
            .filter((n): n is string => typeof n === "string");
          if (names.length > 0) mergedSymbols.set(fp, names);
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

      // Delete stale files from SQLite, then save new state
      if (deletedFiles.size > 0) {
        store.deleteFiles([...deletedFiles]);
      }

      const mergedEdges = [...keptEdges, ...newEdges];
      const allFiles = [...currentHashes.keys()];

      const graph = rebuildGraph(mergedEdges, allFiles, detectedBarrels, mergedSymbols);
      await persistCacheData(rootDir, language, currentHashes, graph, store, onProgress);
      return graph;
    }
  }

  // Full rebuild
  onProgress?.("Full graph rebuild...");
  const graph = await buildImportGraph(rootDir, language, onProgress, extraAliases);
  await persistCacheData(rootDir, language, currentHashes, graph, store, onProgress);
  return graph;
}

// Re-export for backward compat with tests
export { CLARTE_DIR };
