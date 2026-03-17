/**
 * Task-scoped HITS: subgraph extraction + HITS re-ranking
 * for task-relevant files.
 *
 * Given a set of seed files (BM25F + semantic retrieval results), extract
 * a 2-hop neighborhood subgraph and run HITS on it. This produces
 * task-specific authority/hub scores that may differ from global scores.
 *
 * Files with zero edges in the task subgraph are forced to "Leaf"
 * instead of getting a misleading role from the flat-graph guard (0.5/0.5).
 */

import type { InMemoryFileGraph, InMemoryEdge } from "../../storage/types";
import type { ImportEdge } from "../types";
import { computeHITS, deriveRole } from "./centrality";
import type { FileRole } from "../types";

// ── Types ────────────────────────────────────────────────────────────────────

export interface TaskScopedResult {
  /** Task-scoped authority per file */
  authority: Map<string, number>;
  /** Task-scoped hub scores per file */
  hub: Map<string, number>;
  /** Task-scoped role derivation per file */
  roles: Map<string, FileRole>;
  /** Files included in the subgraph */
  subgraphFiles: Set<string>;
}

// ── Subgraph extraction ──────────────────────────────────────────────────────

/**
 * BFS outward from seed files, collecting a 2-hop neighborhood.
 * Includes both importers (reverse edges) and dependencies (forward edges).
 */
export function extractTaskSubgraph(seeds: string[], fileGraph: InMemoryFileGraph, maxHops = 2): Set<string> {
  const subgraphFiles = new Set(seeds);
  let frontier = new Set(seeds);

  for (let hop = 0; hop < maxHops; hop++) {
    const nextFrontier = new Set<string>();
    for (const file of frontier) {
      // Forward edges (dependencies)
      for (const edge of fileGraph.forward.get(file) ?? []) {
        if (!subgraphFiles.has(edge.toPath)) {
          subgraphFiles.add(edge.toPath);
          nextFrontier.add(edge.toPath);
        }
      }
      // Reverse edges (importers)
      for (const edge of fileGraph.reverse.get(file) ?? []) {
        if (!subgraphFiles.has(edge.fromPath)) {
          subgraphFiles.add(edge.fromPath);
          nextFrontier.add(edge.fromPath);
        }
      }
    }
    frontier = nextFrontier;
  }

  return subgraphFiles;
}

/**
 * Filter an InMemoryFileGraph to only edges between files in the given set.
 * Converts to ImportEdge[] for use with computeHITS.
 * Also returns the set of files that have at least one edge in the subgraph.
 */
function filterEdges(
  fileGraph: InMemoryFileGraph,
  files: Set<string>,
): { edges: ImportEdge[]; connected: Set<string> } {
  const edges: ImportEdge[] = [];
  const connected = new Set<string>();
  for (const edgeList of fileGraph.forward.values()) {
    for (const e of edgeList) {
      if (files.has(e.fromPath) && files.has(e.toPath)) {
        edges.push(inMemoryEdgeToImportEdge(e));
        connected.add(e.fromPath);
        connected.add(e.toPath);
      }
    }
  }
  return { edges, connected };
}

function inMemoryEdgeToImportEdge(e: InMemoryEdge): ImportEdge {
  return {
    from: e.fromPath,
    to: e.toPath,
    isExternal: false,
    specifier: e.toPath,
    importedNames: e.importedNames,
    isTypeOnly: e.isTypeOnly,
    isDynamic: e.isDynamic,
    isBarrelRouted: e.isBarrelRouted,
    crossPackage: e.crossPackage,
  };
}

// ── Task-scoped HITS ─────────────────────────────────────────────────────────

/**
 * Compute task-scoped HITS on a subgraph extracted from seed files.
 *
 * 1. BFS 2-hop from seeds to build the subgraph
 * 2. Filter edges to only those within the subgraph
 * 3. Run HITS on the subgraph
 * 4. Derive task-scoped roles (isolated nodes forced to "Leaf")
 */
export function computeTaskScopedHITS(seeds: string[], fileGraph: InMemoryFileGraph, maxHops = 2): TaskScopedResult {
  const subgraphFiles = extractTaskSubgraph(seeds, fileGraph, maxHops);
  const files = [...subgraphFiles];
  const { edges, connected } = filterEdges(fileGraph, subgraphFiles);

  // Identify barrels in the subgraph
  const barrelFiles = new Set<string>();
  for (const file of files) {
    const node = fileGraph.nodes.get(file);
    if (node?.isBarrel) barrelFiles.add(file);
  }

  const { authority, hub } = computeHITS(files, edges, 30, 1e-6, barrelFiles);

  // Derive task-scoped roles
  // Files with zero edges in the subgraph are forced to "Leaf".
  // Without this, the flat-graph guard in computeHITS assigns them 0.5/0.5,
  // which deriveRole would interpret as "Bridge" or "Utility".
  const roles = new Map<string, FileRole>();
  for (const file of files) {
    if (!connected.has(file)) {
      roles.set(file, "Leaf");
      continue;
    }
    const auth = authority.get(file) ?? 0;
    const hubScore = hub.get(file) ?? 0;
    const isBarrel = barrelFiles.has(file);
    roles.set(file, deriveRole(auth, hubScore, isBarrel));
  }

  return { authority, hub, roles, subgraphFiles };
}
