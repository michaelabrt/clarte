import path from "node:path";
import { readFileOr, writeFileSafe } from "../utils.js";
import { gitExecSafe } from "../git/git.js";
import { deriveRole } from "./centrality.js";
import { computeAllInstabilities } from "./instability.js";
import type { ContextAnalysis, ImportGraph } from "../types.js";
import {
  PERSISTED_GRAPH_VERSION,
  type EdgeRecord,
  type FileRecord,
  type PersistedGraph,
} from "../types/persisted-graph.js";
import { CLARTE_DIR } from "../config/config.js";

const GRAPH_PATH = `${CLARTE_DIR}/graph.json`;

/**
 * Compute per-symbol authority from cross-file imports + intra-file callers.
 * Uses weighted in-degree (not HITS): type-only edges at 0.3x, intra-file callers at 0.3x.
 * Normalized per-file to [0, 1] using max.
 */
function computeSymbolAuthority(
  edges: EdgeRecord[],
  files: Record<string, FileRecord>,
  intraFileCalls: Map<string, Array<{ caller: string; callee: string }>>,
): Map<string, Record<string, number>> {
  const counts = new Map<string, Map<string, number>>();

  // Cross-file: count distinct source files importing each symbol
  // Discount type-only edges at 0.3x (S7)
  for (const edge of edges) {
    const targetSymbols = files[edge.to]?.symbolNames;
    if (!targetSymbols) continue;
    const targetSet = new Set(targetSymbols);
    const weight = edge.isTypeOnly ? 0.3 : 1;
    for (const name of edge.importedNames) {
      if (!targetSet.has(name)) continue;
      let m = counts.get(edge.to);
      if (!m) {
        m = new Map();
        counts.set(edge.to, m);
      }
      m.set(name, (m.get(name) || 0) + weight);
    }
  }

  // Intra-file: count callers within file (weight: 0.3)
  for (const [file, calls] of intraFileCalls) {
    let m = counts.get(file);
    if (!m) {
      m = new Map();
      counts.set(file, m);
    }
    for (const { callee } of calls) {
      m.set(callee, (m.get(callee) || 0) + 0.3);
    }
  }

  // Normalize per-file to [0, 1] using max
  const result = new Map<string, Record<string, number>>();
  for (const [file, symbolCounts] of counts) {
    const maxCount = Math.max(...symbolCounts.values(), 1);
    const normalized: Record<string, number> = {};
    for (const [sym, count] of symbolCounts) {
      normalized[sym] = Math.round((count / maxCount) * 1000) / 1000;
    }
    result.set(file, normalized);
  }
  return result;
}

/**
 * Build a PersistedGraph from an ImportGraph and ContextAnalysis.
 * This creates the serializable graph structure for persistent storage.
 */
