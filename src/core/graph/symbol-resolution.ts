/**
 * 4-tier symbol resolution engine (RFC §2.4-2.7).
 *
 * Tier 1: Direct import match (calleeName in import map).
 * Tier 2: Member expression on imported binding (obj.method() where obj is imported).
 * Tier 3: Constructor + method (new Class(); instance.method()).
 * Tier 4: Re-export chain (barrel routing, verified through file_edges).
 *
 * Includes LRU cache for symbol ID lookups and language-specific heritage resolution.
 */

import type { FileGraphResult, RawCallSite, ResolvedSymbolEdge, ConstructorBinding } from "./symbol-types.js";
import { RESOLUTION_CONFIDENCE } from "./symbol-types.js";

// ── LRU cache for symbol ID lookups ───────────────────────────────────────────

export class LRUCache<K, V> {
  private readonly capacity: number;
  private readonly cache = new Map<K, V>();

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get(key: K): V | undefined {
    const value = this.cache.get(key);
    if (value === undefined) return undefined;
    // Move to end (most recently used)
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key: K, value: V): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.capacity) {
      // Evict least recently used (first entry)
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, value);
  }

  clear(): void {
    this.cache.clear();
  }
}

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
  fileEdges: Array<{ fromPath: string; toPath: string; importedNames: string[]; isBarrelRouted: boolean }>,
): Map<string, ImportBinding> {
  const importMap = new Map<string, ImportBinding>();

  for (const edge of fileEdges) {
    if (edge.fromPath !== filePath) continue;

    for (const name of edge.importedNames) {
      if (name === "*") {
        // Namespace import - stored specially, matched by objectName in Tier 2
        importMap.set(`*:${edge.toPath}`, {
          localName: "*",
          sourceFile: edge.toPath,
          isNamespace: true,
          isDefault: false,
          isBarrelRouted: edge.isBarrelRouted,
        });
        continue;
      }
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
}

export function buildSymbolIndex(
  symbols: Array<{ id: number; filePath: string; name: string; kind: string; startLine: number }>,
): SymbolIndex {
  const byFileAndName = new Map<string, SymbolEntry[]>();
  const byFile = new Map<string, SymbolEntry[]>();

  for (const s of symbols) {
    const entry: SymbolEntry = { id: s.id, filePath: s.filePath, name: s.name, kind: s.kind, startLine: s.startLine };

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
  }

  return { byFileAndName, byFile };
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
  fileEdges: Array<{ fromPath: string; toPath: string; importedNames: string[]; isBarrelRouted: boolean }>;
  /** Symbol index (populated after symbols are stored in DB) */
  symbolIndex: SymbolIndex;
  /** LRU cache for symbol ID lookups */
  cache: LRUCache<string, number | null>;
}

/**
 * Resolve all call sites, heritage chains, decorators and type usages across all files.
 * Returns resolved symbol edges ready for DB insertion.
 */
export function resolveAllSymbolEdges(ctx: ResolutionContext): ResolvedSymbolEdge[] {
  const edges: ResolvedSymbolEdge[] = [];

  // Pre-build import maps per file
  const importMaps = new Map<string, Map<string, ImportBinding>>();
  // Also build a reverse map: importedName -> (sourceFile, binding) for namespace lookups
  const namespaceImports = new Map<string, Array<{ localName: string; sourceFile: string }>>();

  for (const [filePath] of ctx.fileGraphs) {
    const importMap = buildImportMap(filePath, ctx.fileEdges);
    importMaps.set(filePath, importMap);

    // Collect namespace imports for this file
    for (const [, binding] of importMap) {
      if (binding.isNamespace) {
        let ns = namespaceImports.get(filePath);
        if (!ns) {
          ns = [];
          namespaceImports.set(filePath, ns);
        }
        ns.push({ localName: binding.localName, sourceFile: binding.sourceFile });
      }
    }
  }

  for (const [filePath, result] of ctx.fileGraphs) {
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();

    // Build constructor binding map for Tier 3 (scope-local)
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
    confidence: binding.isBarrelRouted ? RESOLUTION_CONFIDENCE.TIER_4_REEXPORT : RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
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

  // Check if objectName is a known import
  const binding = importMap.get(callSite.objectName);
  if (!binding) {
    // Check namespace imports: import * as ns; ns.method()
    for (const [key, b] of importMap) {
      if (key.startsWith("*:") && b.isNamespace) {
        // We can't know the local alias from the edge data alone,
        // so we try to resolve the method in the namespace's source file
        const targetId = lookupSymbolIdByKind(
          b.sourceFile,
          callSite.calleeName,
          ["function", "method", "variable"],
          ctx.symbolIndex,
          ctx.cache,
        );
        if (targetId !== null) {
          return {
            fromFile: filePath,
            fromSymbol: callSite.callerFn ?? "",
            toFile: b.sourceFile,
            toSymbol: callSite.calleeName,
            kind: "calls",
            line: callSite.line,
            confidence: RESOLUTION_CONFIDENCE.TIER_2_MEMBER,
          };
        }
      }
    }
    return null;
  }

  // Look up method in the source file
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

function buildConstructorBindings(
  result: FileGraphResult,
  importMap: Map<string, ImportBinding>,
): Map<string, ConstructorBinding> {
  const bindings = new Map<string, ConstructorBinding>();

  // Find all constructor call sites (new Class())
  for (const callSite of result.callSites) {
    if (!callSite.isConstructor) continue;

    const binding = importMap.get(callSite.calleeName);
    if (!binding) continue;

    // Find the variable assignment: const svc = new Class()
    // We track by caller function scope
    // The call site's callerFn defines the scope
    // Look for variable names bound to this constructor in the symbols
    // For simplicity in the AST-extracted data, we track constructor
    // class names and their source files. The variable name tracking
    // happens at resolution time by scanning call sites.
    // We store as className -> binding so Tier 3 can check objectName.
    bindings.set(callSite.calleeName, {
      variableName: callSite.calleeName,
      sourceFile: binding.sourceFile,
      className: callSite.calleeName,
    });
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

  // Check if objectName matches a local variable bound to a constructor
  // This requires the extraction to have tracked variable assignments.
  // Since we track constructor calls by class name, we check if the
  // objectName matches any known constructor-bound class.
  // In practice: const svc = new UserService(); svc.method() -
  // objectName="svc", but we only know UserService was constructed.
  // So we scan all constructor bindings in this file's scope and
  // try to match by looking at all class imports that were constructed.

  for (const [, binding] of constructorBindings) {
    // Try resolving the method in the constructor's source file
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
        confidence: RESOLUTION_CONFIDENCE.TIER_3_CONSTRUCTOR,
      };
    }
  }

  return null;
}

// ── Combined call site resolution ─────────────────────────────────────────────

function resolveCallSite(
  filePath: string,
  callSite: RawCallSite,
  importMap: Map<string, ImportBinding>,
  constructorBindings: Map<string, ConstructorBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // Constructor calls resolve directly to the class
  if (callSite.isConstructor) {
    return resolveTier1(filePath, callSite.calleeName, callSite.callerFn, callSite.line, importMap, ctx);
  }

  if (!callSite.isMemberExpression) {
    // Tier 1: direct import match
    const tier1 = resolveTier1(filePath, callSite.calleeName, callSite.callerFn, callSite.line, importMap, ctx);
    if (tier1) return tier1;

    // Same-file call: check if callee is defined in the same file
    const sameFileId = lookupSymbolId(filePath, callSite.calleeName, ctx.symbolIndex, ctx.cache);
    if (sameFileId !== null && callSite.callerFn) {
      return {
        fromFile: filePath,
        fromSymbol: callSite.callerFn,
        toFile: filePath,
        toSymbol: callSite.calleeName,
        kind: "calls",
        line: callSite.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }

    return null;
  }

  // Member expression: try Tier 2, then Tier 3
  const tier2 = resolveTier2(filePath, callSite, importMap, ctx);
  if (tier2) return tier2;

  const tier3 = resolveTier3(filePath, callSite, constructorBindings, ctx);
  if (tier3) return tier3;

  return null;
}

// ── Heritage resolution ───────────────────────────────────────────────────────

function resolveHeritage(
  filePath: string,
  heritage: { className: string; kind: "extends" | "implements"; target: string; line: number },
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  // First check imports
  const binding = importMap.get(heritage.target);
  if (binding) {
    const targetId = lookupSymbolId(binding.sourceFile, heritage.target, ctx.symbolIndex, ctx.cache);
    if (targetId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: heritage.className,
        toFile: binding.sourceFile,
        toSymbol: heritage.target,
        kind: heritage.kind,
        line: heritage.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }
  }

  // Same-file resolution
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
    };
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

  // Same-file decorator
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

  return null;
}

// ── Type usage resolution ─────────────────────────────────────────────────────

function resolveTypeUsage(
  filePath: string,
  usage: { symbolName: string; typeName: string; line: number },
  importMap: Map<string, ImportBinding>,
  ctx: ResolutionContext,
): ResolvedSymbolEdge | null {
  const binding = importMap.get(usage.typeName);
  if (binding) {
    const targetId = lookupSymbolId(binding.sourceFile, usage.typeName, ctx.symbolIndex, ctx.cache);
    if (targetId !== null) {
      return {
        fromFile: filePath,
        fromSymbol: usage.symbolName,
        toFile: binding.sourceFile,
        toSymbol: usage.typeName,
        kind: "uses_type",
        line: usage.line,
        confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      };
    }
  }

  // Same-file type
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

  return null;
}
