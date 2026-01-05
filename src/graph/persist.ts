import { execSync } from "node:child_process";
import path from "node:path";
import { readFileOr, writeFileSafe } from "../utils.js";
import { deriveRole } from "./centrality.js";
import { computeAllInstabilities } from "./instability.js";
import type { ContextAnalysis, ImportGraph } from "../types.js";
import { PERSISTED_GRAPH_VERSION, type EdgeRecord, type FileRecord, type PersistedGraph } from "./types.js";

const GRAPH_PATH = ".clarte/graph.json";
const STALE_HOURS = 24;

/**
 * Build a PersistedGraph from an ImportGraph and ContextAnalysis.
 * This creates the serializable graph structure consumed by MCP tools.
 */
export function buildPersistedGraph(graph: ImportGraph, analysis: ContextAnalysis): PersistedGraph {
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

    files[filePath] = {
      role: hub?.role ?? deriveRole(authority, hubScore, isBarrel),
      authority,
      hubScore,
      betweenness: graph.betweennessScores?.get(filePath) ?? 0,
      instability: instabilityMap.get(filePath) ?? null,
      importedByCount: graph.inDegree.get(filePath) ?? 0,
      isChokepoint: !!chokepoint,
      separatesComponents: chokepoint?.separates ?? 0,
      isCrossCutting: !!crossCutting,
      layerSpread: crossCutting?.layerSpread ?? 0,
      layers: crossCutting?.layers ?? [],
      hasTests: tests.length > 0,
      testFiles: tests,
      communityId: fileToCommunity.get(filePath) ?? null,
    };
  }

  // Build edges (internal only)
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
  let headCommit: string | undefined;
  try {
    headCommit = execSync("git rev-parse HEAD", { encoding: "utf-8" }).trim();
  } catch {
    // Not in a git repo or git not available
  }

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
  const persisted = buildPersistedGraph(graph, analysis);
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

export interface StalenessResult {
  isStale: boolean;
  reason?: string;
  ageHours: number;
}

/**
 * Check whether a persisted graph is stale.
 * Stale if >24h old OR headCommit differs from current.
 */
export function checkStaleness(persisted: PersistedGraph, currentHead?: string): StalenessResult {
  const ageMs = Date.now() - new Date(persisted.timestamp).getTime();
  const ageHours = Math.round(ageMs / (1000 * 60 * 60));

  if (ageHours > STALE_HOURS) {
    return { isStale: true, reason: `analysis from ${ageHours}h ago`, ageHours };
  }

  if (currentHead && persisted.headCommit && persisted.headCommit !== currentHead) {
    return { isStale: true, reason: `analysis from ${ageHours}h ago (different commit)`, ageHours };
  }

  return { isStale: false, ageHours };
}
