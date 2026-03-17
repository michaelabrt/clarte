import type { ImportEdge } from "../types";
import type { BarrelExportMap } from "./import-resolution";

/**
 * Route an import through a barrel file to its actual source files.
 * Returns the resolved edges (barrel-routed where applicable).
 *
 * Shared by build.ts (full build) and cache.ts (incremental rebuild).
 */
export function routeBarrelImport(
  edge: Pick<ImportEdge, "from" | "to" | "specifier" | "importedNames" | "isTypeOnly" | "isDynamic">,
  barrelMap: BarrelExportMap,
): ImportEdge[] {
  const barrelNamed = barrelMap.namedExports.get(edge.to);
  const barrelStars = barrelMap.starExports.get(edge.to);

  if (!barrelNamed && !barrelStars) return [];

  const edges: ImportEdge[] = [];

  // Namespace import (import * as ns from './barrel'): route to all star export sources
  if (edge.importedNames.includes("*") && barrelStars) {
    for (const [starSource] of barrelStars) {
      edges.push({
        from: edge.from,
        to: starSource,
        isExternal: false,
        specifier: edge.specifier,
        importedNames: ["*"],
        isTypeOnly: edge.isTypeOnly,
        isDynamic: edge.isDynamic,
        isBarrelRouted: true,
      });
    }
    return edges;
  }

  const routedNames = new Map<string, string[]>();
  const unresolved: string[] = [];

  for (const name of edge.importedNames) {
    const source = barrelNamed?.get(name);
    if (source) {
      const existing = routedNames.get(source) ?? [];
      existing.push(name);
      routedNames.set(source, existing);
    } else {
      unresolved.push(name);
    }
  }

  for (const [source, names] of routedNames) {
    edges.push({
      from: edge.from,
      to: source,
      isExternal: false,
      specifier: edge.specifier,
      importedNames: names,
      isTypeOnly: edge.isTypeOnly,
      isDynamic: edge.isDynamic,
      isBarrelRouted: true,
    });
  }

  // Unresolved names: route to star export sources that actually export them
  if (unresolved.length > 0 && barrelStars) {
    for (const [starSource, exportedNames] of barrelStars) {
      const matching = exportedNames.size > 0 ? unresolved.filter((n) => exportedNames.has(n)) : unresolved;
      if (matching.length === 0) continue;
      edges.push({
        from: edge.from,
        to: starSource,
        isExternal: false,
        specifier: edge.specifier,
        importedNames: matching,
        isTypeOnly: edge.isTypeOnly,
        isDynamic: edge.isDynamic,
        isBarrelRouted: true,
      });
    }
  }

  // Side-effect import (no names): keep edge to barrel itself
  if (edge.importedNames.length === 0) {
    edges.push({
      from: edge.from,
      to: edge.to,
      isExternal: false,
      specifier: edge.specifier,
      importedNames: [],
      isTypeOnly: edge.isTypeOnly,
      isDynamic: edge.isDynamic,
    });
  }

  return edges;
}