function buildPersistedGraph(rootDir: string, graph: ImportGraph, analysis: ContextAnalysis): PersistedGraph {
  // Build lookup maps from analysis data
  const hubByPath = new Map(analysis.hubFiles.map((h) => [h.path, h]));
  const chokepointByPath = new Map((analysis.chokepoints ?? []).map((c) => [c.file, c]));
  const crossCuttingByPath = new Map((analysis.crossCuttingFiles ?? []).map((c) => [c.file, c]));

  // Compute instability for all files (not just high-instability)
  const instabilityMap = computeAllInstabilities(graph);

  // Build file -> communityId lookup
  const fileToCommunity = new Map<string, number>();
  for (const community of analysis.communities) {
    for (const file of community.files) {
      fileToCommunity.set(file, community.id);
    }
  }

  // Build test mapping lookup
  const sourceToTests = analysis.testMapping?.sourceToTests ?? new Map<string, string[]>();

  // Build files record
  const files: Record<string, FileRecord> = {};
  for (const [filePath] of graph.inDegree) {
    const hub = hubByPath.get(filePath);
    const authority = graph.authority?.get(filePath) ?? 0;
    const hubScore = graph.hubScores?.get(filePath) ?? 0;
    const isBarrel = graph.barrelFiles?.has(filePath) ?? false;
    const chokepoint = chokepointByPath.get(filePath);
    const crossCutting = crossCuttingByPath.get(filePath);
    const tests = sourceToTests.get(filePath) ?? [];

    const symbols = graph.symbolNames?.get(filePath);
    files[filePath] = {
      role: hub?.role ?? deriveRole(authority, hubScore, isBarrel),
      authority,
      hubScore,
      betweenness: graph.betweennessScores?.get(filePath) ?? 0,
      instability: instabilityMap.get(filePath) ?? null,
      importedByCount: graph.inDegree.get(filePath) ?? 0,
      isChokepoint: !!chokepoint,
      separatesComponents: chokepoint?.upstreamCount ?? 0,
      isCrossCutting: !!crossCutting,
      layerSpread: crossCutting?.layerSpread ?? 0,
      layers: crossCutting?.layers ?? [],
      hasTests: tests.length > 0,
      testFiles: tests,
      communityId: fileToCommunity.get(filePath) ?? null,
      ...(symbols && symbols.length > 0 && { symbolNames: symbols }),
    };
  }

  // Build edges (internal only, needed before symbol authority computation)
  const edges: EdgeRecord[] = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => {
      const rec: EdgeRecord = {
        from: e.from,
        to: e.to,
        importedNames: e.importedNames,
      };
      if (e.isTypeOnly) rec.isTypeOnly = true;
      if (e.isDynamic) rec.isDynamic = true;
      if (e.isBarrelRouted) rec.isBarrelRouted = true;
      return rec;
    });

  // Enrich FileRecords with symbol-level data (body tokens, start lines, authority, intra-file calls)
  const symbolAuthMap = computeSymbolAuthority(edges, files, graph.intraFileCalls ?? new Map());
  for (const filePath of Object.keys(files)) {
    const record = files[filePath];

    const bodyToks = graph.symbolBodyTokens?.get(filePath);
    if (bodyToks?.size) record.symbolBodyTokens = Object.fromEntries(bodyToks);

    const startLines = graph.symbolStartLines?.get(filePath);
    if (startLines?.size) record.symbolStartLines = Object.fromEntries(startLines);

    const symAuth = symbolAuthMap.get(filePath);
    if (symAuth && Object.keys(symAuth).length > 0) record.symbolAuthority = symAuth;

    const intraCalls = graph.intraFileCalls?.get(filePath);
    if (intraCalls?.length) record.intraFileCalls = intraCalls.map((c) => [c.caller, c.callee]);
  }

  // Build change coupling records
  const changeCoupling = (analysis.gitActivity?.changeCoupling ?? []).map((c) => ({
    fileA: c.fileA,
    fileB: c.fileB,
    confidence: c.confidence,
    coChangeCount: c.coChangeCount,
  }));

  // Build structural mismatches
  const structuralMismatches = (analysis.structuralMismatches ?? []).map((m) => ({
    fileA: m.fileA,
    fileB: m.fileB,
    graphDistance: m.graphDistance,
    coChangeConfidence: m.coChangeConfidence,
    coChangeCount: m.coChangeCount,
  }));

  // Build test mapping record (Map -> Record for JSON serialization)
  const testMapping: Record<string, string[]> = {};
  for (const [src, tests] of sourceToTests) {
    testMapping[src] = tests;
  }

  // Build lag couplings
  const lagCouplings = (analysis.gitActivity?.lagCouplings ?? []).map((l) => ({
    fileA: l.fileA,
    fileB: l.fileB,
    lagScore: l.lagScore,
  }));

  // Get head commit
  const headCommit = gitExecSafe(["rev-parse", "HEAD"], { cwd: rootDir }) ?? undefined;

  return {
    version: PERSISTED_GRAPH_VERSION,
    timestamp: new Date().toISOString(),
    headCommit,
    files,
    edges,
    communities: analysis.communities.map((c) => ({
      id: c.id,
      files: c.files,
      label: c.label,
    })),
    changeCoupling,
    structuralMismatches,
    testMapping,
    lagCouplings,
  };
}

/**
 * Persist the analysis graph to .clarte/graph.json.
 * Non-critical: callers should wrap in try/catch.
 */
export async function persistGraph(rootDir: string, graph: ImportGraph, analysis: ContextAnalysis): Promise<void> {
  const persisted = buildPersistedGraph(rootDir, graph, analysis);
  const filePath = path.join(rootDir, GRAPH_PATH);
  await writeFileSafe(filePath, JSON.stringify(persisted));
}

/**
 * Load and validate a persisted graph from .clarte/graph.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadPersistedGraph(rootDir: string): Promise<PersistedGraph | null> {
  const filePath = path.join(rootDir, GRAPH_PATH);
  const content = await readFileOr(filePath);
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as PersistedGraph;
    if (parsed.version !== PERSISTED_GRAPH_VERSION) return null;
    if (!parsed.files || !parsed.edges) return null;
    return parsed;
  } catch {
    return null;
  }
}
