/**
 * RFC-002 Phase 5: Rust trait bound ghost edge detector.
 *
 * Scans impl blocks for trait implementations. Links the target type
 * to the trait definition in the symbol graph, skipping stdlib traits.
 */

import type { FileGraphResult } from "../graph/symbol-types";
import type { SymbolIndex } from "../graph/symbol-resolution";
import type { GhostEdgeCandidate } from "../graph/ghost-types";
import { GHOST_CONFIDENCE } from "../graph/ghost-types";

/** Common Rust stdlib traits to exclude (too noisy) */
const STDLIB_TRAITS = new Set([
  "Clone",
  "Copy",
  "Debug",
  "Default",
  "Display",
  "Drop",
  "Eq",
  "PartialEq",
  "Ord",
  "PartialOrd",
  "Hash",
  "Send",
  "Sync",
  "Unpin",
  "Sized",
  "From",
  "Into",
  "TryFrom",
  "TryInto",
  "AsRef",
  "AsMut",
  "Borrow",
  "BorrowMut",
  "Iterator",
  "IntoIterator",
  "FromIterator",
  "Add",
  "Sub",
  "Mul",
  "Div",
  "Rem",
  "Neg",
  "Deref",
  "DerefMut",
  "Index",
  "IndexMut",
  "Fn",
  "FnMut",
  "FnOnce",
]);

/**
 * Detect Rust trait bound edges from impl blocks.
 *
 * For each `impl TraitName for TargetType`, emits ghost:trait_bound
 * from the target type to the trait, skipping stdlib traits.
 */
export function detectRustTraitBoundEdges(
  fileGraphResults: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
): GhostEdgeCandidate[] {
  const candidates: GhostEdgeCandidate[] = [];

  for (const [filePath, result] of fileGraphResults) {
    for (const impl of result.implBlocks) {
      if (!impl.traitName) continue;
      if (STDLIB_TRAITS.has(impl.traitName)) continue;

      // Look up the trait in the symbol index (scan all files for trait kind)
      let traitFile: string | undefined;
      let traitName: string | undefined;

      for (const [fp, entries] of symbolIndex.byFile) {
        for (const entry of entries) {
          if (entry.kind === "trait" && entry.name === impl.traitName) {
            traitFile = fp;
            traitName = entry.name;
            break;
          }
        }
        if (traitFile) break;
      }

      if (!traitFile || !traitName) continue;

      // Find the target type symbol in the current file
      const targetKey = `${filePath}::${impl.targetType}`;
      const targetEntries = symbolIndex.byFileAndName.get(targetKey);
      if (!targetEntries || targetEntries.length === 0) continue;

      candidates.push({
        fromFile: filePath,
        fromSymbol: impl.targetType,
        toFile: traitFile,
        toSymbol: traitName,
        kind: "ghost:trait_bound",
        confidence: GHOST_CONFIDENCE,
        line: targetEntries[0].startLine,
        evidence: {
          pattern: "impl_trait_bound",
          trigger: `impl ${impl.traitName} for ${impl.targetType}`,
        },
      });
    }
  }

  return candidates;
}
