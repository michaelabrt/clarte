/**
 * Python C3 linearization for MRO-aware method resolution (RFC §2.12).
 *
 * Given a class hierarchy extracted from Python AST, computes the Method
 * Resolution Order using the C3 linearization algorithm. Used to resolve
 * method calls on classes with multiple inheritance and super() chains.
 */

import type { ImportBinding, SymbolIndex } from "./symbol-resolution";
import type { FileGraphResult, ResolvedSymbolEdge } from "./symbol-types";
import { RESOLUTION_CONFIDENCE } from "./symbol-types";

// ── Class hierarchy types ─────────────────────────────────────────────────────

interface ClassInfo {
  filePath: string;
  name: string;
  /** Resolved base class keys ("filePath::className") in declaration order */
  bases: string[];
}

// ── Build class hierarchy ─────────────────────────────────────────────────────

/**
 * Build a class hierarchy map from all Python file graph results.
 * Keys are "filePath::className". Bases are resolved via import maps.
 */
export function buildPythonClassHierarchy(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): Map<string, ClassInfo> {
  const hierarchy = new Map<string, ClassInfo>();

  for (const [filePath, result] of fileGraphs) {
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();

    for (const sym of result.symbols) {
      if (sym.kind !== "class" || !sym.bases || sym.bases.length === 0) continue;

      const key = `${filePath}::${sym.name}`;
      const resolvedBases: string[] = [];

      for (const baseName of sym.bases) {
        const binding = importMap.get(baseName);
        if (binding) {
          // Imported base: resolve to source file
          const entries = symbolIndex.byFileAndName.get(`${binding.sourceFile}::${baseName}`);
          if (entries && entries.length > 0) {
            resolvedBases.push(`${binding.sourceFile}::${baseName}`);
            continue;
          }
        }

        // Same-file base
        const sameFileEntries = symbolIndex.byFileAndName.get(`${filePath}::${baseName}`);
        if (sameFileEntries && sameFileEntries.length > 0) {
          resolvedBases.push(`${filePath}::${baseName}`);
        }
        // Else: external or unresolvable base — treated as opaque terminal node
      }

      hierarchy.set(key, { filePath, name: sym.name, bases: resolvedBases });
    }
  }

  return hierarchy;
}

// ── C3 linearization ──────────────────────────────────────────────────────────

/**
 * Compute C3 linearization for a class.
 * Returns the MRO as an array of "filePath::className" keys, or null
 * if the MRO is inconsistent (which cannot happen in valid Python).
 *
 * Results are memoized to avoid recomputation for shared base classes.
 */
export function c3Linearize(
  classKey: string,
  hierarchy: Map<string, ClassInfo>,
  memo: Map<string, string[] | null> = new Map(),
): string[] | null {
  const cached = memo.get(classKey);
  if (cached !== undefined) return cached;

  const info = hierarchy.get(classKey);
  if (!info) {
    // Opaque external class: terminal node in the hierarchy
    const result = [classKey];
    memo.set(classKey, result);
    return result;
  }

  if (info.bases.length === 0) {
    const result = [classKey];
    memo.set(classKey, result);
    return result;
  }

  // Guard against cycles: mark as "in progress" with null
  memo.set(classKey, null);

  // L[C] = C + merge(L[B1], L[B2], ..., L[Bn], [B1, B2, ..., Bn])
  const parentMROs: string[][] = [];
  for (const base of info.bases) {
    const baseMRO = c3Linearize(base, hierarchy, memo);
    if (!baseMRO) {
      memo.set(classKey, null);
      return null; // cycle or inconsistent
    }
    parentMROs.push([...baseMRO]);
  }
  parentMROs.push([...info.bases]);

  const result = [classKey];

  while (parentMROs.some((l) => l.length > 0)) {
    let found = false;
    for (const list of parentMROs) {
      if (list.length === 0) continue;
      const head = list[0];
      // head is good if it does not appear in the tail (index > 0) of any other list
      const inTail = parentMROs.some((other) => other.indexOf(head) > 0);
      if (!inTail) {
        result.push(head);
        for (const l of parentMROs) {
          const idx = l.indexOf(head);
          if (idx !== -1) l.splice(idx, 1);
        }
        found = true;
        break;
      }
    }
    if (!found) {
      // Inconsistent MRO — cannot happen in valid Python
      memo.set(classKey, null);
      return null;
    }
  }

  memo.set(classKey, result);
  return result;
}

