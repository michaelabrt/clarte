/**
 * Go structural resolution: struct embedding (method promotion) and
 * implicit interface satisfaction (RFC §2.13).
 *
 * Go has no inheritance or implements keyword. Instead:
 * - Struct embedding promotes methods from embedded types onto the outer struct.
 * - A type satisfies an interface if its method set is a superset of the interface's.
 */

import type { ImportBinding, SymbolIndex } from "./symbol-resolution";
import type { FileGraphResult, ResolvedSymbolEdge, SemanticEdge } from "./symbol-types";
import { RESOLUTION_CONFIDENCE } from "./symbol-types";

// ── Method index types ────────────────────────────────────────────────────────

interface TypeMethodSet {
  filePath: string;
  /** Methods directly defined on this type (receiver methods) */
  direct: Set<string>;
  /** Methods defined with pointer receiver (*T) */
  pointerMethods: Set<string>;
  /** Promoted methods from embedded types: method name -> owning type key */
  promoted: Map<string, string>;
}

interface InterfaceMethodSet {
  filePath: string;
  name: string;
  methods: Set<string>;
  /** F4: Only match exported interfaces for implicit satisfaction */
  isExported: boolean;
}

// ── Build Go type/method indexes ──────────────────────────────────────────────

/**
 * Build method sets for all Go types and collect interface definitions.
 * Returns both concrete type method sets and interface method sets.
 */
export function buildGoTypeIndex(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): {
  typeMethodSets: Map<string, TypeMethodSet>;
  interfaces: Map<string, InterfaceMethodSet>;
  embeddingMap: Map<string, Array<{ embeddedType: string; filePath: string }>>;
} {
  const typeMethodSets = new Map<string, TypeMethodSet>();
  const interfaces = new Map<string, InterfaceMethodSet>();
  const embeddingMap = new Map<string, Array<{ embeddedType: string; filePath: string }>>();

  // Pass 1: Collect direct methods per receiver type and interface method sets
  for (const [filePath, result] of fileGraphs) {
    for (const sym of result.symbols) {
      if (sym.kind === "method" && sym.receiverType) {
        const typeKey = `${filePath}::${sym.receiverType}`;
        let methodSet = typeMethodSets.get(typeKey);
        if (!methodSet) {
          methodSet = {
            filePath,
            direct: new Set(),
            pointerMethods: new Set(),
            promoted: new Map(),
          };
          typeMethodSets.set(typeKey, methodSet);
        }
        methodSet.direct.add(sym.name);
        // F4: Track whether this method has a pointer receiver
        if (sym.isPointerReceiver) {
          methodSet.pointerMethods.add(sym.name);
        }
      }

      if (sym.kind === "interface") {
        const ifaceKey = `${filePath}::${sym.name}`;
        const ifaceMethods = new Set<string>();

        const fileSymbols = symbolIndex.byFile.get(filePath) ?? [];
        for (const entry of fileSymbols) {
          if (
            entry.kind === "method" &&
            entry.startLine > sym.startLine &&
            sym.endLine !== undefined &&
            entry.startLine < sym.endLine
          ) {
            ifaceMethods.add(entry.name);
          }
        }

        interfaces.set(ifaceKey, {
          filePath,
          name: sym.name,
          methods: ifaceMethods,
          isExported: sym.isExported,
        });
      }
    }

    // Collect embeddings
    for (const emb of result.embeddings) {
      const structKey = `${filePath}::${emb.structName}`;
      let embList = embeddingMap.get(structKey);
      if (!embList) {
        embList = [];
        embeddingMap.set(structKey, embList);
      }

      // Resolve embedded type to its file
      const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();
      const binding = importMap.get(emb.embeddedType);
      if (binding) {
        embList.push({
          embeddedType: `${binding.sourceFile}::${emb.embeddedType}`,
          filePath: binding.sourceFile,
        });
      } else {
        // Same-file type
        const entries = symbolIndex.byFileAndName.get(`${filePath}::${emb.embeddedType}`);
        if (entries && entries.length > 0) {
          embList.push({
            embeddedType: `${filePath}::${emb.embeddedType}`,
            filePath,
          });
        }
      }
    }
  }

  return { typeMethodSets, interfaces, embeddingMap };
}

// ── Method promotion via embedding ────────────────────────────────────────────

/**
 * Compute promoted methods for a struct by following embedding chains.
 * Transitive up to depth 3. Ambiguous promotions (same method from multiple
 * embedded types) are removed.
 */
