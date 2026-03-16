/**
 * JSON-to-SQLite migration.
 *
 * On first run after upgrade, reads legacy JSON cache files and writes their
 * contents to graph.db, then deletes the JSON files.
 *
 * Three JSON files consolidate into one SQLite database:
 *   .clarte/cache.json         -> files + file_edges tables
 *   .clarte/graph.json         -> files table (scores) + communities + change_coupling
 *   .clarte/call-graph.json    -> call_sites table
 *
 * Idempotent: if graph.db already has schema_version set, migration is skipped.
 * Crash-safe: if graph.db exists but lacks schema_version, it is deleted and recreated.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { GraphStore } from "./graph-store.js";
import type { FileRecord, FileEdgeRecord, CallSiteRecord, CommunityRecord, ChangeCouplingRecord } from "./types.js";

const CLARTE_DIR = ".clarte";

// ── Legacy JSON formats (read-only, for migration only) ────────────────────────

interface LegacyCacheData {
  version: number;
  createdAt: string;
  language: string;
  fileHashes: Record<string, string>;
  edges: Array<{
    from: string;
    to: string;
    isExternal: boolean;
    specifier: string;
    importedNames: string[];
    isTypeOnly?: boolean;
    isDynamic?: boolean;
    isBarrelRouted?: boolean;
  }>;
  barrelFiles: string[];
  symbolNames?: Record<string, string[]>;
}

interface LegacyPersistedGraph {
  version: number;
  timestamp: string;
  headCommit?: string;
  files: Record<
    string,
    {
      role: string | null;
      authority: number;
      hubScore: number;
      betweenness: number;
      instability: number | null;
      importedByCount: number;
      isChokepoint: boolean;
      separatesComponents: number;
      isCrossCutting: boolean;
      layerSpread: number;
      layers: string[];
      hasTests: boolean;
      testFiles: string[];
      communityId: number | null;
      symbolNames?: string[];
      symbolBodyTokens?: Record<string, string[]>;
      symbolStartLines?: Record<string, number>;
      symbolAuthority?: Record<string, number>;
      intraFileCalls?: Array<[string, string]>;
    }
  >;
  edges: Array<{
    from: string;
    to: string;
    importedNames: string[];
    isTypeOnly?: boolean;
    isDynamic?: boolean;
    isBarrelRouted?: boolean;
  }>;
  communities: Array<{ id: number; files: string[]; label: string }>;
  changeCoupling: Array<{
    fileA: string;
    fileB: string;
    confidence: number;
    coChangeCount: number;
  }>;
}

interface LegacyCallGraph {
  version: number;
  timestamp: string;
  sites: Array<{
    caller: string;
    callerFn: string;
    callee: string;
    calleeFile: string | null;
    line: number;
  }>;
  fileHashes: Record<string, string>;
}

// ── Public API ─────────────────────────────────────────────────────────────────

/**
 * Migrate from legacy JSON files to SQLite if needed.
 * Returns true if migration was performed, false if skipped.
 */