// ── MRO-aware method resolution ───────────────────────────────────────────────

/**
 * Resolve a Python method call using the class's MRO.
 * Walks the MRO in order; the first class defining the method wins.
 */
export function resolvePythonMethod(
  classKey: string,
  methodName: string,
  hierarchy: Map<string, ClassInfo>,
  symbolIndex: SymbolIndex,
  mroMemo: Map<string, string[] | null>,
): { filePath: string; symbolName: string } | null {
  const mro = c3Linearize(classKey, hierarchy, mroMemo);
  if (!mro) return null;

  for (const key of mro) {
    const sepIdx = key.indexOf("::");
    if (sepIdx === -1) continue;
    const filePath = key.slice(0, sepIdx);

    const entries = symbolIndex.byFileAndName.get(`${filePath}::${methodName}`);
    if (entries?.some((e) => e.kind === "method" || e.kind === "function")) {
      return { filePath, symbolName: methodName };
    }
  }

  return null;
}

/**
 * Resolve a super().method() call inside a class.
 * Finds the calling class in the MRO, then starts resolution from the next class.
 */
export function resolvePythonSuper(
  callingClassKey: string,
  methodName: string,
  hierarchy: Map<string, ClassInfo>,
  symbolIndex: SymbolIndex,
  mroMemo: Map<string, string[] | null>,
): { filePath: string; symbolName: string } | null {
  const mro = c3Linearize(callingClassKey, hierarchy, mroMemo);
  if (!mro) return null;

  // Find the calling class in the MRO, start from the next one
  const idx = mro.indexOf(callingClassKey);
  if (idx === -1 || idx >= mro.length - 1) return null;

  for (let i = idx + 1; i < mro.length; i++) {
    const key = mro[i];
    const sepIdx = key.indexOf("::");
    if (sepIdx === -1) continue;
    const filePath = key.slice(0, sepIdx);

    const entries = symbolIndex.byFileAndName.get(`${filePath}::${methodName}`);
    if (entries?.some((e) => e.kind === "method" || e.kind === "function")) {
      return { filePath, symbolName: methodName };
    }
  }

  return null;
}

// ── Resolve all Python MRO edges ──────────────────────────────────────────────

/**
 * [Hejlsberg] Generate resolved symbol edges for Python MRO-dependent call sites
 * and metaclass relationships (RFC §2.12).
 * Metaclass edges use "uses_type" to prevent false-positives in C3 linearization
 * while preserving the dependency link for impact analysis.
 */
