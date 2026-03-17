import { buildReverseAdjacency, getFileGraphData, type FileGraphData } from "../../core/graph/data";
import type { PersistedGraph } from "../../core/types/persisted-graph";
import { buildFileDirectiveMap } from "../context/directive-scope";

export const BETWEENNESS_THRESHOLD = 0.1;
const MAX_DIRECTIVES_PER_FILE = 2;

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
export function formatFileContext(data: FileGraphData, enriched?: boolean, fileDirectives?: string[]): string {
  const lines: string[] = [];

  lines.push(`role: ${data.role} | betweenness: ${pct(data.betweenness)}`);

  if (data.isChokepoint) {
    lines.push(`chokepoint: ${data.separatesComponents} files depend through it`);
  }

  if (enriched && data.instability != null && data.instability >= 0.6) {
    lines.push(`instability: ${pct(data.instability)}`);
  }

  if (enriched && data.layers.length > 0) {
    lines.push(`layers: ${data.layers.join(", ")}`);
  }

  if (enriched && data.tightCouplingPartners.length > 0) {
    const partners = data.tightCouplingPartners.map((p) => `${p.file} (${p.importedNames} names)`);
    lines.push(`tight-coupling: ${partners.join(" | ")}`);
  }

  if (data.coChange.length > 0) {
    const pairs = data.coChange.map((c) => `${c.file} (${pct(c.confidence)})`);
    lines.push(`cochange: ${pairs.join(" | ")}`);
  }

  if (data.integrationTests.length > 0) {
    lines.push(`tests: ${data.integrationTests.join(" | ")}`);
  }

  if (enriched && fileDirectives && fileDirectives.length > 0) {
    for (const d of fileDirectives.slice(0, MAX_DIRECTIVES_PER_FILE)) {
      lines.push(`directive: ${d}`);
    }
  }

  return lines.join("\n");
}

/**
 * Build a map of file paths to compact context strings.
 * Only files with meaningful graph data get an entry (no noise injection).
 * When enriched=true, includes instability, layers, tight coupling and directives.
 */
export function buildContextMap(
  graph: PersistedGraph,
  enriched?: boolean,
  directives?: string[],
): Record<string, string> {
  const reverseAdj = buildReverseAdjacency(graph);
  const directiveMap = enriched && directives ? buildFileDirectiveMap(directives) : undefined;
  const result: Record<string, string> = {};

  for (const filePath of Object.keys(graph.files)) {
    const data = getFileGraphData(graph, filePath, reverseAdj);
    if (!data || !isSignificantFile(data)) continue;
    const fileDirectives = directiveMap?.get(filePath);
    result[filePath] = formatFileContext(data, enriched, fileDirectives);
  }

  return result;
}