export async function migrateFromJson(rootDir: string, store: GraphStore): Promise<boolean> {
  const clarteDir = path.join(rootDir, CLARTE_DIR);

  const cachePath = path.join(clarteDir, "cache.json");
  const graphPath = path.join(clarteDir, "graph.json");
  const callGraphPath = path.join(clarteDir, "call-graph.json");

  // Check if any legacy JSON files exist
  const [cacheExists, graphExists, callGraphExists] = await Promise.all([
    fileExists(cachePath),
    fileExists(graphPath),
    fileExists(callGraphPath),
  ]);

  if (!cacheExists && !graphExists && !callGraphExists) {
    return false; // nothing to migrate
  }

  const now = new Date().toISOString();
  let headCommit: string | undefined;

  // Parse JSON files (partial failures are tolerated)
  let cache: LegacyCacheData | null = null;
  let graph: LegacyPersistedGraph | null = null;
  let callGraph: LegacyCallGraph | null = null;

  if (cacheExists) {
    cache = await parseJsonFile<LegacyCacheData>(cachePath);
    if (!cache) process.stderr.write(`[clarte] Warning: could not parse cache.json - skipping\n`);
  }
  if (graphExists) {
    graph = await parseJsonFile<LegacyPersistedGraph>(graphPath);
    if (!graph) process.stderr.write(`[clarte] Warning: could not parse graph.json - skipping\n`);
    headCommit = graph?.headCommit;
  }
  if (callGraphExists) {
    callGraph = await parseJsonFile<LegacyCallGraph>(callGraphPath);
    if (!callGraph) process.stderr.write(`[clarte] Warning: could not parse call-graph.json - skipping\n`);
  }

  // Build file records: merge cache.json hashes + graph.json scores
  const fileRecords = buildFileRecords(cache, graph, now);
  const edgeRecords = buildEdgeRecords(cache, graph);
  const communityRecords = buildCommunityRecords(graph);
  const changeCouplingRecords = buildChangeCouplingRecords(graph);
  const callSiteRecords = buildCallSiteRecords(callGraph);
  const symbolRecords = buildSymbolRecords(cache, graph);

  // Write to SQLite in a single transaction
  store.transaction(() => {
    if (fileRecords.length > 0) store.upsertFiles(fileRecords);
    if (edgeRecords.length > 0) store.upsertFileEdges(edgeRecords);
    if (communityRecords.length > 0) store.upsertCommunities(communityRecords);
    if (changeCouplingRecords.length > 0) store.upsertChangeCoupling(changeCouplingRecords);
    if (callSiteRecords.length > 0) store.upsertCallSites(callSiteRecords);
    if (symbolRecords.length > 0) store.upsertSymbols(symbolRecords);

    if (headCommit) store.setMeta("head_commit", headCommit);
    if (cache?.createdAt) store.setMeta("created_at", cache.createdAt);
  });

  // Delete legacy files after successful migration
  await deleteFileSafe(cachePath);
  await deleteFileSafe(graphPath);
  await deleteFileSafe(callGraphPath);

  process.stderr.write(`[clarte] Migrated ${fileRecords.length} files from JSON caches to graph.db\n`);
  return true;
}

// ── Builders ──────────────────────────────────────────────────────────────────

function buildFileRecords(
  cache: LegacyCacheData | null,
  graph: LegacyPersistedGraph | null,
  now: string,
): FileRecord[] {
  const records = new Map<string, FileRecord>();

  // Start with file hashes from cache.json
  if (cache?.fileHashes) {
    const barrelSet = new Set(cache.barrelFiles ?? []);
    for (const [p, hash] of Object.entries(cache.fileHashes)) {
      records.set(p, {
        path: p,
        hash,
        is_barrel: barrelSet.has(p) ? 1 : 0,
        updated_at: now,
      });
    }
  }

  // Merge analysis scores from graph.json
  if (graph?.files) {
    for (const [p, fileRec] of Object.entries(graph.files)) {
      const existing = records.get(p);
      const base: FileRecord = existing ?? { path: p, hash: "", updated_at: now };
      records.set(p, {
        ...base,
        role: fileRec.role ?? undefined,
        authority: fileRec.authority,
        hub_score: fileRec.hubScore,
        betweenness: fileRec.betweenness,
        instability: fileRec.instability ?? undefined,
        community_id: fileRec.communityId ?? undefined,
        is_barrel: existing?.is_barrel,
        is_chokepoint: fileRec.isChokepoint ? 1 : 0,
        separates_components: fileRec.separatesComponents,
        is_cross_cutting: fileRec.isCrossCutting ? 1 : 0,
        layer_spread: fileRec.layerSpread,
        has_tests: fileRec.hasTests ? 1 : 0,
        layers: fileRec.layers?.length ? JSON.stringify(fileRec.layers) : null,
        test_files: fileRec.testFiles?.length ? JSON.stringify(fileRec.testFiles) : null,
        intra_file_calls: fileRec.intraFileCalls?.length ? JSON.stringify(fileRec.intraFileCalls) : null,
        updated_at: now,
      });
    }
  }

  return [...records.values()];
}

