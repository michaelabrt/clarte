import path from "node:path";
import { glob } from "tinyglobby";
import { readFileOr } from "../utils.js";
import { initForLanguage } from "../parsers/init.js";
import { detectBarrelAst } from "../parsers/barrel.js";
import { computeHITS, computeBetweenness } from "./centrality.js";
import { extractSymbolNames } from "../parsers/extract-symbols.js";
import {
  getSourceGlob,
  parseImports,
  isRelativeSpecifier,
  resolveImport,
  resolveAliasImport,
  resolveBarrelFiles,
  loadTsconfigPaths,
  loadGoModule,
  detectJavaSourceRoots,
  getPackageName,
  SOURCE_IGNORE,
  type BarrelExportMap,
  type ResolveContext,
} from "./import-resolution.js";
import type { ImportEdge, ImportGraph, Language, ProgressCallback } from "../types.js";

/**
 * Detect barrel files: files where >50% of top-level statements are re-exports.
 * Returns a Set of relative file paths identified as barrels.
 */
export async function detectBarrelFiles(rootDir: string, fileSet: Set<string>): Promise<Set<string>> {
  const barrels = new Set<string>();

  for (const file of fileSet) {
    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const result = detectBarrelAst(content, file);
    if (result.isBarrel) {
      barrels.add(file);
    }
  }

  return barrels;
}

/**
 * Build the import graph for a project.
 */
