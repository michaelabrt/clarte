/**
 * Loading protocol: opens graph.db, runs migration if needed, and provides
 * adapter functions to convert SQLite data into the in-memory types that
 * the rest of the codebase expects.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { createDatabase } from "./db-adapter.js";
import { initSchema } from "./schema.js";
import { GraphStore } from "./graph-store.js";
import { migrateFromJson } from "./migrate.js";
import type { InMemoryFileGraph } from "./types.js";
import type { ImportEdge, ImportGraph } from "../core/types.js";
import type { PersistedGraph, FileRecord as PersistedFileRecord, EdgeRecord } from "../core/types/persisted-graph.js";

const CLARTE_DIR = ".clarte";
const DB_FILENAME = "graph.db";

/**
 * Open (or create) the graph database for a project root.
 *
 * Flow:
 *   1. Create .clarte/ directory if it doesn't exist
 *   2. Create DatabaseAdapter via 3-tier fallback
 *   3. Initialize schema (idempotent DDL)
 *   4. Run JSON migration if legacy files exist
 *
 * Returns a ready-to-use GraphStore.
 */
export async function openGraphStore(rootDir: string): Promise<GraphStore> {
  const clarteDir = path.join(rootDir, CLARTE_DIR);
  const dbPath = path.join(clarteDir, DB_FILENAME);

  await fs.mkdir(clarteDir, { recursive: true });

  // Handle partial migration: if graph.db exists but lacks schema_version, delete and start fresh
  try {
    await fs.access(dbPath);
    // File exists - check if it's valid
  } catch {
    // File doesn't exist - will be created by createDatabase
  }

  const db = await createDatabase(dbPath);
  initSchema(db);

  const store = new GraphStore(db);

  // Run migration from legacy JSON files (no-op if already migrated)
  await migrateFromJson(rootDir, store);

  return store;
}

/**
 * Convert an InMemoryFileGraph (from SQLite) into an ImportGraph (for algorithms).
 *
 * The ImportGraph is the in-memory format consumed by all analysis algorithms
 * (HITS, betweenness, SCC, communities, etc.). This is the integration seam
 * between the storage layer and the analysis layer.
 */
export function sqliteToImportGraph(fileGraph: InMemoryFileGraph): ImportGraph {
  const allFilePaths = new Set<string>(fileGraph.nodes.keys());

  // Reconstruct ImportEdge[] from InMemoryEdge[] (both internal and file_edges are internal-only)
  const edges: ImportEdge[] = [];
  for (const fileEdges of fileGraph.forward.values()) {
    for (const e of fileEdges) {
      edges.push({
        from: e.fromPath,
        to: e.toPath,
        isExternal: false,
        specifier: e.toPath, // specifier not stored; use path as fallback
        importedNames: e.importedNames,
        isTypeOnly: e.isTypeOnly,
        isDynamic: e.isDynamic,
        isBarrelRouted: e.isBarrelRouted,
        crossPackage: e.crossPackage,
      });
    }
  }

  // Reconstruct maps from nodes
  const inDegree = new Map<string, number>();
  const directInDegree = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();
  const betweennessScores = new Map<string, number>();
  const barrelFiles = new Set<string>();
  const symbolNames = new Map<string, string[]>();

  // Initialize all files at 0
  for (const [p] of fileGraph.nodes) {
    inDegree.set(p, 0);
    directInDegree.set(p, 0);
  }

  // Compute in-degree from edges
  for (const e of edges) {
    inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    if (!e.isBarrelRouted && !barrelFiles.has(e.from)) {
      directInDegree.set(e.to, (directInDegree.get(e.to) ?? 0) + 1);
    }
  }

  // Copy scores from stored nodes
  for (const [p, node] of fileGraph.nodes) {
    authority.set(p, node.authority);
    hubScores.set(p, node.hubScore);
    betweennessScores.set(p, node.betweenness);
    if (node.isBarrel) barrelFiles.add(p);
  }

  // external package imports are NOT stored in file_edges (only internal edges)
  const externalImportCounts = new Map<string, number>();

  // Ensure ALL known files appear in inDegree (even if never imported)
  for (const p of allFilePaths) {
    if (!inDegree.has(p)) inDegree.set(p, 0);
  }

  return {
    edges,
    inDegree,
    directInDegree,
    centrality: authority, // backward compat alias
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles,
    betweennessScores,
    symbolNames: symbolNames.size > 0 ? symbolNames : undefined,
  };
}

/**
 * Reconstruct a PersistedGraph from SQLite for the steer module.
 *
 * The PersistedGraph format is used by:
 *   - src/steer/targets-resolve.ts (BM25F scoring)
 *   - src/core/graph/data.ts (graph traversal)
 *   - The generated hook script (prompt hook)
 */
