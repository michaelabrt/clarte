import { buildReverseAdjacency, getFileGraphData, type FileGraphData } from "../graph/data.js";
import type { PersistedGraph } from "../graph/types.js";

export const BETWEENNESS_THRESHOLD = 0.1;

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/** Check whether a file's graph data crosses any significance threshold. */
export function isSignificantFile(data: FileGraphData): boolean {
  return (
    data.betweenness > BETWEENNESS_THRESHOLD ||
    data.isChokepoint ||
    data.coChange.length > 0 ||
    data.integrationTests.length > 0
  );
}

/** Format graph data for a single file as compact context lines. */
export function formatFileContext(data: FileGraphData): string {
  const lines: string[] = [];

  lines.push(`role: ${data.role} | betweenness: ${pct(data.betweenness)}`);

  if (data.isChokepoint) {
    lines.push(`chokepoint: separates ${data.separatesComponents} components`);
  }

  if (data.coChange.length > 0) {
    const pairs = data.coChange.map((c) => `${c.file} (${pct(c.confidence)})`);
    lines.push(`cochange: ${pairs.join(" | ")}`);
  }

  if (data.integrationTests.length > 0) {
    lines.push(`tests: ${data.integrationTests.join(" | ")}`);
  }

  return lines.join("\n");
}

/**
 * Build a map of file paths to compact context strings.
 * Only files with meaningful graph data get an entry (no noise injection).
 */
export function buildContextMap(graph: PersistedGraph): Record<string, string> {
  const reverseAdj = buildReverseAdjacency(graph);
  const result: Record<string, string> = {};

  for (const filePath of Object.keys(graph.files)) {
    const data = getFileGraphData(graph, filePath, reverseAdj);
    if (!data || !isSignificantFile(data)) continue;
    result[filePath] = formatFileContext(data);
  }

  return result;
}
