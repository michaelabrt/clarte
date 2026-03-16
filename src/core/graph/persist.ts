import { gitExecSafe } from "../git/git.js";
import { deriveRole } from "./centrality.js";
import { computeAllInstabilities } from "./instability.js";
import type { ContextAnalysis, ImportGraph } from "../types.js";
import { PERSISTED_GRAPH_VERSION, type PersistedGraph } from "../types/persisted-graph.js";
import { CLARTE_DIR } from "../config/config.js";
import { openGraphStore } from "../../storage/loader.js";
import { buildPersistedGraphFromStore } from "../../storage/loader.js";
import type { GraphStore } from "../../storage/graph-store.js";
import type {
  FileRecord,
  FileEdgeRecord,
  CommunityRecord,
  ChangeCouplingRecord,
  SymbolRecord,
} from "../../storage/types.js";
import { computeSymbolAuthority } from "./persist-helpers.js";

/**
 * Persist the analysis graph to .clarte/graph.db.
 * Stores file scores, edges, communities and change coupling in SQLite.
 * Non-critical: callers should wrap in try/catch.
 */
export async function persistGraph(rootDir: string, graph: ImportGraph, analysis: ContextAnalysis): Promise<void>;
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

  // Build symbol records
  const symbolRecords: SymbolRecord[] = [];
  for (const [filePath, data] of fileSymbolData) {
    const importNames = graph.edges.filter((e) => e.from === filePath && !e.isExternal).flatMap((e) => e.importedNames);
    const importNamesStr = importNames.length > 0 ? JSON.stringify(importNames) : null;

    for (const name of data.symbolNames) {
      const startLine = data.symbolStartLines[name] ?? 0;
      const tokens = data.symbolBodyTokens[name];
      symbolRecords.push({
        file_path: filePath,
        name,
        kind: "unknown",
        start_line: startLine,
        authority: data.symbolAuthority[name] ?? null,
        body_tokens: tokens ? tokens.join(" ") : null,
        import_names: importNamesStr,
      });
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
      mergedFileRecords.push({ path: e.from_path, hash: existingHashes.get(e.from_path) ?? "", updated_at: now });
      knownPaths.add(e.from_path);
    }
    if (e.to_path && !knownPaths.has(e.to_path)) {
      mergedFileRecords.push({ path: e.to_path, hash: existingHashes.get(e.to_path) ?? "", updated_at: now });
      knownPaths.add(e.to_path);
    }
  }

  store.upsertFiles(mergedFileRecords);
  store.upsertFileEdges(edgeRecords);
  if (symbolRecords.length > 0) store.upsertSymbols(symbolRecords);
  if (communityRecords.length > 0) store.upsertCommunities(communityRecords);
  if (changeCouplingRecords.length > 0) store.upsertChangeCoupling(changeCouplingRecords);

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
export async function loadPersistedGraph(rootDir: string): Promise<PersistedGraph | null>;
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

// Re-export for test compatibility
export { CLARTE_DIR };
export { PERSISTED_GRAPH_VERSION };
export { computeSymbolAuthority } from "./persist-helpers.js";