export function buildPersistedGraphFromStore(store: GraphStore): PersistedGraph {
  const fileGraph = store.loadFileGraph();
  const symbolGraph = store.loadSymbolGraph();
  const communities = store.loadCommunities();
  const changeCoupling = store.loadChangeCoupling();

  const headCommit = store.getMeta("head_commit");
  const timestamp = store.getMeta("created_at") ?? new Date().toISOString();

  // Build files record
  const files: Record<string, PersistedFileRecord> = {};
  for (const [filePath, node] of fileGraph.nodes) {
    // Collect symbol data from symbol graph
    const symbolIds = symbolGraph.byFile.get(filePath) ?? [];
    const fileSymbols = symbolIds.map((id) => symbolGraph.symbols.get(id)).filter(Boolean);

    const symNames =
      fileSymbols.length > 0 ? fileSymbols.map((s) => s?.name).filter((n): n is string => n !== undefined) : undefined;

    const symbolBodyTokens: Record<string, string[]> = {};
    const symbolStartLines: Record<string, number> = {};
    const symbolAuthority: Record<string, number> = {};

    for (const sym of fileSymbols) {
      if (!sym) continue;
      if (sym.bodyTokens) symbolBodyTokens[sym.name] = sym.bodyTokens.split(" ").filter(Boolean);
      if (sym.startLine > 0) symbolStartLines[sym.name] = sym.startLine;
      if (sym.authority !== null && sym.authority !== undefined) symbolAuthority[sym.name] = sym.authority;
    }

    // Compute in-degree from edges
    const incomingEdges = fileGraph.reverse.get(filePath) ?? [];
    const importedByCount = incomingEdges.length;

    files[filePath] = {
      role: node.role as import("../core/types/detection.js").FileRole | null,
      authority: node.authority,
      hubScore: node.hubScore,
      betweenness: node.betweenness,
      instability: node.instability ?? null,
      importedByCount,
      isChokepoint: node.isChokepoint,
      separatesComponents: node.separatesComponents,
      isCrossCutting: node.isCrossCutting,
      layerSpread: node.layerSpread,
      layers: node.layers,
      hasTests: node.hasTests,
      testFiles: node.testFiles,
      communityId: node.communityId ?? null,
      ...(symNames && symNames.length > 0 && { symbolNames: symNames }),
      ...(Object.keys(symbolBodyTokens).length > 0 && { symbolBodyTokens }),
      ...(Object.keys(symbolStartLines).length > 0 && { symbolStartLines }),
      ...(Object.keys(symbolAuthority).length > 0 && { symbolAuthority }),
      ...(node.intraFileCalls.length > 0 && { intraFileCalls: node.intraFileCalls }),
    };
  }

  // Build edges (internal edges only)
  const edges: EdgeRecord[] = [];
  for (const edgeList of fileGraph.forward.values()) {
    for (const e of edgeList) {
      const rec: EdgeRecord = {
        from: e.fromPath,
        to: e.toPath,
        importedNames: e.importedNames,
      };
      if (e.isTypeOnly) rec.isTypeOnly = true;
      if (e.isDynamic) rec.isDynamic = true;
      if (e.isBarrelRouted) rec.isBarrelRouted = true;
      edges.push(rec);
    }
  }

  // Build communities
  // Reconstruct files per community from the communityId stored on file rows
  const communityFiles = new Map<number, string[]>();
  for (const [filePath, node] of fileGraph.nodes) {
    if (node.communityId !== null && node.communityId !== undefined) {
      let arr = communityFiles.get(node.communityId);
      if (!arr) {
        arr = [];
        communityFiles.set(node.communityId, arr);
      }
      arr.push(filePath);
    }
  }

  const communityList = communities.map((c) => ({
    id: c.id,
    files: communityFiles.get(c.id) ?? [],
    label: c.label ?? String(c.id),
  }));

  // Build change coupling
  const changeCouplingList = changeCoupling.map((c) => ({
    fileA: c.file_a,
    fileB: c.file_b,
    confidence: c.confidence,
    coChangeCount: c.co_changes,
  }));

  return {
    version: 1,
    timestamp,
    headCommit,
    files,
    edges,
    communities: communityList,
    changeCoupling: changeCouplingList,
    structuralMismatches: [],
    testMapping: buildTestMapping(files),
    lagCouplings: [],
  };
}

function buildTestMapping(files: Record<string, PersistedFileRecord>): Record<string, string[]> {
  const mapping: Record<string, string[]> = {};
  void files; // test mapping stored in project-cache.json, not in graph.db
  // Return empty - this data is stored in project-cache.json (not migrated)
  return mapping;
}
