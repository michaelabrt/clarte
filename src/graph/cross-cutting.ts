import type { ArchitecturalLayer, CrossCuttingFile, ImportGraph } from "../types.js";

/**
 * Find files imported across multiple architectural layers.
 * A file imported by 10 files all in `components/` is local.
 * A file imported across `components/`, `services/`, `hooks/`, and `pages/`
 * is a cross-cutting concern where changes ripple across boundaries.
 */
export function findCrossCuttingFiles(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  minLayerSpread = 3,
): CrossCuttingFile[] {
  if (layers.length < minLayerSpread) return [];

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // For each target file, collect which layers import it
  const importerLayers = new Map<string, Set<string>>();
  const importerCounts = new Map<string, number>();

  const barrels = graph.barrelFiles ?? new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    // Skip barrel files' own re-export edges (not genuine cross-layer usage)
    if (barrels.has(edge.from)) continue;
    const fromLayer = fileToLayer.get(edge.from);
    if (!fromLayer) continue;

    if (!importerLayers.has(edge.to)) importerLayers.set(edge.to, new Set());
    importerLayers.get(edge.to)!.add(fromLayer);
    importerCounts.set(edge.to, (importerCounts.get(edge.to) ?? 0) + 1);
  }

  const results: CrossCuttingFile[] = [];
  for (const [file, layerSet] of importerLayers) {
    if (layerSet.size >= minLayerSpread) {
      results.push({
        file,
        totalImporters: importerCounts.get(file) ?? 0,
        layerSpread: layerSet.size,
        layers: [...layerSet].sort(),
      });
    }
  }

  // Sort by layer spread descending, then by total importers descending, alphabetical tiebreaker
  results.sort((a, b) => b.layerSpread - a.layerSpread || b.totalImporters - a.totalImporters || a.file.localeCompare(b.file));
  return results;
}
