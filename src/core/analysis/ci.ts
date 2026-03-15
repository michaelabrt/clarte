import type { ContextAnalysis, CrossCuttingFile, ImportGraph, Chokepoint, TightCoupling } from "../types.js";

// ── Types ────────────────────────────────────────────────────────────

export interface MissingCoChange {
  changed: string;
  missing: string;
  confidence: number;
  coChangeCount: number;
  isHiddenCoupling: boolean;
}

export interface ChokepointAlert {
  file: string;
  separates: number;
  importedBy: number;
}

export interface CrossCuttingAlert {
  file: string;
  layerSpread: number;
  layers: string[];
  totalImporters: number;
}

export interface FlowBottleneckAlert {
  file: string;
  betweenness: number;
  importedBy: number;
}

export interface TightCouplingAlert {
  from: string;
  to: string;
  importedNames: number;
}

export interface CIAnalysisResult {
  version: 2;
  timestamp: string;
  filesAnalyzed: number;
  missingCoChanges: MissingCoChange[];
  chokepoints: ChokepointAlert[];
  crossCutting: CrossCuttingAlert[];
  flowBottlenecks: FlowBottleneckAlert[];
  tightCouplings: TightCouplingAlert[];
  hasFindings: boolean;
}

// ── Collectors ───────────────────────────────────────────────────────

function collectMissingCoChanges(
  changedFilesSet: Set<string>,
  analysis: ContextAnalysis,
  edgeSet: Set<string>,
): MissingCoChange[] {
  const seen = new Set<string>();
  const results: MissingCoChange[] = [];

  for (const changed of changedFilesSet) {
    // Change coupling from git analysis
    if (analysis.gitActivity) {
      for (const coupling of analysis.gitActivity.changeCoupling) {
        const partner =
          coupling.fileA === changed ? coupling.fileB : coupling.fileB === changed ? coupling.fileA : null;
        if (!partner || changedFilesSet.has(partner)) continue;

        const key = `${changed}:${partner}`;
        if (seen.has(key)) continue;
        seen.add(key);

        const hasImportEdge = edgeSet.has(`${changed}->${partner}`) || edgeSet.has(`${partner}->${changed}`);

        results.push({
          changed,
          missing: partner,
          confidence: coupling.confidence,
          coChangeCount: coupling.coChangeCount,
          isHiddenCoupling: !hasImportEdge,
        });
      }
    }

    // Structural-temporal mismatches (always hidden coupling)
    if (analysis.structuralMismatches) {
      for (const m of analysis.structuralMismatches) {
        const partner = m.fileA === changed ? m.fileB : m.fileB === changed ? m.fileA : null;
        if (!partner || changedFilesSet.has(partner)) continue;

        const key = `${changed}:${partner}`;
        if (seen.has(key)) continue;
        seen.add(key);

        results.push({
          changed,
          missing: partner,
          confidence: m.coChangeConfidence,
          coChangeCount: m.coChangeCount,
          isHiddenCoupling: true,
        });
      }
    }
  }

  // Sort: hidden first, then by confidence desc
  results.sort((a, b) => {
    if (a.isHiddenCoupling !== b.isHiddenCoupling) return a.isHiddenCoupling ? -1 : 1;
    return b.confidence - a.confidence;
  });

  return results;
}

function collectChokepoints(changedFilesSet: Set<string>, chokepointMap: Map<string, Chokepoint>): ChokepointAlert[] {
  const results: ChokepointAlert[] = [];
  for (const file of changedFilesSet) {
    const cp = chokepointMap.get(file);
    if (cp) {
      results.push({ file: cp.file, separates: cp.upstreamCount, importedBy: cp.importedBy });
    }
  }
  return results;
}

function collectCrossCutting(
  changedFilesSet: Set<string>,
  crossCuttingMap: Map<string, CrossCuttingFile>,
): CrossCuttingAlert[] {
  const results: CrossCuttingAlert[] = [];
  for (const file of changedFilesSet) {
    const cc = crossCuttingMap.get(file);
    if (cc) {
      results.push({
        file: cc.file,
        layerSpread: cc.layerSpread,
        layers: cc.layers,
        totalImporters: cc.totalImporters,
      });
    }
  }
  return results;
}

function collectFlowBottlenecks(changedFilesSet: Set<string>, graph: ImportGraph): FlowBottleneckAlert[] {
  const results: FlowBottleneckAlert[] = [];
  if (!graph.betweennessScores) return results;

  for (const file of changedFilesSet) {
    const betweenness = graph.betweennessScores.get(file);
    if (betweenness !== undefined && betweenness > 0.1) {
      results.push({
        file,
        betweenness,
        importedBy: graph.inDegree.get(file) ?? 0,
      });
    }
  }
  return results;
}

function collectTightCouplings(
  changedFilesSet: Set<string>,
  tightCouplings: TightCoupling[] | undefined,
): TightCouplingAlert[] {
  if (!tightCouplings) return [];

  const results: TightCouplingAlert[] = [];
  for (const tc of tightCouplings) {
    if (changedFilesSet.has(tc.from) || changedFilesSet.has(tc.to)) {
      results.push({ from: tc.from, to: tc.to, importedNames: tc.importedNames });
    }
  }
  return results;
}

// ── Public API ──────────────────────────────────────────────────────

export function analyzeForCI(
  _rootDir: string,
  changedFiles: string[],
  analysis: ContextAnalysis,
  graph: ImportGraph,
): CIAnalysisResult {
  const changedFilesSet = new Set(changedFiles);

  // Pre-compute lookup maps
  const chokepointMap = new Map((analysis.chokepoints ?? []).map((c) => [c.file, c]));
  const crossCuttingMap = new Map((analysis.crossCuttingFiles ?? []).map((c) => [c.file, c]));
  const edgeSet = new Set(graph.edges.map((e) => `${e.from}->${e.to}`));

  // Collect all signals
  const missingCoChanges = collectMissingCoChanges(changedFilesSet, analysis, edgeSet);
  const chokepoints = collectChokepoints(changedFilesSet, chokepointMap);
  const crossCutting = collectCrossCutting(changedFilesSet, crossCuttingMap);
  const flowBottlenecks = collectFlowBottlenecks(changedFilesSet, graph);
  const tightCouplings = collectTightCouplings(changedFilesSet, analysis.tightCouplings);

  const hasFindings =
    missingCoChanges.length > 0 ||
    chokepoints.length > 0 ||
    crossCutting.length > 0 ||
    flowBottlenecks.length > 0 ||
    tightCouplings.length > 0;

  return {
    version: 2,
    timestamp: new Date().toISOString(),
    filesAnalyzed: changedFiles.length,
    missingCoChanges,
    chokepoints,
    crossCutting,
    flowBottlenecks,
    tightCouplings,
    hasFindings,
  };
}
