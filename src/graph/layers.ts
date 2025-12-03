import type {
  ArchitecturalLayer,
  ImportGraph,
  LayerConsistency,
  LayerEdge,
  LayerViolation,
} from "../types.js";

/** Layer consistency parameters */
const LAYER_CONSISTENCY = {
  /** Minimum layers for layer consistency scoring */
  MIN_LAYERS_FOR_SCORING: 2,
} as const;

/** Directory patterns for classifying files into architectural layers */
const LAYER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "types", pattern: /(?:^|\/)types?\// },
  { name: "stores", pattern: /(?:^|\/)stores?\// },
  { name: "hooks", pattern: /(?:^|\/)hooks?\// },
  { name: "services", pattern: /(?:^|\/)(?:services?|api)\// },
  { name: "components", pattern: /(?:^|\/)components?\// },
  { name: "pages", pattern: /(?:^|\/)(?:pages?|app|routes?)\// },
  { name: "utils", pattern: /(?:^|\/)(?:utils?|lib|helpers?)\// },
  { name: "config", pattern: /(?:^|\/)config\// },
];

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
  // Build the effective pattern list: user patterns first, then built-in defaults
  const userPatterns: Array<{ name: string; pattern: RegExp }> = (customLayers ?? []).map((l) => ({
    name: l.name,
    pattern: new RegExp(l.pattern),
  }));
  const effectivePatterns = [...userPatterns, ...LAYER_PATTERNS];

  // Classify each internal file into a layer
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

  // Build layer edges from dependsOn data
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

  // Build result sorted by importedByLayers descending (most foundational first)
  const layers: ArchitecturalLayer[] = [];
  for (const [name, files] of layerFiles) {
    layers.push({
      name,
      files: [...files].sort(),
      importedByLayers: layerImportedBy.get(name)?.size ?? 0,
      dependsOn: [...(layerDependsOn.get(name) ?? [])].sort(),
    });
  }

  // Sort: most imported layers first (foundational), then by name
  layers.sort((a, b) => b.importedByLayers - a.importedByLayers || a.name.localeCompare(b.name));

  return { layers, layerEdges };
}

/**
 * Topological sort of layers using Kahn's algorithm.
 * Returns layers ordered from most foundational to most consumer.
 * Falls back to input order for cycles.
 */
function topologicalSortLayers(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): string[] {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDeg.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: from depends on to (from imports to)
  // For topological order: to is more foundational, from is more consumer
  // Edge direction for topo sort: to -> from (foundational -> consumer)
  for (const edge of layerEdges) {
    if (!layerNames.has(edge.from) || !layerNames.has(edge.to)) continue;
    adj.get(edge.to)!.push(edge.from);
    inDeg.set(edge.from, (inDeg.get(edge.from) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }
  queue.sort(); // deterministic tie-breaking

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position for determinism
        const insertIdx = queue.findIndex((q) => q > neighbor);
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
  let correctCount = 0;

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
      correctCount++;
    }
  }

  const total = correctCount + violations.length;
  const consistency = total === 0 ? 1 : correctCount / total;

  // Sort violations by layer rank distance (most egregious first), alphabetical tiebreaker
  violations.sort((a, b) => {
    const distA = (rank.get(a.toLayer) ?? 0) - (rank.get(a.fromLayer) ?? 0);
    const distB = (rank.get(b.toLayer) ?? 0) - (rank.get(b.fromLayer) ?? 0);
    return distB - distA || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  });

  return { consistency, violations: violations.slice(0, 10) };
}
