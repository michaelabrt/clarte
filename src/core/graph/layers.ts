import type { ArchitecturalLayer, ImportGraph, LayerConsistency, LayerEdge, LayerViolation } from "../types";
import { LAYER_CONSISTENCY } from "../config/thresholds";

/** Directory patterns for classifying files into architectural layers (frontend) */
const FRONTEND_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "types", pattern: /(?:^|\/)types?\// },
  { name: "stores", pattern: /(?:^|\/)stores?\// },
  { name: "hooks", pattern: /(?:^|\/)hooks?\// },
  { name: "services", pattern: /(?:^|\/)(?:services?|api)\// },
  { name: "components", pattern: /(?:^|\/)components?\// },
  { name: "pages", pattern: /(?:^|\/)(?:pages?|app|routes?)\// },
  { name: "utils", pattern: /(?:^|\/)(?:utils?|lib|helpers?)\// },
  { name: "config", pattern: /(?:^|\/)config\// },
];

/** Directory patterns for backend projects (Express, NestJS, Django, etc.) */
const BACKEND_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "models", pattern: /(?:^|\/)models?\// },
  { name: "controllers", pattern: /(?:^|\/)controllers?\// },
  { name: "services", pattern: /(?:^|\/)services?\// },
  { name: "middleware", pattern: /(?:^|\/)middleware\// },
  { name: "routes", pattern: /(?:^|\/)routes?\// },
  { name: "repositories", pattern: /(?:^|\/)repositor(?:y|ies)\// },
  { name: "utils", pattern: /(?:^|\/)(?:utils?|lib|helpers?)\// },
  { name: "config", pattern: /(?:^|\/)config\// },
];

/** Merged frontend + backend patterns (first match wins; duplicates like utils/config are deduplicated) */
const LAYER_PATTERNS: Array<{ name: string; pattern: RegExp }> = (() => {
  const seen = new Set<string>();
  const merged: Array<{ name: string; pattern: RegExp }> = [];
  for (const p of [...FRONTEND_PATTERNS, ...BACKEND_PATTERNS]) {
    const key = `${p.name}:${p.pattern.source}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(p);
    }
  }
  return merged;
})();

/**
 * Classify files into architectural layers and determine their dependency ordering.
 * Returns both the layers and directed edges between them.
 *
 * When customLayers is provided, those patterns are matched first (before the
 * hardcoded LAYER_PATTERNS). Each entry's `pattern` string is compiled to a RegExp.
 */
export function detectArchitecturalLayers(
  graph: ImportGraph,
  customLayers?: Array<{ name: string; pattern: string }>,
): { layers: ArchitecturalLayer[]; layerEdges: LayerEdge[] } {
  const userPatterns: Array<{ name: string; pattern: RegExp }> = (customLayers ?? []).map((l) => ({
    name: l.name,
    pattern: new RegExp(l.pattern),
  }));
  const effectivePatterns = [...userPatterns, ...LAYER_PATTERNS];

  const layerFiles = new Map<string, string[]>();
  const fileToLayer = new Map<string, string>();

  for (const [filePath] of graph.centrality) {
    for (const { name, pattern } of effectivePatterns) {
      if (pattern.test(filePath)) {
        const files = layerFiles.get(name) ?? [];
        files.push(filePath);
        layerFiles.set(name, files);
        fileToLayer.set(filePath, name);
        break; // First match wins
      }
    }
  }

  // Track both directions: who imports each layer, and who each layer depends on
  const layerImportedBy = new Map<string, Set<string>>();
  const layerDependsOn = new Map<string, Set<string>>();
  for (const name of layerFiles.keys()) {
    layerImportedBy.set(name, new Set());
    layerDependsOn.set(name, new Set());
  }

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (fromLayer && toLayer && fromLayer !== toLayer) {
      layerImportedBy.get(toLayer)?.add(fromLayer);
      layerDependsOn.get(fromLayer)?.add(toLayer);
    }
  }

  const layerEdges: LayerEdge[] = [];
  const edgeSet = new Set<string>();
  for (const [from, deps] of layerDependsOn) {
    for (const to of deps) {
      const key = `${from}->${to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        layerEdges.push({ from, to });
      }
    }
  }

  const layers: ArchitecturalLayer[] = [];
  for (const [name, files] of layerFiles) {
    layers.push({
      name,
      files: [...files].sort(),
      importedByLayers: layerImportedBy.get(name)?.size ?? 0,
      dependsOn: [...(layerDependsOn.get(name) ?? [])].sort(),
    });
  }

  layers.sort((a, b) => b.importedByLayers - a.importedByLayers || a.name.localeCompare(b.name));

  return { layers, layerEdges };
}

/**
 * Build a layer dependency DAG from layer edges.
 * Edge direction: to -> from (foundational -> consumer).
 * Shared by topologicalSortLayers and fitness.ts:computeLayerOrdering.
 */
export function buildLayerDAG(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): { layerNames: Set<string>; adj: Map<string, string[]>; inDegree: Map<string, number> } {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }

  for (const edge of layerEdges) {
    if (!layerNames.has(edge.from) || !layerNames.has(edge.to)) continue;
    adj.get(edge.to)?.push(edge.from);
    inDegree.set(edge.from, (inDegree.get(edge.from) ?? 0) + 1);
  }

  return { layerNames, adj, inDegree };
}

/**
 * Topological sort of layers using Kahn's algorithm.
 * Returns layers ordered from most foundational to most consumer.
 * Falls back to input order for cycles.
 */
function topologicalSortLayers(layers: ArchitecturalLayer[], layerEdges: LayerEdge[]): string[] {
  const { layerNames, adj, inDegree: inDeg } = buildLayerDAG(layers, layerEdges);

  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }
  queue.sort(); // deterministic tie-breaking

  const sorted: string[] = [];
  let qi = 0;
  while (qi < queue.length) {
    const node = queue[qi++];
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position within the unprocessed portion (after qi) for determinism
        let insertIdx = -1;
        for (let j = qi; j < queue.length; j++) {
          if (queue[j] > neighbor) {
            insertIdx = j;
            break;
          }
        }
        if (insertIdx === -1) queue.push(neighbor);
        else queue.splice(insertIdx, 0, neighbor);
      }
    }
  }

  // If cycle exists, append remaining layers
  if (sorted.length < layerNames.size) {
    for (const name of layerNames) {
      if (!sorted.includes(name)) sorted.push(name);
    }
  }

  return sorted;
}

/**
 * Measure how well the codebase follows its own layering conventions.
 * For each detected layer pair, count edges in the "correct" direction
 * (foundational -> consumer) vs. the "wrong" direction (upward imports).
 */
export function computeLayerConsistency(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): LayerConsistency {
  if (layers.length < LAYER_CONSISTENCY.MIN_LAYERS_FOR_SCORING) return { consistency: 1, violations: [] };

  // Build topological order and rank map
  const order = topologicalSortLayers(layers, layerEdges);
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    rank.set(order[i], i);
  }

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  const violations: LayerViolation[] = [];
  let correctWeight = 0;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const fromRank = rank.get(fromLayer);
    const toRank = rank.get(toLayer);
    if (fromRank == null || toRank == null) continue;

    if (fromRank < toRank) {
      // Foundational layer importing from a consumer layer = violation
      violations.push({
        from: edge.from,
        to: edge.to,
        fromLayer,
        toLayer,
      });
    } else {
      // Weight correct edges by skip distance (same as violations).
      // In the else branch, fromRank >= toRank (consumer imports foundational).
      correctWeight += fromRank - toRank;
    }
  }

  // Weight violations by skip distance: a 3-layer-skip violation penalizes
  // 3x more than a 1-layer skip in the consistency score.
  const violationWeight = violations.reduce((sum, v) => {
    return sum + Math.abs((rank.get(v.toLayer) ?? 0) - (rank.get(v.fromLayer) ?? 0));
  }, 0);
  const total = correctWeight + violationWeight;
  const consistency = total === 0 ? 1 : correctWeight / total;

  // Sort violations by layer rank distance (most egregious first), alphabetical tiebreaker
  violations.sort((a, b) => {
    const distA = (rank.get(a.toLayer) ?? 0) - (rank.get(a.fromLayer) ?? 0);
    const distB = (rank.get(b.toLayer) ?? 0) - (rank.get(b.fromLayer) ?? 0);
    return distB - distA || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  });

  return { consistency, violations: violations.slice(0, 10) };
}
