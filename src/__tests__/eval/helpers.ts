/**
 * Helper to build a proper ImportGraph from fixture data.
 *
 * Converts fixture edges and file lists into a fully populated ImportGraph
 * with computed inDegree, centrality (HITS authority), hub scores, etc.
 */

import { computeHITS } from "../../graph.js";
import type { ImportEdge, ImportGraph } from "../../types.js";

/**
 * Create an internal (non-external) ImportEdge between two files.
 * Optionally accepts named imports and flags for type-only/dynamic imports.
 */
export function edge(
  from: string,
  to: string,
  names: string[] = [],
  isTypeOnly = false,
  isDynamic = false,
): ImportEdge {
  return {
    from,
    to,
    isExternal: false,
    specifier: `./${to}`,
    importedNames: names,
    isTypeOnly,
    isDynamic,
  };
}

/**
 * Build a fully populated ImportGraph from a list of files and edges.
 *
 * Computes inDegree from edges, then runs HITS to produce real authority
 * and hub scores. The centrality map is set to authority scores for
 * backward compatibility (matching the production buildImportGraph).
 */
export function buildGraphFromFixture(
  files: string[],
  edges: ImportEdge[],
): ImportGraph {
  // Compute inDegree
  const inDegree = new Map<string, number>();
  for (const f of files) {
    inDegree.set(f, 0);
  }
  for (const e of edges) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  // Run HITS to get real authority and hub scores
  const { authority, hub: hubScores } = computeHITS(files, edges);

  return {
    edges,
    inDegree,
    centrality: authority,
    externalImportCounts: new Map(),
    authority,
    hubScores,
  };
}

/**
 * Build a minimal ImportGraph with uniform centrality (no HITS).
 * Suitable for unit-testing graph algorithms in isolation.
 */
export function makeGraph(files: string[], edges: ImportEdge[]): ImportGraph {
  const inDegree = new Map<string, number>();
  const centrality = new Map<string, number>();
  for (const f of files) {
    inDegree.set(f, 0);
    centrality.set(f, 1 / files.length);
  }
  for (const e of edges) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }
  return {
    edges,
    inDegree,
    centrality,
    externalImportCounts: new Map(),
    authority: centrality,
    hubScores: new Map(files.map((f) => [f, 1 / files.length])),
  };
}

/**
 * Assert that all expected items appear in the actual array (order-independent).
 * Useful for cycle detection where we care about membership, not ordering.
 */
export function containsAll<T>(actual: T[], expected: T[]): boolean {
  return expected.every((item) => actual.includes(item));
}

/**
 * Check that all expected files appear within the top-N entries of a ranked list.
 * Returns the files from `expected` that are missing from the top-N.
 */
export function missingFromTopN(
  ranked: string[],
  expected: string[],
  n: number,
): string[] {
  const topN = new Set(ranked.slice(0, n));
  return expected.filter((f) => !topN.has(f));
}