export function computePromotedMethods(
  structKey: string,
  embeddingMap: Map<string, Array<{ embeddedType: string; filePath: string }>>,
  typeMethodSets: Map<string, TypeMethodSet>,
  depth = 0,
  visited = new Set<string>(),
): Map<string, string> {
  const promoted = new Map<string, string>();
  if (depth > 3 || visited.has(structKey)) return promoted;
  visited.add(structKey);

  const embeddings = embeddingMap.get(structKey);
  if (!embeddings) return promoted;

  const ambiguous = new Set<string>();

  for (const { embeddedType } of embeddings) {
    // Direct methods of the embedded type
    const methodSet = typeMethodSets.get(embeddedType);
    if (methodSet) {
      for (const method of methodSet.direct) {
        if (promoted.has(method)) {
          ambiguous.add(method);
        } else {
          promoted.set(method, embeddedType);
        }
      }
    }

    // Transitive: promoted methods from the embedded type's own embeddings
    const transitive = computePromotedMethods(embeddedType, embeddingMap, typeMethodSets, depth + 1, visited);
    for (const [method, owner] of transitive) {
      if (promoted.has(method)) {
        ambiguous.add(method);
      } else {
        promoted.set(method, owner);
      }
    }
  }

  // Remove ambiguous methods (Go compiler would reject these)
  for (const method of ambiguous) {
    promoted.delete(method);
  }

  return promoted;
}

// ── Implicit interface satisfaction ───────────────────────────────────────────

/**
 * [Hejlsberg] Find all interfaces that a concrete type implicitly satisfies (RFC §2.13).
 * Distinguishes value (T) vs pointer (*T) method sets for compiler-accurate satisfaction.
 *
 * Go spec:
 *   - Method set of T  = value-receiver methods only
 *   - Method set of *T = value-receiver + pointer-receiver methods
 *
 * Returns receiverKind: "value" when T alone satisfies (both T and *T work),
 * "pointer" when only *T satisfies (requires pointer receiver).
 */
export function findSatisfiedInterfaces(
  typeKey: string,
  typeMethodSets: Map<string, TypeMethodSet>,
  embeddingMap: Map<string, Array<{ embeddedType: string; filePath: string }>>,
  interfaces: Map<string, InterfaceMethodSet>,
): Array<{ interfaceKey: string; filePath: string; name: string; receiverKind: "value" | "pointer" }> {
  const methodSet = typeMethodSets.get(typeKey);
  if (!methodSet) return [];

  const promoted = computePromotedMethods(typeKey, embeddingMap, typeMethodSets);

  // [Hejlsberg] Build separate method sets for T (value) and *T (pointer)
  // Value method set: only value-receiver direct methods + promoted methods
  const valueMethods = new Set<string>();
  for (const method of methodSet.direct) {
    if (!methodSet.pointerMethods.has(method)) {
      valueMethods.add(method);
    }
  }
  for (const method of promoted.keys()) {
    valueMethods.add(method);
  }

  // Pointer method set: all direct methods (value + pointer) + promoted
  const pointerMethods = new Set(methodSet.direct);
  for (const method of promoted.keys()) {
    pointerMethods.add(method);
  }

  if (pointerMethods.size === 0) return [];

  const satisfied: Array<{
    interfaceKey: string;
    filePath: string;
    name: string;
    receiverKind: "value" | "pointer";
  }> = [];

  for (const [ifaceKey, iface] of interfaces) {
    if (iface.methods.size === 0) continue;
    if (ifaceKey === typeKey) continue;
    if (!iface.isExported) continue;

    // Check if *T satisfies (pointer method set = value + pointer receivers)
    let pointerSatisfies = true;
    for (const method of iface.methods) {
      if (!pointerMethods.has(method)) {
        pointerSatisfies = false;
        break;
      }
    }
    if (!pointerSatisfies) continue;

    // Check if T alone satisfies (value method set = value receivers only)
    let valueSatisfies = true;
    for (const method of iface.methods) {
      if (!valueMethods.has(method)) {
        valueSatisfies = false;
        break;
      }
    }

    satisfied.push({
      interfaceKey: ifaceKey,
      filePath: iface.filePath,
      name: iface.name,
      receiverKind: valueSatisfies ? "value" : "pointer",
    });
  }

  return satisfied;
}

// ── Resolve all Go structural edges ──────────────────────────────────────────

/**
 * Generate embeds and satisfies edges for Go files.
 * Called from the main resolution pipeline.
 */
