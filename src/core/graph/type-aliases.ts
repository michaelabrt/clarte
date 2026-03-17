/**
 * Type alias transparency for all languages (RFC §2.15).
 *
 * Follows type alias chains during symbol resolution so that methods
 * on aliased types resolve correctly. Max depth 5, cycle detection.
 *
 * Per-language alias syntax:
 * - TypeScript: type Foo = Bar (type_alias_declaration)
 * - Python: Foo: TypeAlias = Bar or type Foo = Bar (3.12+)
 * - Go: type Foo = Bar (alias with =) — NOT type Foo Bar (new type)
 * - Rust: type Foo = Bar<i32> (type_item)
 * - Java: no type aliases
 */

import type { ImportBinding, SymbolIndex } from "./symbol-resolution";
import type { FileGraphResult } from "./symbol-types";

// ── Alias map types ───────────────────────────────────────────────────────────

interface ResolvedAlias {
  name: string;
  /** Resolved target: "filePath::typeName" */
  targetKey: string;
  filePath: string;
}

// ── Build alias map ───────────────────────────────────────────────────────────

/**
 * Build a resolved alias map from all file graph results.
 * Keys are "filePath::aliasName", values point to the resolved target.
 * Only project-internal aliases pointing to project-internal types are included.
 */
export function buildAliasMap(
  fileGraphs: Map<string, FileGraphResult>,
  symbolIndex: SymbolIndex,
  importMaps: Map<string, Map<string, ImportBinding>>,
): Map<string, ResolvedAlias> {
  const aliasMap = new Map<string, ResolvedAlias>();

  for (const [filePath, result] of fileGraphs) {
    const importMap = importMaps.get(filePath) ?? new Map<string, ImportBinding>();

    for (const alias of result.typeAliases) {
      const key = `${filePath}::${alias.name}`;

      // Resolve the target
      const binding = importMap.get(alias.target);
      if (binding) {
        // Imported target
        const entries = symbolIndex.byFileAndName.get(`${binding.sourceFile}::${alias.target}`);
        if (entries && entries.length > 0) {
          aliasMap.set(key, {
            name: alias.name,
            targetKey: `${binding.sourceFile}::${alias.target}`,
            filePath,
          });
          continue;
        }
      }

      // Same-file target
      const sameFileEntries = symbolIndex.byFileAndName.get(`${filePath}::${alias.target}`);
      if (sameFileEntries && sameFileEntries.length > 0) {
        aliasMap.set(key, {
          name: alias.name,
          targetKey: `${filePath}::${alias.target}`,
          filePath,
        });
      }
      // Else: target is external (e.g., string, i64) — not followed
    }
  }

  return aliasMap;
}

// ── Alias chain following ─────────────────────────────────────────────────────

/**
 * Follow an alias chain to its concrete type.
 * Returns the final "filePath::typeName" key.
 * Max depth 5, cycle detection via visited set.
 */
export function resolveAliasChain(
  typeKey: string,
  aliasMap: Map<string, ResolvedAlias>,
  maxDepth = 5,
  visited = new Set<string>(),
): string {
  if (maxDepth <= 0 || visited.has(typeKey)) return typeKey;
  visited.add(typeKey);

  const alias = aliasMap.get(typeKey);
  if (!alias) return typeKey;

  return resolveAliasChain(alias.targetKey, aliasMap, maxDepth - 1, visited);
}

/**
 * Resolve a type name in a file, following aliases if the direct lookup fails.
 * Returns { filePath, typeName } of the concrete type, or null if unresolvable.
 */
export function resolveTypeWithAliases(
  filePath: string,
  typeName: string,
  aliasMap: Map<string, ResolvedAlias>,
  symbolIndex: SymbolIndex,
): { filePath: string; typeName: string } | null {
  const key = `${filePath}::${typeName}`;

  // Direct lookup first
  const directEntries = symbolIndex.byFileAndName.get(key);
  if (directEntries && directEntries.length > 0) {
    // Check if this is an alias
    const alias = aliasMap.get(key);
    if (alias) {
      // Follow the chain
      const resolvedKey = resolveAliasChain(key, aliasMap);
      const sepIdx = resolvedKey.indexOf("::");
      if (sepIdx !== -1) {
        const resolvedFile = resolvedKey.slice(0, sepIdx);
        const resolvedName = resolvedKey.slice(sepIdx + 2);
        const resolvedEntries = symbolIndex.byFileAndName.get(resolvedKey);
        if (resolvedEntries && resolvedEntries.length > 0) {
          return { filePath: resolvedFile, typeName: resolvedName };
        }
      }
    }
    return { filePath, typeName };
  }

  return null;
}
