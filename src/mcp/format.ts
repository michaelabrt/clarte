import type { PersistedGraph, FileRecord } from "../types/persisted-graph.js";
import type { CallSite, CallerIndex, FileCallIndex } from "../types/call-graph.js";

interface EdgeEntry {
  from: string;
  to: string;
  importedNames: string[];
}

const ROLE_LABELS: Record<string, string> = {
  Orchestrator: "Orchestrator",
  Foundation: "Foundation",
  Leaf: "Leaf",
};

function formatRole(record: FileRecord): string {
  const parts: string[] = [];
  if (record.role && ROLE_LABELS[record.role]) {
    parts.push(ROLE_LABELS[record.role]);
  }
  if (record.betweenness > 0) {
    parts.push(`BETWEENNESS: ${Math.round(record.betweenness * 100)}%`);
  }
  if (record.instability !== null) {
    parts.push(`INSTABILITY: ${record.instability.toFixed(2)}`);
  }
  return parts.join(" | ");
}

function getImporters(filePath: string, edgesByTarget: Map<string, EdgeEntry[]>): string[] {
  return (edgesByTarget.get(filePath) ?? []).map((e) => e.from);
}

function getDeps(filePath: string, edgesByFile: Map<string, EdgeEntry[]>): string[] {
  return (edgesByFile.get(filePath) ?? []).map((e) => e.to);
}

/**
 * Format a clarte_context response for a file.
 */
export function formatContext(
  filePath: string,
  graph: PersistedGraph,
  edgesByFile: Map<string, EdgeEntry[]>,
  edgesByTarget: Map<string, EdgeEntry[]>,
): string {
  const record = graph.files[filePath];
  if (!record) {
    return `${filePath}: not in graph (run clarte generate to update)`;
  }

  const lines: string[] = [`FILE: ${filePath}`];

  const roleStr = formatRole(record);
  if (roleStr) lines.push(`ROLE: ${roleStr}`);

  const importers = getImporters(filePath, edgesByTarget);
  if (importers.length > 0) {
    lines.push(`IMPORTERS (${importers.length}): ${importers.join(", ")}`);
  } else {
    lines.push("IMPORTERS: none");
  }

  const deps = getDeps(filePath, edgesByFile);
  if (deps.length > 0) {
    lines.push(`DEPS (${deps.length}): ${deps.join(", ")}`);
  } else {
    lines.push("DEPS: none");
  }

  const coChanges = graph.changeCoupling
    .filter((c) => c.fileA === filePath || c.fileB === filePath)
    .sort((a, b) => b.coChangeCount - a.coChangeCount)
    .slice(0, 5);

  if (coChanges.length > 0) {
    const parts = coChanges.map((c) => {
      const partner = c.fileA === filePath ? c.fileB : c.fileA;
      return `${partner} (${c.coChangeCount}x, ${Math.round(c.confidence * 100)}%)`;
    });
    lines.push(`CO-CHANGES: ${parts.join(" | ")}`);
  }

  const testFiles = record.testFiles ?? [];
  if (testFiles.length > 0) {
    lines.push(`TEST: ${testFiles.join(", ")}`);
  }

  return lines.join("\n");
}

/**
 * Format a clarte_function response for a named function.
 */
