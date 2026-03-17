/**
 * RFC-002 Phase 5: DI injection ghost edge detector.
 *
 * Scans decorator edges for DI markers (NestJS, Angular, Spring, Python)
 * and type usages for constructor parameter types. Emits ghost:di_inject
 * edges from the decorated class to its injected dependencies.
 */

import type { FileGraphResult } from "../graph/symbol-types";
import type { SymbolIndex } from "../graph/symbol-resolution";
import type { ImportBinding } from "../graph/symbol-resolution";
import type { GhostEdgeCandidate } from "../graph/ghost-types";
import { GHOST_CONFIDENCE } from "../graph/ghost-types";

const DI_DECORATORS = new Set([
  // TS/JS (NestJS, Angular)
  "Injectable",
  "Controller",
  "Module",
  "Component",
  "Service",
  // Python
  "inject",
  // Java/Spring
  "Inject",
  "Autowired",
  "Repository",
]);

/**
 * Detect DI injection edges from decorator + type usage analysis.
 *
 * For each class decorated with a DI marker, scan its type usages
 * for constructor parameter types. Resolve each type name via import maps
 * and emit ghost:di_inject if the target is a class or struct.
 */
export function detectDIEdges(
  fileGraphResults: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): GhostEdgeCandidate[] {
  const candidates: GhostEdgeCandidate[] = [];

  for (const [filePath, result] of fileGraphResults) {
    // Find DI-decorated symbols
    const diTargets = new Set<string>();
    for (const dec of result.decorators) {
      if (DI_DECORATORS.has(dec.decorator)) {
        diTargets.add(dec.target);
      }
    }
    if (diTargets.size === 0) continue;

    const imports = importMaps.get(filePath);
    if (!imports) continue;

    // For each DI-decorated class, resolve its type usages as injected deps
    for (const usage of result.typeUsages) {
      if (!diTargets.has(usage.symbolName)) continue;

      const binding = imports.get(usage.typeName);
      if (!binding) continue;

      // Look up target symbol in the source file
      const key = `${binding.sourceFile}::${usage.typeName}`;
      const entries = symbolIndex.byFileAndName.get(key);
      if (!entries || entries.length === 0) continue;

      // Only emit for class/struct targets (suppress interface targets)
      const target = entries[0];
      if (target.kind !== "class" && target.kind !== "struct") continue;

      candidates.push({
        fromFile: filePath,
        fromSymbol: usage.symbolName,
        toFile: binding.sourceFile,
        toSymbol: usage.typeName,
        kind: "ghost:di_inject",
        confidence: GHOST_CONFIDENCE,
        line: usage.line,
        evidence: {
          pattern: "di_constructor_inject",
          trigger: usage.symbolName,
        },
      });
    }
  }

  return candidates;
}
