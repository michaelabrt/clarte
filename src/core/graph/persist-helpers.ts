/**
 * Helper functions for graph persistence.
 * Extracted to avoid circular dependencies between persist.ts and other modules.
 */

/**
 * Compute per-symbol authority from cross-file imports + intra-file callers.
 * Uses weighted in-degree (not HITS): type-only edges at 0.3x, intra-file callers at 0.3x.
 * Normalized per-file to [0, 1] using max.
 */
export function computeSymbolAuthority(
  edges: Array<{ from: string; to: string; importedNames: string[]; isTypeOnly?: boolean }>,
  files: Record<string, { symbolNames?: string[] }>,
  intraFileCalls: Map<string, Array<{ caller: string; callee: string }>>,
): Map<string, Record<string, number>> {
  const counts = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    const targetSymbols = files[edge.to]?.symbolNames;
    if (!targetSymbols) continue;
    const targetSet = new Set(targetSymbols);
    const weight = edge.isTypeOnly ? 0.3 : 1;
    for (const name of edge.importedNames) {
      if (!targetSet.has(name)) continue;
      let m = counts.get(edge.to);
      if (!m) {
        m = new Map();
        counts.set(edge.to, m);
      }
      m.set(name, (m.get(name) || 0) + weight);
    }
  }

  for (const [file, calls] of intraFileCalls) {
    let m = counts.get(file);
    if (!m) {
      m = new Map();
      counts.set(file, m);
    }
    for (const { callee } of calls) {
      m.set(callee, (m.get(callee) || 0) + 0.3);
    }
  }

  const result = new Map<string, Record<string, number>>();
  for (const [file, symbolCounts] of counts) {
    const maxCount = Math.max(...symbolCounts.values(), 1);
    const normalized: Record<string, number> = Object.create(null);
    for (const [sym, count] of symbolCounts) {
      normalized[sym] = Math.round((count / maxCount) * 1000) / 1000;
    }
    result.set(file, normalized);
  }
  return result;
}
