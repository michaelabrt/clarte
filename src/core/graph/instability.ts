import type { FileInstability, ImportGraph } from "../types";
import { INSTABILITY_TYPE_ONLY_WEIGHT, INSTABILITY_THRESHOLD } from "../config/thresholds";

function computeFanMaps(graph: ImportGraph): { fanOutMap: Map<string, number>; fanInMap: Map<string, number> } {
  const fanOutMap = new Map<string, number>();
  const fanInMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? INSTABILITY_TYPE_ONLY_WEIGHT : 1;
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + weight);
      fanInMap.set(edge.to, (fanInMap.get(edge.to) ?? 0) + weight);
    }
  }
  return { fanOutMap, fanInMap };
}

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > INSTABILITY_THRESHOLD and fanIn >= 1 (high-risk zones).
 */
export function computeInstability(graph: ImportGraph): FileInstability[] {
  const { fanOutMap, fanInMap } = computeFanMaps(graph);

  // Collect all files from both inDegree and fanOutMap to catch pure orchestrators
  // (files with outgoing edges but zero incoming edges)
  const allFiles = new Set([...graph.inDegree.keys(), ...fanOutMap.keys()]);

  const results: FileInstability[] = [];
  for (const filePath of allFiles) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const fanIn = fanInMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    const instability = fanOut / total;
    if (instability > INSTABILITY_THRESHOLD && fanIn >= 1) {
      // fanIn/fanOut are rounded for display; instability uses raw weighted values.
      // Type-only edges contribute INSTABILITY_TYPE_ONLY_WEIGHT (0.3) instead of 1.
      results.push({ path: filePath, fanIn: Math.round(fanIn), fanOut: Math.round(fanOut), instability });
    }
  }

  // Sort by instability descending, alphabetical tiebreaker
  results.sort((a, b) => b.instability - a.instability || a.path.localeCompare(b.path));
  return results;
}

/**
 * Compute instability for ALL files in the graph (not just high-instability).
 * Returns a Map of filePath -> instability score (0-1).
 * Files with zero total connections are omitted.
 */
export function computeAllInstabilities(graph: ImportGraph): Map<string, number> {
  const { fanOutMap, fanInMap } = computeFanMaps(graph);

  const allFiles = new Set([...graph.inDegree.keys(), ...fanOutMap.keys()]);
  const result = new Map<string, number>();
  for (const filePath of allFiles) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const fanIn = fanInMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    result.set(filePath, fanOut / total);
  }
  return result;
}
