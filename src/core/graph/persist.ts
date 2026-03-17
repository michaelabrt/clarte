import type { GraphStore } from "../../storage/graph-store";
import { buildPersistedGraphFromStore, openGraphStore } from "../../storage/loader";
import type {
  ChangeCouplingRecord,
  CommunityRecord,
  FileEdgeRecord,
  FileRecord,
  SymbolEdgeRecord,
  SymbolRecord,
} from "../../storage/types";
import { CLARTE_DIR } from "../config/config";
import { gitExecSafe } from "../git/git";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph } from "../types/persisted-graph";
import type { ContextAnalysis, ImportGraph } from "../types";
import { deriveRole } from "./centrality";
import { resolveGoStructuralEdges } from "./go-resolution";
import { computeAllInstabilities } from "./instability";
import { computeSymbolAuthority } from "./persist-helpers";
import { resolvePythonMROEdges } from "./python-mro";
import { resolveRustTraitEdges } from "./rust-resolution";
import { aggregateToFileLevel, computeSymbolHITS, type SymbolNode } from "./symbol-hits";
import { buildImportMap, buildSymbolIndex, LRUCache, resolveAllSymbolEdges } from "./symbol-resolution";
import type { FileGraphResult, ResolvedSymbolEdge } from "./symbol-types";
import { buildAliasMap } from "./type-aliases";
import { GHOST_EDGES_ENABLED } from "../config/thresholds";
import { ghostCandidateToResolved } from "./ghost-types";
import { applyNoiseGate } from "./ghost-noise-gate";
import { detectDIEdges } from "../parsers/ghost-di";
import { detectEventEdges } from "../parsers/ghost-events";
import { detectRouteEdges } from "../parsers/ghost-routes";
import { detectRustTraitBoundEdges } from "../parsers/ghost-rust-traits";
import { detectPythonDescriptorEdges } from "../parsers/ghost-python-descriptors";
import { buildNeighborhoodsFromResolvedEdges, buildFileNeighborhoods } from "./constraint-resolution";
import { computeSymbolBlame } from "../git/blame";
import { computeFileEmbeddings } from "./semantic-lsa";
import { parseGitLog } from "../git/analysis";
import { trainFusionWeights } from "./logistic-fusion";
import {
  initializeEdgePriors,
  updateEdgePriorsFromCommits,
  computeExpectedWeights,
  type EdgePrior,
} from "./bayesian-edges";

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
    await persistGraphToStore(rootDir, activeStore, graph, analysis);
  } finally {
    if (ownStore) activeStore.close();
  }
}

