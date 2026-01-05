import { isTestFile } from "../utils.js";
import type { PersistedGraph } from "./types.js";

const MAX_INTEGRATION_TESTS = 5;
const MAX_COCHANGE = 3;
const MAX_BFS_DEPTH = 10;

export function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Build reverse adjacency map (to -> from[]) from persisted edges.
 */
export function buildReverseAdjacency(graph: PersistedGraph): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const edge of graph.edges) {
    let arr = rev.get(edge.to);
    if (!arr) {
      arr = [];
      rev.set(edge.to, arr);
    }
    arr.push(edge.from);
  }
  return rev;
}

/**
 * Find test files that exercise a target file transitively through import chains.
 * Excludes tests already in the directTests set (agent finds those via glob).
 */
export function findTransitiveTests(
  reverseAdj: Map<string, string[]>,
  target: string,
  directTests: Set<string>,
): string[] {
  const results: string[] = [];
  const visited = new Set<string>([target]);
  const queue: Array<{ file: string; depth: number }> = [];

  for (const importer of reverseAdj.get(target) ?? []) {
    queue.push({ file: importer, depth: 1 });
  }

  while (queue.length > 0 && results.length < MAX_INTEGRATION_TESTS) {
    const { file, depth } = queue.shift()!;
    if (visited.has(file) || depth > MAX_BFS_DEPTH) continue;
    visited.add(file);

    if (isTestFile(file) && !directTests.has(file)) {
      results.push(file);
    }

    for (const next of reverseAdj.get(file) ?? []) {
      if (!visited.has(next)) {
        queue.push({ file: next, depth: depth + 1 });
      }
    }
  }

  return results;
}

/** Compact graph data for a single file */
export interface FileGraphData {
  role: string;
  betweenness: number;
  isChokepoint: boolean;
  separatesComponents: number;
  integrationTests: string[];
  coChange: Array<{ file: string; confidence: number }>;
}

/**
 * Gather graph-derived data for a single file.
 * Shared by hooks and cursor rules context map.
 */
export function getFileGraphData(
  graph: PersistedGraph,
  filePath: string,
  reverseAdj: Map<string, string[]>,
): FileGraphData | null {
  const file = graph.files[filePath];
  if (!file) return null;

  const directTests = new Set(file.testFiles);
  const integrationTests = findTransitiveTests(reverseAdj, filePath, directTests);

  const coChange = graph.changeCoupling
    .filter((c) => c.fileA === filePath || c.fileB === filePath)
    .map((c) => ({
      file: c.fileA === filePath ? c.fileB : c.fileA,
      confidence: c.confidence,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_COCHANGE);

  return {
    role: file.role ?? "Leaf",
    betweenness: file.betweenness,
    isChokepoint: file.isChokepoint,
    separatesComponents: file.separatesComponents,
    integrationTests,
    coChange,
  };
}
