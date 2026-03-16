import type { GraphStore } from "../../storage/graph-store.js";
import { buildPersistedGraphFromStore, openGraphStore } from "../../storage/loader.js";
import type {
  ChangeCouplingRecord,
  CommunityRecord,
  FileEdgeRecord,
  FileRecord,
  SymbolEdgeRecord,
  SymbolRecord,
} from "../../storage/types.js";
import { CLARTE_DIR } from "../config/config.js";
import { gitExecSafe } from "../git/git.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph } from "../types/persisted-graph.js";
import type { ContextAnalysis, ImportGraph } from "../types.js";
import { deriveRole } from "./centrality.js";
import { resolveGoStructuralEdges } from "./go-resolution.js";
import { computeAllInstabilities } from "./instability.js";
import { computeSymbolAuthority } from "./persist-helpers.js";
import { resolvePythonMROEdges } from "./python-mro.js";
import { resolveRustTraitEdges } from "./rust-resolution.js";
import { aggregateToFileLevel, computeSymbolHITS, type SymbolNode } from "./symbol-hits.js";
import { buildImportMap, buildSymbolIndex, LRUCache, resolveAllSymbolEdges } from "./symbol-resolution.js";
import type { FileGraphResult, ResolvedSymbolEdge } from "./symbol-types.js";
import { buildAliasMap } from "./type-aliases.js";

/**
 * Persist the analysis graph to .clarte/graph.db.
 * Stores file scores, edges, communities and change coupling in SQLite.
 * Non-critical: callers should wrap in try/catch.
 */
export async function persistGraph(
  rootDir: string,
  graph: ImportGraph,
  analysis: ContextAnalysis,
  store?: GraphStore,
): Promise<void> {
  const ownStore = !store;
  const activeStore = store ?? (await openGraphStore(rootDir));

  try {
    persistGraphToStore(rootDir, activeStore, graph, analysis);
  } finally {
    if (ownStore) activeStore.close();
  }
}