async function persistGraphToStore(
  rootDir: string,
  store: GraphStore,
  graph: ImportGraph,
  analysis: ContextAnalysis,
): Promise<void> {
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
      symbolBodyTokens: bodyTokens ? Object.fromEntries(bodyTokens) : Object.create(null),
      symbolStartLines: startLines ? Object.fromEntries(startLines) : Object.create(null),
      symbolAuthority: Object.create(null),
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
      // layers, test_files, intra_file_calls are JSON arrays stored in TEXT columns,
      // the same pattern as imported_names. These columns let the steer module
      // reconstruct a PersistedGraph without a separate relational table per array.
      // They are read back via parseJsonArray() in graph-store.ts, symmetric with
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
  // When fileGraphResults are available, use SymbolDefinition.kind for correct kinds.
  // Fall back to the legacy graph.symbolNames path only when fileGraphResults is absent,
  // using "function" as a safe default (valid kinds exclude "unknown").
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
    conf_ab: c.confidenceAB ?? null,
    conf_ba: c.confidenceBA ?? null,
    last_cochange_days: c.lastCochangeDays ?? null,
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

  // Symbol resolution, symbol edges and symbol HITS
  if (fileGraphResults && fileGraphResults.size > 0 && symbolRecords.length > 0) {
    runSymbolPipeline(store, graph, fileGraphResults, edgeRecords);
  }

  // Store head commit
  const headCommit = gitExecSafe(["rev-parse", "HEAD"], { cwd: rootDir }) ?? undefined;
  if (headCommit) store.setMeta("head_commit", headCommit);
  store.setMeta("build_timestamp", now);

  // Blame-boundary temporal decay
  if (fileGraphResults && fileGraphResults.size > 0) {
    const symGraph = store.loadSymbolGraph();
    if (symGraph.symbols.size > 0) {
      const blameData = await computeSymbolBlame(rootDir, symGraph);
      if (headCommit) store.storeSymbolBlame(headCommit, blameData);

      // LSA file embeddings
      const embeddings = computeFileEmbeddings(symGraph);
      if (embeddings) store.storeLSAEmbeddings(embeddings);
    }
  }

  store.refreshBm25fStats();

  // Logistic fusion weight training: parse recent commits and train
  // repo-specific lambda weights from co-change history with hard negative mining.
  try {
    const commits = parseGitLog(rootDir, { days: 90 });
    const fileGraph = store.loadFileGraph();

    // Build change coupling lookup for training
    const couplingRows = store.loadChangeCoupling();
    const couplingMap = new Map<string, Map<string, number>>();
    for (const row of couplingRows) {
      let mapA = couplingMap.get(row.file_a);
      if (!mapA) {
        mapA = new Map();
        couplingMap.set(row.file_a, mapA);
      }
      mapA.set(row.file_b, row.confidence);

      let mapB = couplingMap.get(row.file_b);
      if (!mapB) {
        mapB = new Map();
        couplingMap.set(row.file_b, mapB);
      }
      mapB.set(row.file_a, row.confidence);
    }

    const weights = trainFusionWeights(commits, fileGraph, couplingMap);
    if (weights) {
      store.setMeta("fusion_weights", JSON.stringify(weights));
    }

    // Bayesian EWMA edge priors: initialize from structural graph,
    // then process commit history via EWMA.
    const priors = initializeEdgePriors(fileGraph);
    const priorMap = new Map<string, EdgePrior>();
    for (const p of priors) priorMap.set(`${p.fromPath}||${p.toPath}`, p);

    if (commits.length > 0) {
      // Process oldest-first for correct EWMA accumulation
      const chronological = [...commits].reverse();
      updateEdgePriorsFromCommits(priorMap, chronological, fileGraph);
    }

    const updatedPriors = [...priorMap.values()];
    if (updatedPriors.length > 0) {
      store.upsertEdgePriors(
        updatedPriors.map((p) => ({
          from_path: p.fromPath,
          to_path: p.toPath,
          alpha: p.alpha,
          beta: p.beta,
        })),
      );

      // Store computed expected weights for quick runtime lookup
      const expectedWeights = computeExpectedWeights(updatedPriors);
      store.setMeta("edge_prior_weights", JSON.stringify(Object.fromEntries(expectedWeights)));
    }
  } catch {
    // Fusion/EWMA is non-critical; don't block the pipeline
  }
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

// ── Symbol resolution + HITS pipeline ─────────────────────────────────────────

/**
 * Run the symbol-level pipeline after basic data is persisted.
 *
 * Two-pass architecture to break the HITS/Tier-5 circular dependency:
 *   Pass 1: Tiers 1-3 + language-specific + ghost -> edges_base -> HITS
 *   Pass 2: Tier 5 using fresh HITS authority + neighborhoods from pass 1
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

  // 4b. Build type alias map - must precede resolution so aliases are followed
  const aliasMap = buildAliasMap(fileGraphResults, symbolIndex, importMaps);

  // 4c. PASS 1: Tiers 1-3 only (no Tier 5 fields in context)
  const cache = new LRUCache<string, number | null>(10000);
  const pass1Edges = resolveAllSymbolEdges({
    fileGraphs: fileGraphResults,
    fileEdges: fileEdgesForImportMap,
    symbolIndex,
    cache,
    aliasMap,
  });

  // 4d. Language-specific resolution (Python MRO, Go structural, Rust traits)
  const pythonMROEdges = resolvePythonMROEdges(fileGraphResults, symbolIndex, importMaps);
  const goResult = resolveGoStructuralEdges(fileGraphResults, symbolIndex, importMaps);
  const rustTraitEdges = resolveRustTraitEdges(fileGraphResults, symbolIndex, importMaps);

  // Merge pass 1 edges
  const allPass1Edges = [...pass1Edges, ...pythonMROEdges, ...goResult.edges, ...rustTraitEdges];

  // Load community map (shared between ghost edges and Tier 5)
  const leanGraph = store.loadFileGraphLean();
  const fileCommunities = new Map<string, number>();
  for (const [p, node] of leanGraph.nodes) {
    if (node.communityId !== null) fileCommunities.set(p, node.communityId);
  }

  // Ghost edge detection + noise gate
  if (GHOST_EDGES_ENABLED) {
    const ghostCandidates = [
      ...detectDIEdges(fileGraphResults, symbolIndex, importMaps),
      ...detectEventEdges(fileGraphResults, symbolIndex, fileGraphResults.size),
      ...detectRouteEdges(fileGraphResults, symbolIndex, importMaps),
      ...detectRustTraitBoundEdges(fileGraphResults, symbolIndex),
      ...detectPythonDescriptorEdges(fileGraphResults, symbolIndex, importMaps),
    ];

    const ghostFiltered = applyNoiseGate(ghostCandidates, fileGraphResults.size, allPass1Edges, fileCommunities);
    for (const c of ghostFiltered) allPass1Edges.push(ghostCandidateToResolved(c));
  }

  // 5. Run HITS on pass 1 edges (before Tier 5)
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

  const symbolHITS = computeSymbolHITS(symbolNodes, allPass1Edges, symbolIdLookup);

  // 6. Inject fresh HITS authority into in-memory symbol graph for Tier 5
  for (const [symId, authScore] of symbolHITS.authority) {
    const node = symGraph.symbols.get(symId);
    if (node) node.authority = authScore;
  }

  // 7. PASS 2: Tier 5 proximity disambiguation with live authority
  const symbolNeighborhoods = buildNeighborhoodsFromResolvedEdges(allPass1Edges, symbolIndex);
  const fileNeighborhoods = buildFileNeighborhoods(fileEdgesForImportMap);

  const pass2Edges = resolveAllSymbolEdges({
    fileGraphs: fileGraphResults,
    fileEdges: fileEdgesForImportMap,
    symbolIndex,
    cache,
    aliasMap,
    symbolNeighborhoods,
    fileNeighborhoods,
    fileCommunities,
    symbolGraph: symGraph,
  });

  // Extract Tier 5-only edges (pass 2 minus pass 1)
  const pass1Keys = new Set(
    pass1Edges.map((e) => `${e.fromFile}::${e.fromSymbol}\0${e.toFile}::${e.toSymbol}\0${e.kind}`),
  );
  const tier5Edges = pass2Edges.filter(
    (e) => !pass1Keys.has(`${e.fromFile}::${e.fromSymbol}\0${e.toFile}::${e.toSymbol}\0${e.kind}`),
  );

  // Final edge set: pass 1 (with language-specific + ghost) + Tier 5
  const allResolvedEdges = [...allPass1Edges, ...tier5Edges];

  // 8. Store all edges
  const symbolEdgeRecords = resolvedEdgesToRecords(allResolvedEdges, symbolIndex, cache);
  if (symbolEdgeRecords.length > 0) {
    store.upsertSymbolEdges(symbolEdgeRecords);
  }

  // 9. Update symbol authority in DB
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

  // 10. Aggregate symbol-level scores to file level and write back.
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

export { computeSymbolAuthority } from "./persist-helpers";
// Re-export for test compatibility
export { CLARTE_DIR, PERSISTED_GRAPH_VERSION };