export function resolvePythonMROEdges(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): ResolvedSymbolEdge[] {
  // [Hejlsberg] Generate metaclass edges independently of MRO hierarchy
  const metaclassEdges = resolveMetaclassEdges(fileGraphs, symbolIndex, importMaps);

  const hierarchy = buildPythonClassHierarchy(fileGraphs, symbolIndex, importMaps);
  if (hierarchy.size === 0) return metaclassEdges;

  const mroMemo = new Map<string, string[] | null>();
  const edges: ResolvedSymbolEdge[] = [...metaclassEdges];

  // Build a map of class names to their hierarchy keys per file
  const classKeysByFile = new Map<string, Map<string, string>>();
  for (const [key, info] of hierarchy) {
    let fileMap = classKeysByFile.get(info.filePath);
    if (!fileMap) {
      fileMap = new Map();
      classKeysByFile.set(info.filePath, fileMap);
    }
    fileMap.set(info.name, key);
  }

  // Build constructor-like bindings: variable -> class key
  // Python uses obj = ClassName() without `new`, captured in constructorAssignments
  const varTypesByFile = new Map<string, Map<string, string>>();
  for (const [filePath, result] of fileGraphs) {
    const varTypes = new Map<string, string>();
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();
    for (const assignment of result.constructorAssignments) {
      // Resolve the class to a hierarchy key
      const binding = importMap.get(assignment.className);
      const classFile = binding?.sourceFile ?? filePath;
      const classKey = `${classFile}::${assignment.className}`;
      if (hierarchy.has(classKey)) {
        const scopeKey = assignment.callerFn
          ? `${assignment.callerFn}::${assignment.variableName}`
          : assignment.variableName;
        varTypes.set(scopeKey, classKey);
        if (!assignment.callerFn) {
          varTypes.set(assignment.variableName, classKey);
        }
      }
    }
    if (varTypes.size > 0) varTypesByFile.set(filePath, varTypes);
  }

  for (const [filePath, result] of fileGraphs) {
    for (const callSite of result.callSites) {
      // Case 1: super().method() -> MRO-based resolution
      if (callSite.isSuperCall && callSite.callerFn) {
        const enclosingClass = findEnclosingClass(result, callSite.callerFn);
        if (!enclosingClass) continue;

        const fileMap = classKeysByFile.get(filePath);
        const classKey = fileMap?.get(enclosingClass);
        if (!classKey) continue;

        const resolved = resolvePythonSuper(classKey, callSite.calleeName, hierarchy, symbolIndex, mroMemo);
        if (resolved) {
          edges.push({
            fromFile: filePath,
            fromSymbol: callSite.callerFn,
            toFile: resolved.filePath,
            toSymbol: resolved.symbolName,
            kind: "calls",
            line: callSite.line,
            confidence: RESOLUTION_CONFIDENCE.TIER_3_NEW,
          });
        }
        continue;
      }

      // Case 2: obj.method() where obj is a known instance of a multi-base class
      if (callSite.isMemberExpression && callSite.objectName) {
        const varTypes = varTypesByFile.get(filePath);
        if (!varTypes) continue;

        const scopedKey = callSite.callerFn ? `${callSite.callerFn}::${callSite.objectName}` : callSite.objectName;
        const classKey = varTypes.get(scopedKey) ?? varTypes.get(callSite.objectName);
        if (!classKey) continue;

        const resolved = resolvePythonMethod(classKey, callSite.calleeName, hierarchy, symbolIndex, mroMemo);
        if (resolved) {
          edges.push({
            fromFile: filePath,
            fromSymbol: callSite.callerFn ?? "",
            toFile: resolved.filePath,
            toSymbol: resolved.symbolName,
            kind: "calls",
            line: callSite.line,
            confidence: RESOLUTION_CONFIDENCE.TIER_3_NEW,
          });
        }
      }
    }
  }

  return edges;
}

/**
 * Find the class that contains a given method name in a file's symbols.
 */
function findEnclosingClass(result: FileGraphResult, methodName: string): string | null {
  const methodSym = result.symbols.find((s) => s.name === methodName && s.kind === "method");
  if (!methodSym) return null;

  for (const sym of result.symbols) {
    if (sym.kind !== "class") continue;
    if (sym.startLine <= methodSym.startLine && sym.endLine && sym.endLine >= methodSym.startLine) {
      return sym.name;
    }
  }

  return null;
}

// ── Metaclass edge resolution ──────────────────────────────────────────────

/**
 * [Hejlsberg] Generate "uses_type" edges for Python metaclass relationships (RFC §2.12).
 * Metaclass is NOT a base class for C3 linearization; it controls class creation behavior.
 * We emit a separate "uses_type" edge so that:
 *   - Impact analysis correctly flags classes when their metaclass changes
 *   - C3 linearization is not polluted by metaclass entries
 */
function resolveMetaclassEdges(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): ResolvedSymbolEdge[] {
  const edges: ResolvedSymbolEdge[] = [];

  for (const [filePath, result] of fileGraphs) {
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();

    for (const sym of result.symbols) {
      if (sym.kind !== "class" || !sym.metaclass) continue;

      const metaclassName = sym.metaclass;

      // Resolve metaclass via imports
      const binding = importMap.get(metaclassName);
      if (binding) {
        const entries = symbolIndex.byFileAndName.get(`${binding.sourceFile}::${metaclassName}`);
        if (entries && entries.length > 0) {
          edges.push({
            fromFile: filePath,
            fromSymbol: sym.name,
            toFile: binding.sourceFile,
            toSymbol: metaclassName,
            kind: "uses_type",
            line: sym.startLine,
            confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
          });
          continue;
        }
      }

      // Same-file metaclass
      const sameFileEntries = symbolIndex.byFileAndName.get(`${filePath}::${metaclassName}`);
      if (sameFileEntries && sameFileEntries.length > 0) {
        edges.push({
          fromFile: filePath,
          fromSymbol: sym.name,
          toFile: filePath,
          toSymbol: metaclassName,
          kind: "uses_type",
          line: sym.startLine,
          confidence: RESOLUTION_CONFIDENCE.TIER_1_DIRECT,
        });
      }
    }
  }

  return edges;
}
