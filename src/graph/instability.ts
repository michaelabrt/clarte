import type { FileInstability, ImportGraph } from "../types.js";

/** Instability metric parameters */
const INSTABILITY = {
  /** Type-only imports carry less coupling risk (erased at runtime) */
  TYPE_ONLY_WEIGHT: 0.3,
} as const;

/** Threshold above which a file is considered high-instability */
export const INSTABILITY_THRESHOLD = 0.8;

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > INSTABILITY_THRESHOLD and fanIn >= 1 (high-risk zones).
 */
export function computeInstability(graph: ImportGraph): FileInstability[] {
  const TYPE_ONLY_WEIGHT = INSTABILITY.TYPE_ONLY_WEIGHT;

  // Count weighted outgoing internal edges per file
  const fanOutMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + weight);
    }
  }

  // Count weighted incoming internal edges per file
  const fanInMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanInMap.set(edge.to, (fanInMap.get(edge.to) ?? 0) + weight);
    }
  }

  const results: FileInstability[] = [];
  for (const [filePath] of graph.inDegree) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const fanIn = fanInMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    const instability = fanOut / total;
    if (instability > INSTABILITY_THRESHOLD && fanIn >= 1) {
      results.push({ path: filePath, fanIn: Math.round(fanIn), fanOut: Math.round(fanOut), instability });
    }
  }

  // Sort by instability descending, alphabetical tiebreaker
  results.sort((a, b) => b.instability - a.instability || a.path.localeCompare(b.path));
  return results;
}
