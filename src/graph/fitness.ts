import type {
  ArchitecturalLayer,
  ArchViolation,
  ImportGraph,
  LayerEdge,
} from "../types.js";

/** Layer consistency parameters used by fitness checks */
const LAYER_CONSISTENCY = {
  /** Minimum layers for layer consistency scoring */
  MIN_LAYERS_FOR_SCORING: 2,
  /** Minimum layer skip distance to count as a violation */
  MIN_SKIP_DISTANCE: 2,
} as const;

/**
 * Derive a topological ordering of layers from layer dependency edges.
 * Returns a map of layer name to its depth (0 = lowest/most foundational).
 * Uses Kahn's algorithm; layers in cycles get the same depth.
 */
function computeLayerOrdering(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): Map<string, number> {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: {from: "components", to: "types"} means components depends on types.
  // For topological ordering: types is more foundational (lower).
  // Build graph: to -> from (foundational -> consumer) for topo sort.
  for (const e of layerEdges) {
    if (!layerNames.has(e.from) || !layerNames.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
    inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const ordering = new Map<string, number>();
  let depth = 0;

  while (queue.length > 0) {
    const nextQueue: string[] = [];
    for (const node of queue) {
      ordering.set(node, depth);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          nextQueue.push(neighbor);
        }
      }
    }
    queue.length = 0;
    queue.push(...nextQueue);
    depth++;
  }

  // Assign remaining (cycle members) to the max depth
  for (const name of layerNames) {
    if (!ordering.has(name)) {
      ordering.set(name, depth);
    }
  }

  return ordering;
}

/**
 * Check architectural fitness rules against the import graph.
 *
 * Rules:
 * 1. No upward dependencies: lower layers should not import higher layers
 * 2. Test isolation: test files should not import other test files
 *    (except fixtures/test-utils)
 * 3. Layer skip detection: imports skipping 2+ intermediate layers
 *
 * Returns at most 20 violations to avoid noise.
 */
export function checkArchitecturalFitness(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const MAX_VIOLATIONS = 20;

  // Build file-to-layer mapping
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // Compute layer ordering (depth: 0 = most foundational)
  const hasLayers = layers.length >= LAYER_CONSISTENCY.MIN_LAYERS_FOR_SCORING;
  const layerOrder = hasLayers ? computeLayerOrdering(layers, layerEdges) : new Map<string, number>();

  // Test file patterns
  const testFilePattern = /(?:\.test\.|\.spec\.|__tests__\/|tests?\/)/;
  const testUtilPattern = /(?:__fixtures__|test[-_]?utils?|test[-_]?helpers?|test[-_]?setup|fixtures)/;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (violations.length >= MAX_VIOLATIONS) break;

    // Rule 1 and 3 only apply when we have 2+ layers
    if (hasLayers) {
      const fromLayer = fileToLayer.get(edge.from);
      const toLayer = fileToLayer.get(edge.to);

      if (fromLayer && toLayer && fromLayer !== toLayer) {
        const fromDepth = layerOrder.get(fromLayer) ?? 0;
        const toDepth = layerOrder.get(toLayer) ?? 0;

        // Rule 1: No upward dependencies
        // If fromLayer is lower (more foundational) than toLayer, it's an upward dep
        if (fromDepth < toDepth) {
          violations.push({
            from: edge.from,
            to: edge.to,
            rule: "no-upward-dep",
            message: `\`${edge.from}\` (${fromLayer} layer) should not import from \`${edge.to}\` (${toLayer} layer). Extract shared logic to a lower layer.`,
            severity: "warning",
          });
          if (violations.length >= MAX_VIOLATIONS) break;
        }

        // Rule 3: Layer skip detection
        const skipDistance = Math.abs(toDepth - fromDepth);
        if (skipDistance >= LAYER_CONSISTENCY.MIN_SKIP_DISTANCE) {
          // Only flag when going from higher to lower (normal direction but skipping)
          // i.e., fromDepth > toDepth means consumer importing foundational, but skipping
          if (fromDepth > toDepth) {
            violations.push({
              from: edge.from,
              to: edge.to,
              rule: "layer-skip",
              message: `\`${edge.from}\` imports directly from \`${edge.to}\`, skipping ${skipDistance - 1} intermediate layer${skipDistance - 1 === 1 ? "" : "s"}. Consider adding an abstraction in an intermediate layer.`,
              severity: "warning",
            });
            if (violations.length >= MAX_VIOLATIONS) break;
          }
        }
      }
    }

    // Rule 2: Test isolation (works regardless of layer count)
    const fromIsTest = testFilePattern.test(edge.from);
    const toIsTest = testFilePattern.test(edge.to);

    if (fromIsTest && toIsTest) {
      // Allow imports from fixtures/test-utils
      const toIsUtility = testUtilPattern.test(edge.to);
      if (!toIsUtility) {
        violations.push({
          from: edge.from,
          to: edge.to,
          rule: "test-isolation",
          message: `\`${edge.from}\` imports another test file \`${edge.to}\`. Extract shared setup to a test utility.`,
          severity: "warning",
        });
        if (violations.length >= MAX_VIOLATIONS) break;
      }
    }
  }

  return violations.slice(0, MAX_VIOLATIONS);
}
