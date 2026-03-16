import path from "node:path";
import { glob } from "tinyglobby";
import { readFileOr } from "../utils.js";
import { initForLanguage, parseSource } from "../parsers/init.js";
import { detectBarrelAst } from "../parsers/barrel.js";
import { computeHITS, computeBetweenness } from "./centrality.js";
import { HITS } from "../config/thresholds.js";
import {
  extractSymbolNamesFromRoot,
  extractSymbolBodiesFromRoot,
  extractSymbolStartLines,
  extractIntraFileCalls,
} from "../parsers/extract-symbols.js";
import { parseImportsAstFromRoot } from "../parsers/parse-imports.js";
import {
  getSourceGlob,
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
import { routeBarrelImport } from "./barrel-routing.js";
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
  const symbolBodyTokens = new Map<string, Map<string, string[]>>();
  const symbolStartLines = new Map<string, Map<string, number>>();
  const intraFileCalls = new Map<string, Array<{ caller: string; callee: string }>>();

  for (let i = 0; i < files.length; i++) {
    const file = files[i];

    if ((i + 1) % 50 === 0 || i === files.length - 1) {
      onProgress?.(`Parsing imports... ${i + 1}/${files.length} files`);
    }

    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    let root: import("web-tree-sitter").Node;
    try {
      root = parseSource(content, language, file);
    } catch {
      continue;
    }
    const rawImports = parseImportsAstFromRoot(root, language);
    const symbols = extractSymbolNamesFromRoot(root, language);
    if (symbols.length > 0) symbolNames.set(file, symbols);

    // Body tokens, start lines, intra-file calls (same parsed AST root, no re-parse)
    const bodyToks = extractSymbolBodiesFromRoot(root, language);
    if (bodyToks.size > 0) symbolBodyTokens.set(file, bodyToks);

    const startLines = extractSymbolStartLines(root, language);
    if (startLines.size > 0) symbolStartLines.set(file, startLines);

    if (symbols.length > 0) {
      const symSet = new Set(symbols);
      const intraCalls = extractIntraFileCalls(root, language, symSet);
      if (intraCalls.length > 0) intraFileCalls.set(file, intraCalls);
    }

    for (const raw of rawImports) {
      const isRelative = isRelativeSpecifier(raw.specifier, language);

      if (isRelative) {
        const resolved = resolveImport(raw.specifier, file, language, fileSet, resolveCtx);
        if (resolved) {
          const barrelNamed = barrelMap.namedExports.get(resolved);
          const barrelStars = barrelMap.starExports.get(resolved);

          if (barrelNamed || barrelStars) {
            const routedEdges = routeBarrelImport(
              {
                from: file,
                to: resolved,
                specifier: raw.specifier,
                importedNames: raw.importedNames,
                isTypeOnly: raw.isTypeOnly,
                isDynamic: raw.isDynamic,
              },
              barrelMap,
            );
            for (const re of routedEdges) {
              edges.push(re);
              inDegree.set(re.to, (inDegree.get(re.to) ?? 0) + 1);
              if (re.isBarrelRouted && !barrelFilePaths.has(file)) {
                directInDegree.set(re.to, (directInDegree.get(re.to) ?? 0) + 1);
              }
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
    symbolBodyTokens,
    symbolStartLines,
    intraFileCalls,
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

/**
 * Recompute HITS and betweenness on a merged multi-language graph.
 * Per-language scores are incommensurable after merge; this re-runs
 * the algorithms on the unified edge set.
 */
export function recomputeScoresAfterMerge(graph: ImportGraph): void {
  const allFiles = [...graph.inDegree.keys()];
  const { authority, hub } = computeHITS(
    allFiles,
    graph.edges,
    HITS.MAX_ITERATIONS,
    HITS.EPSILON,
    graph.barrelFiles,
  );
  graph.authority = authority;
  graph.hubScores = hub;
  graph.centrality = authority;
  graph.betweennessScores = computeBetweenness(graph);
}
