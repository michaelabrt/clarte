/**
 * Rust trait resolution: impl block method indexing, trait visibility
 * enforcement and deref coercion chains.
 *
 * Rust dispatches all methods through impl blocks. A type can have:
 * - Inherent impls: `impl Foo { fn bar() }` — always visible
 * - Trait impls: `impl Display for Foo { fn fmt() }` — visible only if trait is in scope
 * - Deref coercion: `impl Deref for Wrapper { type Target = Inner }` — method fallback chain
 */

import type { ImportBinding, SymbolIndex } from "./symbol-resolution";
import type { FileGraphResult, ResolvedSymbolEdge, SemanticEdge } from "./symbol-types";
import { RESOLUTION_CONFIDENCE } from "./symbol-types";

// ── Method index types ────────────────────────────────────────────────────────

interface RustMethodIndex {
  /** type -> Set of inherent method names */
  inherent: Map<string, Set<string>>;
  /** type -> Map<traitName, Set<method names>> */
  traitImpls: Map<string, Map<string, Set<string>>>;
  /** wrapper type -> deref target type */
  derefMap: Map<string, string>;
  /** type -> filePath where the type is defined */
  typeFiles: Map<string, string>;
}

// ── Build Rust method index ───────────────────────────────────────────────────

/**
 * Build a method index from impl blocks across all files.
 * Merges multiple impl blocks for the same type (which may appear in different files).
 */
export function buildRustMethodIndex(fileGraphs: Map<string, FileGraphResult>): RustMethodIndex {
  const inherent = new Map<string, Set<string>>();
  const traitImpls = new Map<string, Map<string, Set<string>>>();
  const derefMap = new Map<string, string>();
  const typeFiles = new Map<string, string>();

  for (const [filePath, result] of fileGraphs) {
    // Track where types are defined
    for (const sym of result.symbols) {
      if (sym.kind === "struct" || sym.kind === "enum" || sym.kind === "trait") {
        typeFiles.set(sym.name, filePath);
      }
    }

    for (const impl of result.implBlocks) {
      if (impl.traitName) {
        // Trait impl
        let typeTraits = traitImpls.get(impl.targetType);
        if (!typeTraits) {
          typeTraits = new Map();
          traitImpls.set(impl.targetType, typeTraits);
        }
        let methodSet = typeTraits.get(impl.traitName);
        if (!methodSet) {
          methodSet = new Set();
          typeTraits.set(impl.traitName, methodSet);
        }
        for (const m of impl.methods) methodSet.add(m);

        // Deref detection
        if ((impl.traitName === "Deref" || impl.traitName === "std::ops::Deref") && impl.derefTarget) {
          derefMap.set(impl.targetType, impl.derefTarget);
        }
      } else {
        // Inherent impl
        let methodSet = inherent.get(impl.targetType);
        if (!methodSet) {
          methodSet = new Set();
          inherent.set(impl.targetType, methodSet);
        }
        for (const m of impl.methods) methodSet.add(m);
      }
    }
  }

  return { inherent, traitImpls, derefMap, typeFiles };
}

// ── Trait visibility check ────────────────────────────────────────────────────

/**
 * Get the set of trait names imported in a file.
 * Used to enforce trait visibility: trait methods are only callable
 * if the trait is in scope (imported).
 */
function getImportedTraits(filePath: string, importMaps: Map<string, Map<string, ImportBinding>>): Set<string> {
  const importMap = importMaps.get(filePath);
  if (!importMap) return new Set();

  const traits = new Set<string>();
  for (const [name] of importMap) {
    traits.add(name);
  }
  return traits;
}

// ── Method resolution with trait visibility and deref coercion ─────────────────

/**
 * Resolve a Rust method call on a known type.
 * Resolution order (per Rust's rules):
 * 1. Inherent methods (always visible, no trait import needed)
 * 2. Trait impl methods (trait must be imported in the calling file)
 * 3. Deref coercion: if type implements Deref, try the Target type (max depth 3)
 */
export function resolveRustMethod(
  typeName: string,
  methodName: string,
  callingFile: string,
  index: RustMethodIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
  depth = 0,
): { typeName: string; filePath: string } | null {
  if (depth > 3) return null;

  // 1. Check inherent methods
  const inherentMethods = index.inherent.get(typeName);
  if (inherentMethods?.has(methodName)) {
    const filePath = index.typeFiles.get(typeName);
    if (filePath) return { typeName, filePath };
  }

  // 2. Check trait impl methods (trait must be in scope)
  const importedTraits = getImportedTraits(callingFile, importMaps);
  const typeTraits = index.traitImpls.get(typeName);
  if (typeTraits) {
    for (const [traitName, methods] of typeTraits) {
      if (methods.has(methodName) && importedTraits.has(traitName)) {
        const filePath = index.typeFiles.get(typeName);
        if (filePath) return { typeName, filePath };
      }
    }
  }

  // 3. Deref coercion
  const derefTarget = index.derefMap.get(typeName);
  if (derefTarget) {
    return resolveRustMethod(derefTarget, methodName, callingFile, index, importMaps, depth + 1);
  }

  return null;
}

// ── Resolve all Rust trait edges ──────────────────────────────────────────────

/**
 * Generate implements edges from Rust impl blocks and resolve method calls
 * through the trait visibility / deref coercion pipeline.
 * Called from the main resolution pipeline for Rust files.
 */
export function resolveRustTraitEdges(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): ResolvedSymbolEdge[] {
  const index = buildRustMethodIndex(fileGraphs);
  const edges: ResolvedSymbolEdge[] = [];

  // Resolve method calls using the index
  for (const [filePath, result] of fileGraphs) {
    for (const callSite of result.callSites) {
      if (!callSite.isMemberExpression || !callSite.objectName) continue;

      if (callSite.objectName) {
        const resolved = resolveRustMethod(callSite.objectName, callSite.calleeName, filePath, index, importMaps);
        if (resolved) {
          const targetId = symbolIndex.byFileAndName.get(`${resolved.filePath}::${callSite.calleeName}`);
          if (targetId && targetId.length > 0) {
            edges.push({
              fromFile: filePath,
              fromSymbol: callSite.callerFn ?? "",
              toFile: resolved.filePath,
              toSymbol: callSite.calleeName,
              kind: "calls",
              line: callSite.line,
              confidence: RESOLUTION_CONFIDENCE.TIER_2_MEMBER,
            });
          }
        }
      }
    }
  }

  return edges;
}

/**
 * Audit Shift 3: Extract semantic edges for Rust deref coercion chains.
 * Surfaces the Deref relationships as explicit semantic edges so that
 * impact analysis can trace method calls through coercion boundaries.
 */
export function extractRustSemanticEdges(fileGraphs: Map<string, FileGraphResult>): SemanticEdge[] {
  const index = buildRustMethodIndex(fileGraphs);
  const semanticEdges: SemanticEdge[] = [];

  for (const [wrapperType, targetType] of index.derefMap) {
    const wrapperFile = index.typeFiles.get(wrapperType);
    const targetFile = index.typeFiles.get(targetType);
    if (!wrapperFile || !targetFile) continue;

    semanticEdges.push({
      fromFile: wrapperFile,
      fromSymbol: wrapperType,
      toFile: targetFile,
      toSymbol: targetType,
      kind: "rust:deref_coercion",
      line: 0,
      confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
      reason: `${wrapperType} implements Deref<Target = ${targetType}>; method calls on ${wrapperType} may resolve to ${targetType} methods`,
    });
  }

  return semanticEdges;
}