function persistGraphToStore(rootDir: string, store: GraphStore, graph: ImportGraph, analysis: ContextAnalysis): void {
  const now = new Date().toISOString();

  const hubByPath = new Map(analysis.hubFiles.map((h) => [h.path, h]));
  const chokepointByPath = new Map((analysis.chokepoints ?? []).map((c) => [c.file, c]));
  const crossCuttingByPath = new Map((analysis.crossCuttingFiles ?? []).map((c) => [c.file, c]));
  const instabilityMap = computeAllInstabilities(graph);
  const fileToCommunity = new Map<string, number>();
  for (const community of analysis.communities) {
    for (const file of community.files) {
      fileToCommunity.set(file, community.id);
    }
  }

  // Detect layer per file
  const fileToLayers = new Map<string, string[]>();
  for (const layer of analysis.layers ?? []) {
    for (const file of layer.files) {
      let arr = fileToLayers.get(file);
      if (!arr) {
        arr = [];
        fileToLayers.set(file, arr);
      }
      arr.push(layer.name);
    }
  }

  const sourceToTests = analysis.testMapping?.sourceToTests ?? new Map<string, string[]>();

  // Build internal edge list (for symbol authority computation)
  const internalEdges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => ({
      from: e.from,
      to: e.to,
      importedNames: e.importedNames,
      isTypeOnly: e.isTypeOnly,
    }));

  // Compute per-file symbol data
  const fileSymbolData = new Map<
    string,
    {
      symbolNames: string[];
      symbolBodyTokens: Record<string, string[]>;
      symbolStartLines: Record<string, number>;
      symbolAuthority: Record<string, number>;
      intraFileCalls: Array<[string, string]>;
    }
  >();

  for (const [filePath] of graph.inDegree) {
    const symbolNames = graph.symbolNames?.get(filePath) ?? [];
    const bodyTokens = graph.symbolBodyTokens?.get(filePath);
    const startLines = graph.symbolStartLines?.get(filePath);
    const intraCalls = graph.intraFileCalls?.get(filePath);

    if (symbolNames.length === 0 && !bodyTokens && !startLines && !intraCalls) continue;

    fileSymbolData.set(filePath, {
      symbolNames,
      symbolBodyTokens: bodyTokens ? Object.fromEntries(bodyTokens) : {},
      symbolStartLines: startLines ? Object.fromEntries(startLines) : {},
      symbolAuthority: {},
      intraFileCalls: intraCalls ? intraCalls.map((c) => [c.caller, c.callee] as [string, string]) : [],
    });
  }

  // Compute symbol authority
  const filesRecord: Record<string, { symbolNames?: string[] }> = {};
  for (const [fp, data] of fileSymbolData) {
    filesRecord[fp] = { symbolNames: data.symbolNames };
  }
  const symAuthMap = computeSymbolAuthority(internalEdges, filesRecord, graph.intraFileCalls ?? new Map());
  for (const [fp, auth] of symAuthMap) {
    const data = fileSymbolData.get(fp);
    if (data) data.symbolAuthority = auth;
  }

  // Build file records
  const fileRecords: FileRecord[] = [];
  for (const [filePath] of graph.inDegree) {
    const hub = hubByPath.get(filePath);
    const authority = graph.authority?.get(filePath) ?? 0;
    const hubScore = graph.hubScores?.get(filePath) ?? 0;
    const isBarrel = graph.barrelFiles?.has(filePath) ?? false;
    const chokepoint = chokepointByPath.get(filePath);
    const crossCutting = crossCuttingByPath.get(filePath);
    const tests = sourceToTests.get(filePath) ?? [];
    const layers = fileToLayers.get(filePath) ?? [];
    const symData = fileSymbolData.get(filePath);

    fileRecords.push({
      path: filePath,
      hash: "", // hash already stored by cache layer; don't overwrite
      role: hub?.role ?? deriveRole(authority, hubScore, isBarrel),
      authority,
      hub_score: hubScore,
      betweenness: graph.betweennessScores?.get(filePath) ?? 0,
      instability: instabilityMap.get(filePath) ?? null,
      community_id: fileToCommunity.get(filePath) ?? null,
      layer: layers[0] ?? null,
      is_barrel: isBarrel ? 1 : 0,
      is_dead: (graph.inDegree.get(filePath) ?? 0) === 0 ? 1 : 0,
      is_chokepoint: chokepoint ? 1 : 0,
      separates_components: chokepoint?.upstreamCount ?? 0,
      is_cross_cutting: crossCutting ? 1 : 0,
      layer_spread: crossCutting?.layerSpread ?? 0,
      has_tests: tests.length > 0 ? 1 : 0,
      // AC 1.9.2 exception: layers, test_files, intra_file_calls are JSON arrays stored in
      // TEXT columns — the same pattern as imported_names (the AC's named exception).
      // These are compatibility columns outside the RFC §5.2 schema, added so the steer
      // module can reconstruct a PersistedGraph without a separate relational table per
      // array. They are read back via parseJsonArray() in graph-store.ts, symmetric with
      // edgeRowToEdge()'s imported_names parsing.
      layers: layers.length > 0 ? JSON.stringify(layers) : null,
      test_files: tests.length > 0 ? JSON.stringify(tests) : null,
      intra_file_calls: symData?.intraFileCalls?.length ? JSON.stringify(symData.intraFileCalls) : null,
      updated_at: now,
    });
  }

  // Build edge records (internal edges only)
  const edgeRecords: FileEdgeRecord[] = internalEdges.map((e) => ({
    from_path: e.from,
    to_path: e.to,
    imported_names: e.importedNames,
    is_type_only: e.isTypeOnly ? 1 : 0,
  }));

  // Build symbol records.
  // When Phase 2 fileGraphResults are available, use SymbolDefinition.kind for correct kinds.
  // Fall back to the legacy graph.symbolNames path only when fileGraphResults is absent,
  // using "function" as a safe default (RFC §2.2 valid kinds exclude "unknown").
  const fileGraphResults = graph.fileGraphResults;
  const symbolRecords: SymbolRecord[] = [];

  if (fileGraphResults && fileGraphResults.size > 0) {
    for (const [filePath, result] of fileGraphResults) {
      if (result.symbols.length === 0) continue;
      const importNames = graph.edges
        .filter((e) => e.from === filePath && !e.isExternal)
        .flatMap((e) => e.importedNames);
      const importNamesStr = importNames.length > 0 ? JSON.stringify(importNames) : null;
      const data = fileSymbolData.get(filePath);

      for (const sym of result.symbols) {
        symbolRecords.push({
          file_path: filePath,
          name: sym.name,
          kind: sym.kind,
          start_line: sym.startLine,
          end_line: sym.endLine ?? null,
          body_hash: sym.bodyHash,
          body_tokens: sym.bodyTokens || null,
          authority: data?.symbolAuthority[sym.name] ?? null,
          import_names: importNamesStr,
          is_exported: sym.isExported ? 1 : 0,
        });
      }
    }
  } else {
    for (const [filePath, data] of fileSymbolData) {
      const importNames = graph.edges
        .filter((e) => e.from === filePath && !e.isExternal)
        .flatMap((e) => e.importedNames);
      const importNamesStr = importNames.length > 0 ? JSON.stringify(importNames) : null;

      for (const name of data.symbolNames) {
        const startLine = data.symbolStartLines[name] ?? 0;
        const tokens = data.symbolBodyTokens[name];
        symbolRecords.push({
          file_path: filePath,
          name,
          kind: "function", // safe default; "unknown" is not a valid SymbolKind
          start_line: startLine,
          authority: data.symbolAuthority[name] ?? null,
          body_tokens: tokens ? (Array.isArray(tokens) ? tokens.join(" ") : String(tokens)) : null,
          import_names: importNamesStr,
        });
      }
    }
  }

  // Build community records
  const communityRecords: CommunityRecord[] = analysis.communities.map((c) => ({
    id: c.id,
    label: c.label,
  }));

  // Build change coupling records
  const changeCouplingRecords: ChangeCouplingRecord[] = (analysis.gitActivity?.changeCoupling ?? []).map((c) => ({
    file_a: c.fileA,
    file_b: c.fileB,
    co_changes: c.coChangeCount,
    confidence: c.confidence,
  }));

  // Write to SQLite
  // Preserve existing hashes for files already in the DB
  const existingHashes = store.getAllHashes();

  const mergedFileRecords = fileRecords.map((f) => ({
    ...f,
    hash: existingHashes.get(f.path) ?? f.hash,
  }));

  // Ensure all edge target files exist in the files table (FK constraint)
  const knownPaths = new Set(mergedFileRecords.map((f) => f.path));
  for (const e of edgeRecords) {
    if (!knownPaths.has(e.from_path)) {
      mergedFileRecords.push({
        path: e.from_path,
        hash: existingHashes.get(e.from_path) ?? "",
        updated_at: now,
      });
      knownPaths.add(e.from_path);
    }
    if (e.to_path && !knownPaths.has(e.to_path)) {
      mergedFileRecords.push({
        path: e.to_path,
        hash: existingHashes.get(e.to_path) ?? "",
        updated_at: now,
      });
      knownPaths.add(e.to_path);
    }
  }

  store.upsertFiles(mergedFileRecords);
  store.upsertFileEdges(edgeRecords);
  if (symbolRecords.length > 0) store.upsertSymbols(symbolRecords);
  if (communityRecords.length > 0) store.upsertCommunities(communityRecords);
  if (changeCouplingRecords.length > 0) store.upsertChangeCoupling(changeCouplingRecords);

  // Phase 2: Symbol resolution, symbol edges and symbol HITS
  if (fileGraphResults && fileGraphResults.size > 0 && symbolRecords.length > 0) {
    runSymbolPipeline(store, graph, fileGraphResults, edgeRecords);
  }

  // Store head commit
  const headCommit = gitExecSafe(["rev-parse", "HEAD"], { cwd: rootDir }) ?? undefined;
  if (headCommit) store.setMeta("head_commit", headCommit);
  store.setMeta("build_timestamp", now);

  store.refreshBm25fStats();
}

