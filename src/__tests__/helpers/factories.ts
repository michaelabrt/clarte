/**
 * Shared test factories for building minimal test objects.
 * Import from here instead of copying factory functions across test files.
 */
import type { ImportEdge, ImportGraph } from "../../types.js";
import type { EdgeRecord, FileRecord, PersistedGraph } from "../../types/persisted-graph.js";

type SimpleEdge = { from: string; to: string };

/**
 * Build a minimal ImportGraph for testing.
 * Accepts either simple {from, to} pairs or full ImportEdge objects.
 * If `files` is provided, centrality/authority/hubScores are pre-populated for each file.
 */
export function makeImportGraph(edges: SimpleEdge[] | ImportEdge[] = [], files?: string[]): ImportGraph {
  const edgeObjs: ImportEdge[] = edges.map((e) =>
    "isExternal" in e
      ? (e as ImportEdge)
      : { from: e.from, to: e.to, isExternal: false, specifier: `./${e.to}`, importedNames: [] },
  );

  const inDegree = new Map<string, number>();
  for (const e of edgeObjs) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  const centrality = new Map<string, number>();
  const authority = new Map<string, number>();
  const hubScores = new Map<string, number>();

  if (files) {
    for (const f of files) {
      if (!inDegree.has(f)) inDegree.set(f, 0);
      centrality.set(f, 0.5);
      authority.set(f, 0.5);
      hubScores.set(f, 0.5);
    }
  }

  return {
    edges: edgeObjs,
    inDegree,
    centrality,
    externalImportCounts: new Map(),
    authority,
    hubScores,
  };
}

/**
 * Build a minimal PersistedGraph for testing.
 */
export function makePersistedGraph(overrides: Partial<PersistedGraph> = {}): PersistedGraph {
  return {
    version: 1,
    timestamp: new Date().toISOString(),
    files: {},
    edges: [],
    communities: [],
    changeCoupling: [],
    structuralMismatches: [],
    testMapping: {},
    lagCouplings: [],
    ...overrides,
  };
}

/**
 * Build a minimal FileRecord for testing.
 */
export function makeFileRecord(overrides: Partial<FileRecord> = {}): FileRecord {
  return {
    role: "Leaf",
    authority: 0,
    hubScore: 0,
    betweenness: 0,
    instability: null,
    importedByCount: 0,
    isChokepoint: false,
    separatesComponents: 0,
    isCrossCutting: false,
    layerSpread: 0,
    layers: [],
    hasTests: false,
    testFiles: [],
    communityId: null,
    ...overrides,
  };
}

/**
 * Build a minimal EdgeRecord for testing.
 */
export function makeEdgeRecord(from: string, to: string): EdgeRecord {
  return { from, to, importedNames: [] };
}
