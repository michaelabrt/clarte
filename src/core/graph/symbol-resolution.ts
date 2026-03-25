/**
 * 4-tier symbol resolution engine.
 *
 * Tier 1: Same-file symbol (local scope wins) then direct import match.
 * Tier 2: Member expression on imported binding (obj.method() where obj is imported).
 * Tier 3: Constructor + method (const svc = new Class(); svc.method()).
 * Tier 4: Re-export chain (barrel routing, verified through file_edges).
 */

import type { InMemorySymbolGraph } from "../../storage/types";
import type { ConstructorBinding, FileGraphResult, RawCallSite, ResolvedSymbolEdge } from "./symbol-types";
import { RESOLUTION_CONFIDENCE, barrelAdjustedConfidence } from "./symbol-types";
import { resolveByProximity } from "./constraint-resolution";
import type { LRUCache } from "../lru-cache";
export { LRUCache } from "../lru-cache";

// ── Import map (per file) ─────────────────────────────────────────────────────

export interface ImportBinding {
  /** The imported name (what appears in the import statement) */
  localName: string;
  /** The file the import comes from (resolved path) */
  sourceFile: string;
  /** Whether this is a namespace import (import * as ns) */
  isNamespace: boolean;
  /** Whether this is a default import */
  isDefault: boolean;
  /** Whether this import was barrel-routed */
  isBarrelRouted: boolean;
}

/** Build import map from file edges for a single source file. */
export function buildImportMap(
  filePath: string,
  fileEdges: Array<{
    fromPath: string;
    toPath: string;
    importedNames: string[];
    isBarrelRouted: boolean;
  }>,
): Map<string, ImportBinding> {
  const importMap = new Map<string, ImportBinding>();

  for (const edge of fileEdges) {
    if (edge.fromPath !== filePath) continue;

    for (const name of edge.importedNames) {
      if (name === "default") {
        importMap.set(name, {
          localName: name,
          sourceFile: edge.toPath,
          isNamespace: false,
          isDefault: true,
          isBarrelRouted: edge.isBarrelRouted,
        });
        continue;
      }

      if (name.startsWith("* as ")) {
        // Namespace import with alias: "* as ns" → key by alias "ns"
        // so Tier 2 can match callSite.objectName === "ns"
        const alias = name.slice(5).trim();
        if (alias) {
          importMap.set(alias, {
            localName: alias,
            sourceFile: edge.toPath,
            isNamespace: true,
            isDefault: false,
            isBarrelRouted: edge.isBarrelRouted,
          });
        }
        continue;
      }

      if (name === "*") {
        // Legacy format (no alias info) — store by path key as fallback.
        // Cannot be matched by objectName lookup; will not cause false positives.
        importMap.set(`*:${edge.toPath}`, {
          localName: "*",
          sourceFile: edge.toPath,
          isNamespace: true,
          isDefault: false,
          isBarrelRouted: edge.isBarrelRouted,
        });
        continue;
      }

      importMap.set(name, {
        localName: name,
        sourceFile: edge.toPath,
        isNamespace: false,
        isDefault: false,
        isBarrelRouted: edge.isBarrelRouted,
      });
    }
  }

  return importMap;
}

// ── Symbol index (for lookup by file + name) ──────────────────────────────────

export interface SymbolEntry {
  id: number;
  filePath: string;
  name: string;
  kind: string;
  startLine: number;
}

export interface SymbolIndex {
  /** Map from "filePath::symbolName" to symbol entries (may have multiple for overloads) */
  byFileAndName: Map<string, SymbolEntry[]>;
  /** Map from filePath to all symbols in that file */
  byFile: Map<string, SymbolEntry[]>;
  /** Map from symbolName to all entries with that name (cross-file lookup) */
  byName: Map<string, SymbolEntry[]>;
}

export function buildSymbolIndex(
  symbols: Array<{
    id: number;
    filePath: string;
    name: string;
    kind: string;
    startLine: number;
  }>,
): SymbolIndex {
  const byFileAndName = new Map<string, SymbolEntry[]>();
  const byFile = new Map<string, SymbolEntry[]>();
  const byName = new Map<string, SymbolEntry[]>();

  for (const s of symbols) {
    const entry: SymbolEntry = {
      id: s.id,
      filePath: s.filePath,
      name: s.name,
      kind: s.kind,
      startLine: s.startLine,
    };

    const fnKey = `${s.filePath}::${s.name}`;
    let entries = byFileAndName.get(fnKey);
    if (!entries) {
      entries = [];
      byFileAndName.set(fnKey, entries);
    }
    entries.push(entry);

    let fileEntries = byFile.get(s.filePath);
    if (!fileEntries) {
      fileEntries = [];
      byFile.set(s.filePath, fileEntries);
    }
    fileEntries.push(entry);

    let nameEntries = byName.get(s.name);
    if (!nameEntries) {
      nameEntries = [];
      byName.set(s.name, nameEntries);
    }
    nameEntries.push(entry);
  }

  return { byFileAndName, byFile, byName };
}