/**
 * Load the persisted graph from SQLite for use by the steer module.
 * Returns null if no database exists.
 */
export async function loadPersistedGraph(rootDir: string, store?: GraphStore): Promise<PersistedGraph | null> {
  const ownStore = !store;
  let activeStore: GraphStore | undefined;
  try {
    activeStore = store ?? (await openGraphStore(rootDir));
    const persisted = buildPersistedGraphFromStore(activeStore);
    // Check if we have any data
    if (Object.keys(persisted.files).length === 0) return null;
    return persisted;
  } catch {
    return null;
  } finally {
    if (ownStore) activeStore?.close();
  }
}

// ── Phase 2: Symbol resolution + HITS pipeline ───────────────────────────────

/**
 * Run the symbol-level pipeline after basic data is persisted:
 * 1. Load symbol IDs from the DB
 * 2. Build symbol index for resolution
 * 3. Run 4-tier resolution to produce symbol edges
 * 4. Store symbol edges
 * 5. Run HITS on symbol graph
 * 6. Update symbol authority scores
 */
function runSymbolPipeline(
  store: GraphStore,
  graph: ImportGraph,
  fileGraphResults: Map<string, FileGraphResult>,
  edgeRecords: FileEdgeRecord[],
): void {
  // 1. Load symbol graph to get IDs
  const symGraph = store.loadSymbolGraph();
  if (symGraph.symbols.size === 0) return;

  // 2. Build symbol index
  const symbolEntries = [...symGraph.symbols.values()].map((s) => ({
    id: s.id,
    filePath: s.filePath,
    name: s.name,
    kind: s.kind,
    startLine: s.startLine,
  }));
  const symbolIndex = buildSymbolIndex(symbolEntries);

  // 3. Build file edges for import map
  const fileEdgesForImportMap = edgeRecords.map((e) => ({
    fromPath: e.from_path,
    toPath: e.to_path,
    importedNames: e.imported_names ?? [],
    isBarrelRouted: (e.is_barrel_routed ?? 0) === 1,
  }));

  // Also include edges from the full graph (may have additional barrel-routed edges)
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const exists = fileEdgesForImportMap.some((e) => e.fromPath === edge.from && e.toPath === edge.to);
    if (!exists) {
      fileEdgesForImportMap.push({
        fromPath: edge.from,
        toPath: edge.to,
        importedNames: edge.importedNames,
        isBarrelRouted: edge.isBarrelRouted ?? false,
      });
    }
  }

  // 4. Build import maps (needed by all resolution modules)
  const importMaps = new Map<string, ReturnType<typeof buildImportMap>>();
  for (const [filePath] of fileGraphResults) {
    importMaps.set(filePath, buildImportMap(filePath, fileEdgesForImportMap));
  }

  // 4b. Build type alias map (RFC §2.15) - must precede resolution so aliases are followed
  const aliasMap = buildAliasMap(fileGraphResults, symbolIndex, importMaps);

  // 4c. Run core 4-tier resolution with alias awareness
  const cache = new LRUCache<string, number | null>(10000);
  const resolvedEdges = resolveAllSymbolEdges({
    fileGraphs: fileGraphResults,
    fileEdges: fileEdgesForImportMap,
    symbolIndex,
    cache,
    aliasMap,
  });

  // 4d. Language-specific resolution (Python MRO, Go structural, Rust traits)
  const pythonMROEdges = resolvePythonMROEdges(fileGraphResults, symbolIndex, importMaps);
  const goStructuralEdges = resolveGoStructuralEdges(fileGraphResults, symbolIndex, importMaps);
  const rustTraitEdges = resolveRustTraitEdges(fileGraphResults, symbolIndex, importMaps);

  // Merge all resolved edges
  const allResolvedEdges = [...resolvedEdges, ...pythonMROEdges, ...goStructuralEdges, ...rustTraitEdges];

  // 5. Convert to DB records and store
  const symbolEdgeRecords = resolvedEdgesToRecords(allResolvedEdges, symbolIndex, cache);
  if (symbolEdgeRecords.length > 0) {
    store.upsertSymbolEdges(symbolEdgeRecords);
  }

  // 6. Run HITS on symbol graph
  const barrelFiles = graph.barrelFiles ?? new Set<string>();
  const symbolNodes: SymbolNode[] = [...symGraph.symbols.values()].map((s) => ({
    id: s.id,
    filePath: s.filePath,
    name: s.name,
    kind: s.kind,
    isBarrel: barrelFiles.has(s.filePath),
  }));

  const symbolIdLookup = (file: string, name: string): number | null => {
    const cacheKey = `${file}::${name}`;
    const cached = cache.get(cacheKey);
    if (cached !== undefined) return cached;

    const entries = symbolIndex.byFileAndName.get(cacheKey);
    if (!entries || entries.length === 0) {
      cache.set(cacheKey, null);
      return null;
    }
    const id = entries[0].id;
    cache.set(cacheKey, id);
    return id;
  };

  const symbolHITS = computeSymbolHITS(symbolNodes, allResolvedEdges, symbolIdLookup);

  // 7. Update symbol authority in DB
  const authorityUpdates: SymbolRecord[] = [];
  for (const [symId, authScore] of symbolHITS.authority) {
    const sym = symGraph.symbols.get(symId);
    if (!sym) continue;
    authorityUpdates.push({
      file_path: sym.filePath,
      name: sym.name,
      kind: sym.kind,
      start_line: sym.startLine,
      authority: authScore,
    });
  }
  if (authorityUpdates.length > 0) {
    store.upsertSymbols(authorityUpdates);
  }

  // 8. M4: Aggregate symbol-level scores to file level and write back.
  // File authority = max symbol authority, file hub = max symbol hub.
  // This closes the feedback loop: symbol resolution feeds file-level metrics.
  const fileAgg = aggregateToFileLevel(symbolNodes, symbolHITS, allResolvedEdges);
  const now = new Date().toISOString();
  const fileScoreUpdates: FileRecord[] = [];
  for (const [filePath, auth] of fileAgg.authority) {
    const hub = fileAgg.hubScores.get(filePath) ?? 0;
    fileScoreUpdates.push({
      path: filePath,
      hash: "",
      authority: auth,
      hub_score: hub,
      role: deriveRole(auth, hub, barrelFiles.has(filePath)),
      updated_at: now,
    });
  }
  if (fileScoreUpdates.length > 0) {
    // Preserve existing hashes so we don't blank them
    const hashes = store.getAllHashes();
    const merged = fileScoreUpdates.map((f) => ({
      ...f,
      hash: hashes.get(f.path) ?? f.hash,
    }));
    store.upsertFiles(merged);
  }

  store.setMeta("symbol_edge_count", String(symbolEdgeRecords.length));
  store.setMeta("symbol_hits_complete", "true");
}

