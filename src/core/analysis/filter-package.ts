import type { ContextAnalysis, ImportGraph, ImportEdge } from "../types.js";

/**
 * Filter a root-level ContextAnalysis to contain only data relevant to a single package.
 * Paths are filtered by `packagePath + "/"` prefix and then stripped so they're relative
 * to the package root.
 */
export function filterAnalysisForPackage(analysis: ContextAnalysis, packagePath: string): ContextAnalysis {
  const prefix = packagePath.endsWith("/") ? packagePath : `${packagePath}/`;
  const has = (p: string) => p.startsWith(prefix);
  const strip = (p: string) => p.slice(prefix.length);

  const hubFiles = analysis.hubFiles.filter((h) => has(h.path)).map((h) => ({ ...h, path: strip(h.path) }));

  const circularDeps = analysis.circularDeps
    .filter((cd) => cd.chain.every((f) => has(f)))
    .map((cd) => ({
      ...cd,
      chain: cd.chain.map(strip),
    }));

  const layers = analysis.layers
    .map((l) => ({
      ...l,
      files: l.files.filter(has).map(strip),
    }))
    .filter((l) => l.files.length > 0);

  const instabilities = analysis.instabilities.filter((i) => has(i.path)).map((i) => ({ ...i, path: strip(i.path) }));

  const communities = analysis.communities
    .map((c) => ({
      ...c,
      files: c.files.filter(has).map(strip),
    }))
    .filter((c) => c.files.length > 0);

  const deadFiles = analysis.deadFiles?.filter(has).map(strip);

  const crossCuttingFiles = analysis.crossCuttingFiles
    ?.filter((c) => has(c.file))
    .map((c) => ({ ...c, file: strip(c.file) }));

  const layerConsistency = analysis.layerConsistency
    ? {
        ...analysis.layerConsistency,
        violations: analysis.layerConsistency.violations
          .filter((v) => has(v.from) && has(v.to))
          .map((v) => ({ ...v, from: strip(v.from), to: strip(v.to) })),
      }
    : undefined;

  const chokepoints = analysis.chokepoints
    ?.filter((c) => has(c.file))
    .map((c) => ({
      ...c,
      file: strip(c.file),
      dependents: c.dependents?.filter(has).map(strip),
    }));

  const structuralMismatches = analysis.structuralMismatches
    ?.filter((m) => has(m.fileA) && has(m.fileB))
    .map((m) => ({ ...m, fileA: strip(m.fileA), fileB: strip(m.fileB) }));

  const tightCouplings = analysis.tightCouplings
    ?.filter((t) => has(t.from) && has(t.to))
    .map((t) => ({ ...t, from: strip(t.from), to: strip(t.to) }));

  const archViolations = analysis.archViolations
    ?.filter((v) => has(v.from) && has(v.to))
    .map((v) => ({ ...v, from: strip(v.from), to: strip(v.to) }));

  const testMapping = analysis.testMapping
    ? {
        sourceToTests: filterStripMap(analysis.testMapping.sourceToTests, prefix, (vals) =>
          vals.filter(has).map(strip),
        ),
        untestedFiles: analysis.testMapping.untestedFiles.filter(has).map(strip),
        testPattern: analysis.testMapping.testPattern,
        testTypes: analysis.testMapping.testTypes
          ? filterStripKeyMap(analysis.testMapping.testTypes, prefix)
          : undefined,
        exemplarTestFile:
          analysis.testMapping.exemplarTestFile && has(analysis.testMapping.exemplarTestFile)
            ? strip(analysis.testMapping.exemplarTestFile)
            : undefined,
      }
    : undefined;

  const gitActivity = analysis.gitActivity
    ? {
        commitCounts: filterStripKeyMap(analysis.gitActivity.commitCounts, prefix),
        hotFiles: analysis.gitActivity.hotFiles.filter((h) => has(h.path)).map((h) => ({ ...h, path: strip(h.path) })),
        changeCoupling: analysis.gitActivity.changeCoupling
          .filter((c) => has(c.fileA) && has(c.fileB))
          .map((c) => ({ ...c, fileA: strip(c.fileA), fileB: strip(c.fileB) })),
        lagCouplings: analysis.gitActivity.lagCouplings
          ?.filter((l) => has(l.fileA) && has(l.fileB))
          .map((l) => ({ ...l, fileA: strip(l.fileA), fileB: strip(l.fileB) })),
        fileChurn: analysis.gitActivity.fileChurn
          ? filterStripKeyMap(analysis.gitActivity.fileChurn, prefix)
          : undefined,
      }
    : null;

  const changeImpact = analysis.changeImpact
    ? filterStripMap(analysis.changeImpact, prefix, (vals) =>
        vals.filter((v) => has(v.file)).map((v) => ({ ...v, file: strip(v.file) })),
      )
    : undefined;

  return {
    hubFiles,
    circularDeps,
    layers,
    layerEdges: analysis.layerEdges,
    gitActivity,
    instabilities,
    communities,
    deadFiles,
    crossCuttingFiles,
    layerConsistency,
    chokepoints,
    structuralMismatches,
    tightCouplings,
    archViolations,
    testMapping,
    changeImpact,
    analysisDays: analysis.analysisDays,
    // Root-only fields: not relevant for a single package
    configConstraints: undefined,
    conventions: undefined,
    graphTopology: undefined,
    monorepoAnalysis: undefined,
  };
}

/**
 * Filter an ImportGraph to contain only edges and data within a single package.
 * Both endpoints of each edge must be in the package. Paths are prefix-stripped.
 */
export function filterGraphForPackage(graph: ImportGraph, packagePath: string): ImportGraph {
  const prefix = packagePath.endsWith("/") ? packagePath : `${packagePath}/`;
  const has = (p: string) => p.startsWith(prefix);
  const strip = (p: string) => p.slice(prefix.length);

  const edges: ImportEdge[] = graph.edges
    .filter((e) => !e.isExternal && has(e.from) && has(e.to))
    .map((e) => ({ ...e, from: strip(e.from), to: strip(e.to) }));

  return {
    edges,
    inDegree: filterStripKeyMap(graph.inDegree, prefix),
    directInDegree: graph.directInDegree ? filterStripKeyMap(graph.directInDegree, prefix) : undefined,
    centrality: filterStripKeyMap(graph.centrality, prefix),
    externalImportCounts: new Map(graph.externalImportCounts),
    authority: filterStripKeyMap(graph.authority, prefix),
    hubScores: filterStripKeyMap(graph.hubScores, prefix),
    barrelFiles: graph.barrelFiles ? new Set([...graph.barrelFiles].filter(has).map(strip)) : undefined,
    betweennessScores: graph.betweennessScores ? filterStripKeyMap(graph.betweennessScores, prefix) : undefined,
  };
}

// ── Helpers ──────────────────────────────────────────────────────────

/** Filter a Map by key prefix and strip the prefix from matching keys. */
function filterStripKeyMap<V>(map: Map<string, V>, prefix: string): Map<string, V> {
  const result = new Map<string, V>();
  for (const [k, v] of map) {
    if (k.startsWith(prefix)) {
      result.set(k.slice(prefix.length), v);
    }
  }
  return result;
}

/** Filter a Map by key prefix, strip prefix, and transform values. */
function filterStripMap<V>(map: Map<string, V>, prefix: string, transformValue: (v: V) => V): Map<string, V> {
  const result = new Map<string, V>();
  for (const [k, v] of map) {
    if (k.startsWith(prefix)) {
      result.set(k.slice(prefix.length), transformValue(v));
    }
  }
  return result;
}