/** Look up a symbol ID by file path and name, using LRU cache. */
function lookupSymbolId(
  targetFile: string,
  targetName: string,
  index: SymbolIndex,
  cache: LRUCache<string, number | null>,
): number | null {
  const cacheKey = `${targetFile}::${targetName}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const entries = index.byFileAndName.get(cacheKey);
  if (!entries || entries.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }

  // If multiple matches (overloads), use the first by start_line
  const sorted = entries.length > 1 ? [...entries].sort((a, b) => a.startLine - b.startLine) : entries;
  const id = sorted[0].id;
  cache.set(cacheKey, id);
  return id;
}

/** Look up a symbol ID matching specific kinds. */
function lookupSymbolIdByKind(
  targetFile: string,
  targetName: string,
  kinds: string[],
  index: SymbolIndex,
  cache: LRUCache<string, number | null>,
): number | null {
  const cacheKey = `${targetFile}::${targetName}:${kinds.join(",")}`;
  const cached = cache.get(cacheKey);
  if (cached !== undefined) return cached;

  const entries = index.byFileAndName.get(`${targetFile}::${targetName}`);
  if (!entries || entries.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }

  const kindSet = new Set(kinds);
  const filtered = entries.filter((e) => kindSet.has(e.kind));
  if (filtered.length === 0) {
    cache.set(cacheKey, null);
    return null;
  }

  const id = filtered[0].id;
  cache.set(cacheKey, id);
  return id;
}

// ── Builtin globals (skip resolution for these) ──────────────────────────────

const BUILTIN_GLOBALS = new Set([
  "console",
  "Object",
  "Array",
  "Math",
  "JSON",
  "Promise",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "process",
  "Buffer",
  "require",
  "Symbol",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Number",
  "String",
  "Boolean",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
  "print",
  "len",
  "range",
  "super",
  "self",
  "this",
  "fmt",
  "log",
  "System",
]);

// ── Resolution engine ─────────────────────────────────────────────────────────

export interface ResolutionContext {
  /** File graph results per file path */
  fileGraphs: Map<string, FileGraphResult>;
  /** File edges for import map building: { fromPath, toPath, importedNames, isBarrelRouted } */
  fileEdges: Array<{
    fromPath: string;
    toPath: string;
    importedNames: string[];
    isBarrelRouted: boolean;
  }>;
  /** Symbol index (populated after symbols are stored in DB) */
  symbolIndex: SymbolIndex;
  /** LRU cache for symbol ID lookups */
  cache: LRUCache<string, number | null>;
  /** Type alias map for transparent resolution. Optional for backward compat. */
  aliasMap?: Map<string, { targetKey: string }>;
  /** Pre-computed symbol neighborhoods for proximity disambiguation */
  symbolNeighborhoods?: Map<number, Set<number>>;
  /** Pre-computed file-level import neighborhoods (cold-start fallback) */
  fileNeighborhoods?: Map<string, Set<string>>;
  /** File -> Leiden community ID mapping */
  fileCommunities?: Map<string, number>;
  /** Full symbol graph for authority lookups */
  symbolGraph?: InMemorySymbolGraph;
}

/**
 * Resolve all call sites, heritage chains, decorators and type usages across all files.
 * Returns resolved symbol edges ready for DB insertion.
 */
export function resolveAllSymbolEdges(ctx: ResolutionContext): ResolvedSymbolEdge[] {
  const edges: ResolvedSymbolEdge[] = [];

  // Pre-build import maps per file
  const importMaps = new Map<string, Map<string, ImportBinding>>();

  for (const [filePath] of ctx.fileGraphs) {
    const importMap = buildImportMap(filePath, ctx.fileEdges);
    importMaps.set(filePath, importMap);
  }

  for (const [filePath, result] of ctx.fileGraphs) {
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();

    // Build constructor binding map for Tier 3 (scope-local, keyed by variable name)
    const constructorBindings = buildConstructorBindings(result, importMap);

    // Resolve call sites (Tier 1-3)
    for (const callSite of result.callSites) {
      if (BUILTIN_GLOBALS.has(callSite.calleeName)) continue;
      if (callSite.objectName && BUILTIN_GLOBALS.has(callSite.objectName)) continue;

      const resolved = resolveCallSite(filePath, callSite, importMap, constructorBindings, ctx);
      if (resolved) edges.push(resolved);
    }

    // Resolve heritage chains (extends / implements)
    for (const heritage of result.heritageChains) {
      const resolved = resolveHeritage(filePath, heritage, importMap, ctx);
      if (resolved) edges.push(resolved);
    }

    // Resolve decorators
    for (const dec of result.decorators) {
      const resolved = resolveDecorator(filePath, dec, importMap, ctx);
      if (resolved) edges.push(resolved);
    }

    // Resolve type usages
    for (const usage of result.typeUsages) {
      const resolved = resolveTypeUsage(filePath, usage, importMap, ctx);
      if (resolved) edges.push(resolved);
    }
  }

  return edges;
}

// ── Tier 1: Direct import match ───────────────────────────────────────────────

function resolveTier1(
  filePath: string,
  calleeName: string,
  callerFn: string | undefined,
  line: number,
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  const binding = importMap.get(calleeName);
  if (!binding) return null;

  const targetId = lookupSymbolId(binding.sourceFile, calleeName, ctx.symbolIndex, ctx.cache);
  if (targetId === null) return null;

  return {
    fromFile: filePath,
    fromSymbol: callerFn ?? "",
    toFile: binding.sourceFile,
    toSymbol: calleeName,
    kind: "calls",
    line,
    confidence: binding.isBarrelRouted
      ? barrelAdjustedConfidence(RESOLUTION_CONFIDENCE.TIER_1_DIRECT)
      : RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
  };
}

// ── Tier 2: Member expression on imported binding ─────────────────────────────

function resolveTier2(
  filePath: string,
  callSite: RawCallSite,
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  if (!callSite.objectName) return null;

  // Check if objectName is a known import (includes namespace imports keyed by alias)
  const binding = importMap.get(callSite.objectName);
  if (!binding) return null;

  // Look up method/function in the source file
  const targetId = lookupSymbolIdByKind(
    binding.sourceFile,
    callSite.calleeName,
    ["method", "function"],
    ctx.symbolIndex,
    ctx.cache,
  );
  if (targetId !== null) {
    return {
      fromFile: filePath,
      fromSymbol: callSite.callerFn ?? "",
      toFile: binding.sourceFile,
      toSymbol: callSite.calleeName,
      kind: "calls",
      line: callSite.line,
      confidence: RESOLUTION_CONFIDENCE.TIER_2_MEMBER,
    };
  }

  // Fallback: look up any symbol name (could be a property or variable)
  const anyId = lookupSymbolId(binding.sourceFile, callSite.calleeName, ctx.symbolIndex, ctx.cache);
  if (anyId !== null) {
    return {
      fromFile: filePath,
      fromSymbol: callSite.callerFn ?? "",
      toFile: binding.sourceFile,
      toSymbol: callSite.calleeName,
      kind: "calls",
      line: callSite.line,
      confidence: RESOLUTION_CONFIDENCE.TIER_2_MEMBER,
    };
  }

  return null;
}

// ── Tier 3: Constructor + method call ─────────────────────────────────────────

/**
 * Build constructor bindings keyed by variable name.
 * Uses ConstructorAssignment records extracted from the AST, which carry the
 * actual variable name (e.g. "svc" from `const svc = new UserService()`).
 * Only assignments where the class is a known import are recorded.
 */
function buildConstructorBindings(
  result: FileGraphResult,
  importMap: Map<string, ImportBinding>,
): Map<string, ConstructorBinding> {
  const bindings = new Map<string, ConstructorBinding>();

  for (const assignment of result.constructorAssignments) {
    const binding = importMap.get(assignment.className);
    if (!binding) continue;

    const ctorBinding: ConstructorBinding = {
      variableName: assignment.variableName,
      sourceFile: binding.sourceFile,
      className: assignment.className,
      pattern: assignment.pattern ?? "new",
    };

    // Scope key includes callerFn to prevent cross-function leakage (F9 fix)
    if (assignment.callerFn) {
      bindings.set(`${assignment.callerFn}::${assignment.variableName}`, ctorBinding);
    } else {
      // Top-level (module scope) — accessible from any function
      bindings.set(assignment.variableName, ctorBinding);
    }
  }

  return bindings;
}

function resolveTier3(
  filePath: string,
  callSite: RawCallSite,
  constructorBindings: Map<string, ConstructorBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  if (!callSite.objectName || !callSite.isMemberExpression) return null;

  // Try scoped key first (same function), then unscoped (top-level assignments) (F9 fix)
  const scopedKey = callSite.callerFn ? `${callSite.callerFn}::${callSite.objectName}` : callSite.objectName;
  const binding = constructorBindings.get(scopedKey) ?? constructorBindings.get(callSite.objectName);
  if (!binding) return null;

  const targetId = lookupSymbolIdByKind(
    binding.sourceFile,
    callSite.calleeName,
    ["method", "function"],
    ctx.symbolIndex,
    ctx.cache,
  );
  if (targetId === null) return null;

  // Audit F2: pattern-aware confidence for Tier 3
  const tier3Confidence =
    binding.pattern === "call" ? RESOLUTION_CONFIDENCE.TIER_3_FACTORY : RESOLUTION_CONFIDENCE.TIER_3_NEW;

  return {
    fromFile: filePath,
    fromSymbol: callSite.callerFn ?? "",
    toFile: binding.sourceFile,
    toSymbol: callSite.calleeName,
    kind: "calls",
    line: callSite.line,
    confidence: tier3Confidence,
  };
}

// ── Combined call site resolution ─────────────────────────────────────────────

function resolveCallSite(
  filePath: string,
  callSite: RawCallSite,
  importMap: Map<string, ImportBinding>,
  constructorBindings: Map<string, ConstructorBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // Constructor calls: same-file first (F10 fix: local scope takes precedence)
  if (callSite.isConstructor) {
    const sameFileId = lookupSymbolIdByKind(
      filePath,
      callSite.calleeName,
      ["class", "struct"],
      ctx.symbolIndex,
      ctx.cache,
    );
    if (sameFileId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: callSite.callerFn ?? "",
        toFile: filePath,
        toSymbol: callSite.calleeName,
        kind: "calls",
        line: callSite.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }

    const tier1 = resolveTier1(filePath, callSite.calleeName, callSite.callerFn, callSite.line, importMap, ctx);
    if (tier1) return tier1;
  } else if (!callSite.isMemberExpression) {
    // Same-file first: local scope takes precedence over imports in JS/TS/Python
    const sameFileId = lookupSymbolId(filePath, callSite.calleeName, ctx.symbolIndex, ctx.cache);
    if (sameFileId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: callSite.callerFn ?? "",
        toFile: filePath,
        toSymbol: callSite.calleeName,
        kind: "calls",
        line: callSite.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }

    // Tier 1: direct import match
    const tier1 = resolveTier1(filePath, callSite.calleeName, callSite.callerFn, callSite.line, importMap, ctx);
    if (tier1) return tier1;
  } else {
    // Member expression: Tier 2, then Tier 3
    const tier2 = resolveTier2(filePath, callSite, importMap, ctx);
    if (tier2) return tier2;

    const tier3 = resolveTier3(filePath, callSite, constructorBindings, ctx);
    if (tier3) return tier3;
  }

  // Tier 5: Proximity disambiguation (slow path)
  if (ctx.symbolNeighborhoods && ctx.fileNeighborhoods && ctx.fileCommunities && ctx.symbolGraph) {
    const callerSymbolId = callSite.callerFn
      ? lookupSymbolId(filePath, callSite.callerFn, ctx.symbolIndex, ctx.cache)
      : null;
    return resolveByProximity(
      filePath,
      callerSymbolId,
      callSite.calleeName,
      callSite.line,
      callSite.callerFn,
      ctx.symbolNeighborhoods,
      ctx.fileNeighborhoods,
      ctx.symbolIndex,
      ctx.symbolGraph,
      ctx.fileCommunities,
    );
  }

  return null;
}

// ── Type alias resolution ──────────────────────────────────────────────────────

/**
 * Resolve a symbol through the alias map. If the symbol at filePath::name
 * is a type alias, follow the chain to find the concrete type.
 * Returns the resolved { file, name } or the original if not an alias.
 */
function resolveViaAlias(filePath: string, name: string, ctx: ResolutionContext): { filePath: string; name: string } {
  if (!ctx.aliasMap) return { filePath, name };
  const key = `${filePath}::${name}`;
  const alias = ctx.aliasMap.get(key);
  if (!alias) return { filePath, name };

  // Follow chain (max depth 5, cycle detection)
  let current = alias.targetKey;
  const visited = new Set([key]);
  for (let depth = 0; depth < 5; depth++) {
    if (visited.has(current)) break;
    visited.add(current);
    const next = ctx.aliasMap.get(current);
    if (!next) break;
    current = next.targetKey;
  }

  const sepIdx = current.indexOf("::");
  if (sepIdx === -1) return { filePath, name };
  return {
    filePath: current.slice(0, sepIdx),
    name: current.slice(sepIdx + 2),
  };
}

// ── Heritage resolution ───────────────────────────────────────────────────────

function resolveHeritage(
  filePath: string,
  heritage: {
    className: string;
    kind: "extends" | "implements";
    target: string;
    line: number;
    ordinal?: number;
  },
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // Same-file first: local scope takes precedence (F8 fix)
  const sameFileId = lookupSymbolId(filePath, heritage.target, ctx.symbolIndex, ctx.cache);
  if (sameFileId !== null) {
    return {
      fromFile: filePath,
      fromSymbol: heritage.className,
      toFile: filePath,
      toSymbol: heritage.target,
      kind: heritage.kind,
      line: heritage.line,
      confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      ordinal: heritage.ordinal,
    };
  }

  // Then check imports
  const binding = importMap.get(heritage.target);
  if (binding) {
    // Resolve through aliases if the target is a type alias
    const resolved = resolveViaAlias(binding.sourceFile, heritage.target, ctx);
    const targetId = lookupSymbolId(resolved.filePath, resolved.name, ctx.symbolIndex, ctx.cache);
    if (targetId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: heritage.className,
        toFile: resolved.filePath,
        toSymbol: resolved.name,
        kind: heritage.kind,
        line: heritage.line,
        confidence: binding.isBarrelRouted
          ? barrelAdjustedConfidence(RESOLUTION_CONFIDENCE.TIER_1_DIRECT)
          : RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
        ordinal: heritage.ordinal,
      };
    }
  }

  return null;
}

// ── Decorator resolution ──────────────────────────────────────────────────────

function resolveDecorator(
  filePath: string,
  dec: { target: string; decorator: string; line: number },
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // Same-file first (F8 fix)
  const sameFileId = lookupSymbolId(filePath, dec.decorator, ctx.symbolIndex, ctx.cache);
  if (sameFileId !== null) {
    return {
      fromFile: filePath,
      fromSymbol: dec.decorator,
      toFile: filePath,
      toSymbol: dec.target,
      kind: "decorates",
      line: dec.line,
      confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
    };
  }

  // Then check imports
  const binding = importMap.get(dec.decorator);
  if (binding) {
    const targetId = lookupSymbolId(binding.sourceFile, dec.decorator, ctx.symbolIndex, ctx.cache);
    if (targetId !== null) {
      return {
        fromFile: binding.sourceFile,
        fromSymbol: dec.decorator,
        toFile: filePath,
        toSymbol: dec.target,
        kind: "decorates",
        line: dec.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }
  }

  return null;
}

// ── Type usage resolution ─────────────────────────────────────────────────────

function resolveTypeUsage(
  filePath: string,
  usage: { symbolName: string; typeName: string; line: number },
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // Same-file first (F8 fix)
  const sameFileId = lookupSymbolId(filePath, usage.typeName, ctx.symbolIndex, ctx.cache);
  if (sameFileId !== null) {
    return {
      fromFile: filePath,
      fromSymbol: usage.symbolName,
      toFile: filePath,
      toSymbol: usage.typeName,
      kind: "uses_type",
      line: usage.line,
      confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
    };
  }

  // Then check imports, resolving through aliases
  const binding = importMap.get(usage.typeName);
  if (binding) {
    const resolved = resolveViaAlias(binding.sourceFile, usage.typeName, ctx);
    const targetId = lookupSymbolId(resolved.filePath, resolved.name, ctx.symbolIndex, ctx.cache);
    if (targetId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: usage.symbolName,
        toFile: resolved.filePath,
        toSymbol: resolved.name,
        kind: "uses_type",
        line: usage.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }
  }

  return null;
}