function buildEdgeRecords(cache: LegacyCacheData | null, graph: LegacyPersistedGraph | null): FileEdgeRecord[] {
  // Prefer graph.json edges (internal only) over cache.json (includes external)
  if (graph?.edges) {
    return graph.edges.map((e) => ({
      from_path: e.from,
      to_path: e.to,
      imported_names: e.importedNames,
      is_type_only: e.isTypeOnly ? 1 : 0,
      is_dynamic: e.isDynamic ? 1 : 0,
      is_barrel_routed: e.isBarrelRouted ? 1 : 0,
    }));
  }

  if (cache?.edges) {
    return cache.edges
      .filter((e) => !e.isExternal)
      .map((e) => ({
        from_path: e.from,
        to_path: e.to,
        imported_names: e.importedNames,
        is_type_only: e.isTypeOnly ? 1 : 0,
        is_dynamic: e.isDynamic ? 1 : 0,
        is_barrel_routed: e.isBarrelRouted ? 1 : 0,
      }));
  }

  return [];
}

function buildCommunityRecords(graph: LegacyPersistedGraph | null): CommunityRecord[] {
  if (!graph?.communities) return [];
  return graph.communities.map((c) => ({ id: c.id, label: c.label }));
}

function buildChangeCouplingRecords(graph: LegacyPersistedGraph | null): ChangeCouplingRecord[] {
  if (!graph?.changeCoupling) return [];
  return graph.changeCoupling.map((c) => ({
    file_a: c.fileA,
    file_b: c.fileB,
    co_changes: c.coChangeCount,
    confidence: c.confidence,
  }));
}

function buildCallSiteRecords(callGraph: LegacyCallGraph | null): CallSiteRecord[] {
  if (!callGraph?.sites) return [];
  return callGraph.sites
    .filter((s) => s.calleeFile !== null)
    .map((s) => ({
      caller_file: s.caller,
      caller_fn: s.callerFn || null,
      callee_name: s.callee,
      callee_file: s.calleeFile,
      line: s.line,
    }));
}

function buildSymbolRecords(
  _cache: LegacyCacheData | null,
  graph: LegacyPersistedGraph | null,
): Array<{
  file_path: string;
  name: string;
  kind: string;
  start_line: number;
  end_line?: number | null;
  authority?: number | null;
  body_hash?: string | null;
  body_tokens?: string | null;
  import_names?: string | null;
}> {
  const records: Array<{
    file_path: string;
    name: string;
    kind: string;
    start_line: number;
    end_line?: number | null;
    authority?: number | null;
    body_hash?: string | null;
    body_tokens?: string | null;
    import_names?: string | null;
  }> = [];

  if (!graph?.files) return records;

  for (const [filePath, fileRec] of Object.entries(graph.files)) {
    const symbolNames = fileRec.symbolNames ?? [];
    const startLines = fileRec.symbolStartLines ?? {};
    const bodyTokens = fileRec.symbolBodyTokens ?? {};
    const authority = fileRec.symbolAuthority ?? {};

    for (const name of symbolNames) {
      const startLine = startLines[name] ?? 0;
      const tokens = bodyTokens[name];
      const bodyTokenStr = tokens ? tokens.join(" ") : null;
      const symAuth = authority[name] ?? null;

      records.push({
        file_path: filePath,
        name,
        kind: "unknown",
        start_line: startLine,
        authority: symAuth,
        body_tokens: bodyTokenStr,
        import_names: null,
      });
    }
  }

  return records;
}

// ── Helpers ────────────────────────────────────────────────────────────────────

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function parseJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    const raw = await fs.readFile(filePath, "utf-8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

async function deleteFileSafe(filePath: string): Promise<void> {
  try {
    await fs.unlink(filePath);
  } catch {
    // Non-fatal: read-only filesystem or already deleted
  }
}