export async function buildImportGraph(
  rootDir: string,
  language: Language,
  onProgress?: ProgressCallback,
): Promise<ImportGraph> {
  await initForLanguage(language);
  const globs = getSourceGlob(language);
  let files: string[];
  try {
    files = (
      await glob(globs, {
        cwd: rootDir,
        ignore: SOURCE_IGNORE,
        absolute: false,
      })
    ).sort();
  } catch (err: unknown) {
    // Gracefully degrade on permission errors (e.g. scanning ~/ on macOS)
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      onProgress?.("Warning: permission error scanning files, returning empty graph");
      return {
        edges: [],
        inDegree: new Map(),
        directInDegree: new Map(),
        centrality: new Map(),
        externalImportCounts: new Map(),
        authority: new Map(),
        hubScores: new Map(),
      };
    }
    throw err;
  }

  onProgress?.(`Found ${files.length} source files to analyze`);

  const fileSet = new Set(files);
  const edges: ImportEdge[] = [];
  const inDegree = new Map<string, number>();
  const directInDegree = new Map<string, number>();
  const externalImportCounts = new Map<string, number>();

  const isJsTs = language === "typescript" || language === "javascript";
  const pathAliases = isJsTs ? await loadTsconfigPaths(rootDir) : [];
  if (pathAliases.length > 0) {
    onProgress?.(`Loaded ${pathAliases.length} path alias(es) from tsconfig`);
  }

  const resolveCtx: ResolveContext = {};
  if (language === "go") {
    resolveCtx.goModulePath = await loadGoModule(rootDir);
    if (resolveCtx.goModulePath) {
      onProgress?.(`Go module: ${resolveCtx.goModulePath}`);
    }
  }
  if (language === "java") {
    resolveCtx.javaSourceRoots = detectJavaSourceRoots(files);
    if (resolveCtx.javaSourceRoots.length > 0) {
      onProgress?.(
        `Java source root${resolveCtx.javaSourceRoots.length === 1 ? "" : "s"}: ${resolveCtx.javaSourceRoots.join(", ")}`,
      );
    }
  }

  let detectedBarrels = new Set<string>();
  if (isJsTs) {
    detectedBarrels = await detectBarrelFiles(rootDir, fileSet);
    if (detectedBarrels.size > 0) {
      onProgress?.(`Detected ${detectedBarrels.size} barrel file${detectedBarrels.size === 1 ? "" : "s"}`);
    }
  }

  let barrelMap: BarrelExportMap = { namedExports: new Map(), starExports: new Map() };
  if (isJsTs && detectedBarrels.size > 0) {
    barrelMap = await resolveBarrelFiles(rootDir, fileSet, detectedBarrels);
    const barrelCount = barrelMap.namedExports.size + barrelMap.starExports.size;
    if (barrelCount > 0) {
      onProgress?.(`Resolved ${barrelCount} barrel file${barrelCount === 1 ? "" : "s"}`);
    }
  }

  // Build set of barrel file paths so we can exclude their outgoing edges from directInDegree
  const barrelFilePaths = new Set([...barrelMap.namedExports.keys(), ...barrelMap.starExports.keys()]);

  for (const file of files) {
    inDegree.set(file, 0);
    directInDegree.set(file, 0);
  }

  const symbolNames = new Map<string, string[]>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if ((i + 1) % 50 === 0 || i === files.length - 1) {
      onProgress?.(`Parsing imports... ${i + 1}/${files.length} files`);
    }

    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const rawImports = parseImports(content, language);
    const symbols = extractSymbolNames(content, language, file);
    if (symbols.length > 0) symbolNames.set(file, symbols);

    for (const raw of rawImports) {
      const isRelative = isRelativeSpecifier(raw.specifier, language);

      if (isRelative) {
        const resolved = resolveImport(raw.specifier, file, language, fileSet, resolveCtx);
        if (resolved) {
          const barrelNamed = barrelMap.namedExports.get(resolved);
          const barrelStars = barrelMap.starExports.get(resolved);

          if (barrelNamed || barrelStars) {
            // Barrel import: route each name to its actual source file
            const routedNames = new Map<string, string[]>();
            const unresolved: string[] = [];

            for (const name of raw.importedNames) {
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
                from: file,
                to: source,
                isExternal: false,
                specifier: raw.specifier,
                importedNames: names,
                isTypeOnly: raw.isTypeOnly,
                isDynamic: raw.isDynamic,
                isBarrelRouted: true,
              });
              inDegree.set(source, (inDegree.get(source) ?? 0) + 1);
              // Barrel-routed imports from non-barrel consumers are genuine usage
              if (!barrelFilePaths.has(file)) {
                directInDegree.set(source, (directInDegree.get(source) ?? 0) + 1);
              }
            }

            // Unresolved names (could be from star exports): create edges to star sources
            if (unresolved.length > 0 && barrelStars) {
              for (const starSource of barrelStars) {
                edges.push({
                  from: file,
                  to: starSource,
                  isExternal: false,
                  specifier: raw.specifier,
                  importedNames: unresolved,
                  isTypeOnly: raw.isTypeOnly,
                  isDynamic: raw.isDynamic,
                  isBarrelRouted: true,
                });
                inDegree.set(starSource, (inDegree.get(starSource) ?? 0) + 1);
                // Star-routed imports from non-barrel consumers are genuine usage
                if (!barrelFilePaths.has(file)) {
                  directInDegree.set(starSource, (directInDegree.get(starSource) ?? 0) + 1);
                }
              }
            }

            // Side-effect import to barrel (no names): keep edge to barrel itself
            if (raw.importedNames.length === 0) {
              edges.push({
                from: file,
                to: resolved,
                isExternal: false,
                specifier: raw.specifier,
                importedNames: [],
                isTypeOnly: raw.isTypeOnly,
                isDynamic: raw.isDynamic,
              });
              inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
            }
          } else {
            edges.push({
              from: file,
              to: resolved,
              isExternal: false,
              specifier: raw.specifier,
              importedNames: raw.importedNames,
              isTypeOnly: raw.isTypeOnly,
              isDynamic: raw.isDynamic,
            });
            inDegree.set(resolved, (inDegree.get(resolved) ?? 0) + 1);
            // Barrel files' own outgoing edges are re-exports, not genuine usage
            if (!barrelFilePaths.has(file)) {
              directInDegree.set(resolved, (directInDegree.get(resolved) ?? 0) + 1);
            }
          }
        } else if (language === "go" || language === "java" || language === "rust") {
          // For Go/Java/Rust, unresolved "relative" imports are actually external
          // (stdlib, third-party). Fall through to external edge creation.
          // Skip unresolved mod declarations (mod::) -- these are Rust compile errors, not packages.
          if (raw.specifier.startsWith("mod::")) continue;
          const pkgName = getPackageName(raw.specifier, language);
          edges.push({
            from: file,
            to: pkgName,
            isExternal: true,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          externalImportCounts.set(pkgName, (externalImportCounts.get(pkgName) ?? 0) + 1);
        }
      } else {
        const aliasResolved = pathAliases.length > 0 ? resolveAliasImport(raw.specifier, pathAliases, fileSet) : null;

        if (aliasResolved) {
          edges.push({
            from: file,
            to: aliasResolved,
            isExternal: false,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          inDegree.set(aliasResolved, (inDegree.get(aliasResolved) ?? 0) + 1);
          if (!barrelFilePaths.has(file)) {
            directInDegree.set(aliasResolved, (directInDegree.get(aliasResolved) ?? 0) + 1);
          }
        } else {
          const pkgName = getPackageName(raw.specifier, language);
          edges.push({
            from: file,
            to: pkgName,
            isExternal: true,
            specifier: raw.specifier,
            importedNames: raw.importedNames,
            isTypeOnly: raw.isTypeOnly,
            isDynamic: raw.isDynamic,
          });
          externalImportCounts.set(pkgName, (externalImportCounts.get(pkgName) ?? 0) + 1);
        }
      }
    }
  }

  onProgress?.("Computing centrality (HITS)...");
  const { authority, hub: hubScores } = computeHITS(files, edges, 30, 1e-6, detectedBarrels);

  onProgress?.("Computing betweenness centrality...");
  const graphForBetweenness: ImportGraph = {
    edges,
    inDegree,
    directInDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles: detectedBarrels,
  };
  const betweennessScores = computeBetweenness(graphForBetweenness);

  // Use authority as centrality for backward compat (snapshot.ts etc.)
  return {
    edges,
    inDegree,
    directInDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores,
    barrelFiles: detectedBarrels,
    betweennessScores,
    symbolNames,
  };
}

/**
 * Merge a secondary language graph into the primary graph (in-place).
 * Used for multi-language projects where each language is parsed separately.
 */
export function mergeGraph(target: ImportGraph, source: ImportGraph): void {
  target.edges.push(...source.edges);
  for (const [k, v] of source.inDegree) {
    target.inDegree.set(k, (target.inDegree.get(k) ?? 0) + v);
  }
  if (source.directInDegree) {
    if (!target.directInDegree) target.directInDegree = new Map();
    for (const [k, v] of source.directInDegree) {
      target.directInDegree.set(k, (target.directInDegree.get(k) ?? 0) + v);
    }
  }
  for (const [k, v] of source.centrality) {
    if (!target.centrality.has(k)) target.centrality.set(k, v);
  }
  for (const [k, v] of source.externalImportCounts) {
    target.externalImportCounts.set(k, (target.externalImportCounts.get(k) ?? 0) + v);
  }
  for (const [k, v] of source.authority) {
    if (!target.authority.has(k)) target.authority.set(k, v);
  }
  for (const [k, v] of source.hubScores) {
    if (!target.hubScores.has(k)) target.hubScores.set(k, v);
  }
}