export function resolveGoStructuralEdges(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): { edges: ResolvedSymbolEdge[]; semanticEdges: SemanticEdge[] } {
  const { typeMethodSets, interfaces, embeddingMap } = buildGoTypeIndex(fileGraphs, symbolIndex, importMaps);
  const edges: ResolvedSymbolEdge[] = [];
  const semanticEdges: SemanticEdge[] = [];

  // Embeds edges: struct -> embedded type
  for (const [filePath, result] of fileGraphs) {
    for (const emb of result.embeddings) {
      const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();
      const binding = importMap.get(emb.embeddedType);
      const targetFile = binding?.sourceFile ?? filePath;

      // Only create edge if the target symbol exists
      const entries = symbolIndex.byFileAndName.get(`${targetFile}::${emb.embeddedType}`);
      if (entries && entries.length > 0) {
        edges.push({
          fromFile: filePath,
          fromSymbol: emb.structName,
          toFile: targetFile,
          toSymbol: emb.embeddedType,
          kind: "embeds",
          line: emb.line,
          confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
        });
      }
    }
  }

  // Satisfies edges: concrete type -> interface
  for (const [typeKey] of typeMethodSets) {
    const sepIdx = typeKey.indexOf("::");
    if (sepIdx === -1) continue;
    const typeFile = typeKey.slice(0, sepIdx);
    const typeName = typeKey.slice(sepIdx + 2);

    const satisfied = findSatisfiedInterfaces(typeKey, typeMethodSets, embeddingMap, interfaces);
    for (const iface of satisfied) {
      // [Hejlsberg] Value-receiver satisfaction (T and *T both work) gets direct confidence.
      // Pointer-only satisfaction (*T required) gets member-tier confidence (0.9) since
      // the concrete variable type (T vs *T) cannot be determined from static analysis alone.
      const confidence =
        iface.receiverKind === "value" ? RESOLUTION_CONFIDENCE.TIER_1_DIRECT : RESOLUTION_CONFIDENCE.TIER_2_MEMBER;
      edges.push({
        fromFile: typeFile,
        fromSymbol: typeName,
        toFile: iface.filePath,
        toSymbol: iface.name,
        kind: "satisfies",
        line: 0,
        confidence,
      });

      // Audit Shift 3: Emit semantic edge with T vs *T distinction
      semanticEdges.push({
        fromFile: typeFile,
        fromSymbol: typeName,
        toFile: iface.filePath,
        toSymbol: iface.name,
        kind: iface.receiverKind === "pointer" ? "go:implicit_iface_pointer_only" : "go:implicit_iface",
        line: 0,
        confidence,
        reason:
          iface.receiverKind === "pointer"
            ? `${typeName} implicitly satisfies ${iface.name} via *${typeName} only (pointer receiver methods required)`
            : `${typeName} implicitly satisfies ${iface.name} (value and pointer receivers both work)`,
      });
    }
  }

  // Compute promoted methods for all structs
  for (const [structKey, methodSet] of typeMethodSets) {
    const promoted = computePromotedMethods(structKey, embeddingMap, typeMethodSets);
    methodSet.promoted = promoted;
  }

  // Resolve call sites through promoted methods (RFC §2.13 AC1):
  // For obj.Method() where obj is a struct with promoted Method from an embedded type,
  // create a call edge from the caller to the embedded type's method.
  // Build a map: typeName -> promoted method -> owning type key for quick lookup
  const promotedLookup = new Map<string, Map<string, { ownerKey: string; ownerFile: string; ownerType: string }>>();
  for (const [typeKey, methodSet] of typeMethodSets) {
    const sepIdx = typeKey.indexOf("::");
    if (sepIdx === -1) continue;
    const typeName = typeKey.slice(sepIdx + 2);
    for (const [method, ownerKey] of methodSet.promoted) {
      const ownerSep = ownerKey.indexOf("::");
      if (ownerSep === -1) continue;
      let lookup = promotedLookup.get(typeName);
      if (!lookup) {
        lookup = new Map();
        promotedLookup.set(typeName, lookup);
      }
      lookup.set(method, {
        ownerKey,
        ownerFile: ownerKey.slice(0, ownerSep),
        ownerType: ownerKey.slice(ownerSep + 2),
      });
    }
  }

  // Walk call sites and check if any member expression matches a promoted method
  for (const [filePath, result] of fileGraphs) {
    for (const callSite of result.callSites) {
      if (!callSite.isMemberExpression || !callSite.objectName) continue;

      // Check if objectName matches a type with promoted methods
      const promoted = promotedLookup.get(callSite.objectName);
      if (!promoted) continue;

      const owner = promoted.get(callSite.calleeName);
      if (!owner) continue;

      // Verify the method symbol exists
      const targetEntries = symbolIndex.byFileAndName.get(`${owner.ownerFile}::${callSite.calleeName}`);
      if (targetEntries && targetEntries.length > 0) {
        edges.push({
          fromFile: filePath,
          fromSymbol: callSite.callerFn ?? "",
          toFile: owner.ownerFile,
          toSymbol: callSite.calleeName,
          kind: "calls",
          line: callSite.line,
          confidence: RESOLUTION_CONFIDENCE.TIER_2_MEMBER,
        });
      }
    }
  }

  return { edges, semanticEdges };
}
