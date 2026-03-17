/**
 * Python descriptor ghost edge detector.
 *
 * Finds descriptor classes (containing __get__/__set__ methods) and
 * class-level assignments that instantiate them. Emits ghost:descriptor
 * edges from the using class to the descriptor class.
 */

import type { FileGraphResult } from "../graph/symbol-types";
import type { SymbolIndex } from "../graph/symbol-resolution";
import type { ImportBinding } from "../graph/symbol-resolution";
import type { GhostEdgeCandidate } from "../graph/ghost-types";
import { GHOST_CONFIDENCE } from "../graph/ghost-types";

/**
 * Detect Python descriptor edges.
 *
 * Descriptor classes: classes containing __get__ or __set__ methods.
 * Usage: constructorAssignments where className matches a descriptor class
 * and callerFn is undefined (module-level) or at class body scope.
 */
export function detectPythonDescriptorEdges(
  fileGraphResults: Map<string, FileGraphResult>,
  _symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): GhostEdgeCandidate[] {
  const candidates: GhostEdgeCandidate[] = [];

  // Phase 1: Find all descriptor classes across the codebase
  const descriptorClasses = new Set<string>();
  const descriptorFiles = new Map<string, string>(); // className -> filePath

  for (const [filePath, result] of fileGraphResults) {
    for (const sym of result.symbols) {
      if (sym.kind !== "class") continue;
      const classEnd = sym.endLine ?? Number.MAX_SAFE_INTEGER;

      // Check if any method within this class is __get__ or __set__
      for (const method of result.symbols) {
        if (method.kind !== "method" && method.kind !== "function") continue;
        if (method.name !== "__get__" && method.name !== "__set__") continue;
        if (method.startLine < sym.startLine || method.startLine > classEnd) continue;

        descriptorClasses.add(sym.name);
        descriptorFiles.set(sym.name, filePath);
        break;
      }
    }
  }

  if (descriptorClasses.size === 0) return candidates;

  // Phase 2: Find constructor assignments that instantiate descriptor classes
  for (const [filePath, result] of fileGraphResults) {
    const imports = importMaps.get(filePath);

    for (const assignment of result.constructorAssignments) {
      // Check if className is a known descriptor (local or imported)
      let descFile: string | undefined;

      if (descriptorClasses.has(assignment.className) && descriptorFiles.get(assignment.className) === filePath) {
        // Local descriptor class
        descFile = filePath;
      } else if (imports) {
        // Imported descriptor class
        const binding = imports.get(assignment.className);
        if (binding && descriptorClasses.has(assignment.className)) {
          descFile = binding.sourceFile;
        }
      }

      if (!descFile) continue;

      // Determine the using symbol (the class that owns the descriptor assignment)
      // callerFn undefined = module-level, otherwise it's the enclosing scope
      const usingSymbol = assignment.callerFn ?? assignment.variableName;

      candidates.push({
        fromFile: filePath,
        fromSymbol: usingSymbol,
        toFile: descFile,
        toSymbol: assignment.className,
        kind: "ghost:descriptor",
        confidence: GHOST_CONFIDENCE,
        line: assignment.line,
        evidence: {
          pattern: "python_descriptor_assignment",
          trigger: `${assignment.variableName} = ${assignment.className}()`,
        },
      });
    }
  }

  return candidates;
}