export function formatFunction(
  name: string,
  filePath: string | undefined,
  callerIndex: CallerIndex,
  fileCallIndex: FileCallIndex,
): string {
  // Find all callerIndex keys matching *::name or filePath::name
  const matchingKeys: string[] = [];
  const suffix = `::${name}`;
  for (const key of callerIndex.keys()) {
    if (key.endsWith(suffix)) {
      if (!filePath || key.startsWith(`${filePath}::`)) {
        matchingKeys.push(key);
      }
    }
  }

  const allCallers: CallSite[] = [];
  let inferredFile: string | undefined = filePath;
  for (const key of matchingKeys) {
    const sites = callerIndex.get(key) ?? [];
    allCallers.push(...sites);
    if (!inferredFile) {
      inferredFile = key.split("::")[0];
    }
  }

  // Determine display file
  const displayFile = inferredFile ?? filePath ?? "unknown";
  const lines: string[] = [`FUNCTION: ${name} (${displayFile})`];

  if (allCallers.length === 0) {
    lines.push(
      "CALLED BY: none (note: interface dispatch and higher-order calls may not be captured)",
    );
  } else {
    lines.push(`CALLED BY (${allCallers.length}):`);
    for (const site of allCallers.slice(0, 20)) {
      lines.push(`  ${site.caller}:${site.line}`);
    }
    if (allCallers.length > 20) {
      lines.push(`  ... (${allCallers.length - 20} more)`);
    }
  }

  // Find callees - need the file where this function is defined
  const targetFile = inferredFile;
  if (!targetFile) {
    lines.push(
      "CALLS: provide path= to see callees (function not found in caller index)",
    );
    return lines.join("\n");
  }

  const fileSites = fileCallIndex.get(targetFile) ?? [];
  const callees = fileSites.filter((s) => s.callerFn === name);

  if (callees.length === 0) {
    lines.push("CALLS: none");
  } else {
    // Deduplicate and sort by line
    const seen = new Set<string>();
    const unique: CallSite[] = [];
    for (const site of callees.sort((a, b) => a.line - b.line)) {
      const key = `${site.callee}::${site.calleeFile}::${site.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(site);
      }
    }
    lines.push(`CALLS (${unique.length}):`);
    for (const site of unique.slice(0, 20)) {
      lines.push(`  ${site.callee} (${site.calleeFile}:${site.line})`);
    }
    if (unique.length > 20) {
      lines.push(`  ... (${unique.length - 20} more)`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a clarte_search response.
 */
export function formatSearch(
  query: string,
  graph: PersistedGraph,
  edgesByTarget: Map<string, EdgeEntry[]>,
): string {
  const lowerQuery = query.toLowerCase();
  const tokens = lowerQuery.split(/\W+/).filter(Boolean);

  interface Match {
    file: string;
    score: number;
    names: string[];
  }

  const results: Match[] = [];

  for (const filePath of Object.keys(graph.files)) {
    let score = 0;

    // Score by file path match
    const lowerPath = filePath.toLowerCase();
    for (const token of tokens) {
      if (lowerPath.includes(token)) score += 2;
    }

    // Collect known names for this file (union of all importedNames across edges pointing at it)
    const incomingEdges = edgesByTarget.get(filePath) ?? [];
    const knownNames = new Set<string>();
    for (const edge of incomingEdges) {
      for (const n of edge.importedNames) {
        knownNames.add(n);
      }
    }

    const matchingNames: string[] = [];
    for (const n of knownNames) {
      const lowerName = n.toLowerCase();
      for (const token of tokens) {
        if (lowerName.includes(token)) {
          score += 3;
          matchingNames.push(n);
          break;
        }
      }
    }

    if (score > 0) {
      results.push({ file: filePath, score, names: [...new Set(matchingNames)].slice(0, 5) });
    }
  }

  results.sort((a, b) => b.score - a.score);
  const top = results.slice(0, 20);

  if (top.length === 0) {
    return `RESULTS for "${query}": no matches found`;
  }

  const lines = [`RESULTS for "${query}" (${top.length} matches):`];
  for (const r of top) {
    if (r.names.length > 0) {
      lines.push(`  ${r.file} - exports: ${r.names.join(", ")}`);
    } else {
      lines.push(`  ${r.file}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format a clarte_impact response for a file.
 */
export function formatImpact(
  filePath: string,
  graph: PersistedGraph,
  edgesByTarget: Map<string, EdgeEntry[]>,
  maxDepth?: number,
): string {
  const record = graph.files[filePath];
  if (!record) {
    return `${filePath}: not in graph (run clarte generate to update)`;
  }

  // BFS with hard cap of 50 nodes
  const HARD_CAP = 50;
  const visited = new Set<string>();
  const byDepth = new Map<number, string[]>();
  const queue: Array<{ file: string; depth: number }> = [{ file: filePath, depth: 0 }];

  visited.add(filePath);
  let capped = false;

  while (queue.length > 0 && visited.size - 1 < HARD_CAP) {
    const item = queue.shift()!;
    const { file, depth } = item;

    if (maxDepth !== undefined && depth >= maxDepth) continue;

    const importers = (edgesByTarget.get(file) ?? []).map((e) => e.from);
    for (const imp of importers) {
      if (visited.has(imp)) continue;
      if (visited.size - 1 >= HARD_CAP) {
        capped = true;
        break;
      }
      visited.add(imp);
      const d = depth + 1;
      if (!byDepth.has(d)) byDepth.set(d, []);
      byDepth.get(d)!.push(imp);
      queue.push({ file: imp, depth: d });
    }
    if (capped) break;
  }

  const totalDependents = visited.size - 1; // exclude the file itself

  const lines: string[] = [];

  let riskLevel: string;
  if (totalDependents <= 5) riskLevel = "LOW";
  else if (totalDependents <= 20) riskLevel = "MEDIUM";
  else if (totalDependents <= 50) riskLevel = "HIGH";
  else riskLevel = "CRITICAL";

  if (capped) {
    // Use importedByCount as a conservative lower-bound (comes from full graph, not capped BFS)
    const lowerBound = Math.max(record.importedByCount, totalDependents);
    lines.push(`RISK: CRITICAL - ${lowerBound}+ transitive dependents (showing first ${HARD_CAP})`);
  } else {
    lines.push(`RISK: ${riskLevel} - ${totalDependents} transitive dependent${totalDependents === 1 ? "" : "s"}`);
  }

  const depths = [...byDepth.keys()].sort((a, b) => a - b);
  for (const d of depths) {
    const files = byDepth.get(d) ?? [];
    const label = d === 1 ? "DIRECT" : `DEPTH ${d}`;
    const displayed = files.slice(0, 10);
    const rest = files.length - displayed.length;

    if (files.length > 0) {
      lines.push(`${label} (${files.length}):`);
      for (const f of displayed) {
        const fileRecord = graph.files[f];
        const notes: string[] = [];
        if (fileRecord?.isChokepoint) notes.push("chokepoint");
        if (fileRecord?.betweenness && fileRecord.betweenness > 0.5) {
          notes.push(`betweenness: ${Math.round(fileRecord.betweenness * 100)}%`);
        }
        lines.push(`  ${f}${notes.length > 0 ? ` (${notes.join(", ")})` : ""}`);
      }
      if (rest > 0) {
        lines.push(`  ... (${rest} more)`);
      }
    }
  }

  if (totalDependents === 0) {
    lines.push("No files depend on this file.");
  }

  return lines.join("\n");
}