/**
 * Convert resolved symbol edges to DB records.
 * Looks up symbol IDs for the from/to pairs.
 */
function resolvedEdgesToRecords(
  resolvedEdges: ResolvedSymbolEdge[],
  symbolIndex: ReturnType<typeof buildSymbolIndex>,
  cache: LRUCache<string, number | null>,
): SymbolEdgeRecord[] {
  const records: SymbolEdgeRecord[] = [];
  const seen = new Set<string>();

  for (const edge of resolvedEdges) {
    const fromKey = `${edge.fromFile}::${edge.fromSymbol}`;
    const toKey = `${edge.toFile}::${edge.toSymbol}`;

    let fromId = cache.get(fromKey) ?? null;
    if (fromId === undefined) fromId = null;
    if (fromId === null) {
      const entries = symbolIndex.byFileAndName.get(fromKey);
      if (entries && entries.length > 0) fromId = entries[0].id;
    }

    let toId = cache.get(toKey) ?? null;
    if (toId === undefined) toId = null;
    if (toId === null) {
      const entries = symbolIndex.byFileAndName.get(toKey);
      if (entries && entries.length > 0) toId = entries[0].id;
    }

    if (fromId === null || toId === null) continue;

    const dedupeKey = `${fromId}:${toId}:${edge.kind}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    records.push({
      from_symbol_id: fromId,
      to_symbol_id: toId,
      kind: edge.kind,
      line: edge.line,
      ordinal: edge.ordinal ?? null,
      confidence: edge.confidence,
    });
  }

  return records;
}

export { computeSymbolAuthority } from "./persist-helpers.js";
// Re-export for test compatibility
export { CLARTE_DIR, PERSISTED_GRAPH_VERSION };
