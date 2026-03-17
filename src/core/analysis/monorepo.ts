import path from "node:path";
import type { CrossPackageEdge, ImportEdge, ImportGraph, MonorepoAnalysis, MonorepoInfo } from "../types";
import { readJsonFile } from "../utils";
import { computeHITS } from "../graph/centrality";

/**
 * Determine the public API entry points for a package.
 * Checks the package.json for `main` or `exports` fields first,
 * then falls back to standard index file locations.
 */
async function getPublicEntryPoints(rootDir: string, pkgPath: string): Promise<Set<string>> {
  const entryPoints = new Set<string>();
  const pkgJsonPath = path.join(rootDir, pkgPath, "package.json");
  const pkgJson = await readJsonFile(pkgJsonPath);

  if (pkgJson) {
    // Check "main" field
    if (typeof pkgJson.main === "string") {
      const mainPath = path.posix.join(pkgPath, pkgJson.main);
      entryPoints.add(normalizePath(mainPath));
    }

    // Check "exports" field (string or object with "." key)
    if (typeof pkgJson.exports === "string") {
      entryPoints.add(normalizePath(path.posix.join(pkgPath, pkgJson.exports)));
    } else if (pkgJson.exports && typeof pkgJson.exports === "object") {
      const exportsObj = pkgJson.exports as Record<string, unknown>;
      // Handle "." entry point
      const dotEntry = exportsObj["."];
      if (typeof dotEntry === "string") {
        entryPoints.add(normalizePath(path.posix.join(pkgPath, dotEntry)));
      } else if (dotEntry && typeof dotEntry === "object") {
        // Handle conditional exports: { ".": { "import": "./dist/index.js", "require": ... } }
        for (const val of Object.values(dotEntry as Record<string, unknown>)) {
          if (typeof val === "string") {
            entryPoints.add(normalizePath(path.posix.join(pkgPath, val)));
          }
        }
      }
    }
  }

  // Fallback: standard index file locations
  const extensions = ["ts", "tsx", "js", "jsx"];
  for (const ext of extensions) {
    entryPoints.add(normalizePath(path.posix.join(pkgPath, `index.${ext}`)));
    entryPoints.add(normalizePath(path.posix.join(pkgPath, `src/index.${ext}`)));
  }

  return entryPoints;
}

/**
 * Normalize a file path for consistent comparison.
 * Removes leading "./" and normalizes separators.
 */
function normalizePath(filePath: string): string {
  return filePath.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Find which package a file belongs to.
 * Returns null if the file is not in any known package.
 */
function buildPackageFinder(monorepo: MonorepoInfo): (filePath: string) => { name: string; path: string } | null {
  // Sort by path length descending so longer (more specific) paths match first
  const sortedPackages = [...monorepo.packages].sort((a, b) => b.path.length - a.path.length);

  return (filePath: string) => {
    const normalized = normalizePath(filePath);
    for (const pkg of sortedPackages) {
      const pkgPrefix = normalizePath(pkg.path);
      if (normalized.startsWith(pkgPrefix + "/") || normalized === pkgPrefix) {
        return { name: pkg.name, path: pkg.path };
      }
    }
    return null;
  };
}

/**
 * Annotate import edges that cross monorepo package boundaries.
 *
 * **Mutates `graph` in place:** sets `crossPackage: true` on each edge whose
 * `from` and `to` belong to different packages. The caller must treat the
 * graph's `edges` array as modified after this call. No new edges are added
 * or removed; only the `crossPackage` flag is written.
 */
export function annotateCrossPackageEdges(graph: ImportGraph, monorepo: MonorepoInfo): void {
  const findPackage = buildPackageFinder(monorepo);

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;

    const fromPkg = findPackage(edge.from);
    const toPkg = findPackage(edge.to);

    if (fromPkg && toPkg && fromPkg.name !== toPkg.name) {
      edge.crossPackage = true;
    }
  }
}

/**
 * Compute HITS authority/hub scores within a single package's subgraph.
 * Filters edges to only those where both endpoints are within the package path,
 * then runs computeHITS on that subgraph.
 */
export function computePackageCentrality(
  graph: ImportGraph,
  packagePath: string,
): { authority: Map<string, number>; hub: Map<string, number> } {
  const prefix = normalizePath(packagePath);

  const isInPackage = (filePath: string): boolean => {
    const normalized = normalizePath(filePath);
    return normalized.startsWith(prefix + "/") || normalized === prefix;
  };

  // Collect files and edges within this package
  const packageFiles = new Set<string>();
  const packageEdges: ImportEdge[] = [];

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (isInPackage(edge.from) && isInPackage(edge.to)) {
      packageFiles.add(edge.from);
      packageFiles.add(edge.to);
      packageEdges.push(edge);
    }
  }

  // Also include files that appear as endpoints but have no intra-package edges
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (isInPackage(edge.from)) packageFiles.add(edge.from);
    if (isInPackage(edge.to)) packageFiles.add(edge.to);
  }

  if (packageFiles.size === 0) {
    return { authority: new Map(), hub: new Map() };
  }

  return computeHITS([...packageFiles], packageEdges);
}

/**
 * Analyze a monorepo's import graph for cross-package edges and encapsulation violations.
 * Also annotates the original graph edges with `crossPackage: true`.
 */
export async function analyzeMonorepoGraph(
  rootDir: string,
  graph: ImportGraph,
  monorepo: MonorepoInfo,
): Promise<MonorepoAnalysis> {
  const findPackage = buildPackageFinder(monorepo);

  // Annotate edges with crossPackage flag
  annotateCrossPackageEdges(graph, monorepo);

  // Pre-compute public entry points for all packages
  const publicEntryPointsMap = new Map<string, Set<string>>();
  for (const pkg of monorepo.packages) {
    const entryPoints = await getPublicEntryPoints(rootDir, pkg.path);
    publicEntryPointsMap.set(pkg.name, entryPoints);
  }

  const crossPackageEdges: CrossPackageEdge[] = [];
  const packageDependencies = new Map<string, Set<string>>();

  // Initialize dependency sets for all packages
  for (const pkg of monorepo.packages) {
    packageDependencies.set(pkg.name, new Set());
  }

  for (const edge of graph.edges) {
    if (edge.isExternal || !edge.crossPackage) continue;

    const fromPkg = findPackage(edge.from);
    const toPkg = findPackage(edge.to);

    // Both files must belong to known packages and differ
    if (!fromPkg || !toPkg || fromPkg.name === toPkg.name) continue;

    // Check if the target file is a public entry point
    const publicEntryPoints = publicEntryPointsMap.get(toPkg.name) ?? new Set();
    const normalizedTo = normalizePath(edge.to);
    const isEncapsulationViolation = !publicEntryPoints.has(normalizedTo);

    const crossEdge: CrossPackageEdge = {
      from: edge.from,
      to: edge.to,
      fromPackage: fromPkg.name,
      toPackage: toPkg.name,
      isEncapsulationViolation,
    };

    crossPackageEdges.push(crossEdge);

    // Track package dependencies
    const deps = packageDependencies.get(fromPkg.name);
    if (deps) {
      deps.add(toPkg.name);
    }
  }

  const encapsulationViolations = crossPackageEdges.filter((e) => e.isEncapsulationViolation);

  return {
    crossPackageEdges,
    encapsulationViolations,
    packageDependencies,
  };
}
