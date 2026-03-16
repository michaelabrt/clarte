import type { PersistedGraph } from "../core/types/persisted-graph.js";
import type { SymbolMatch } from "./targets-resolve.js";

/**
 * Render the task-context.md content from resolved targets and symbol rankings.
 * Pure function: given data, returns the markdown string.
 */
export function renderTaskContext(
  targets: string[],
  runnersUp: string[],
  graph: PersistedGraph,
  symbolRanking: Map<string, SymbolMatch[]>,
  lastModified?: Map<string, string>,
): string {
  const fileImporters = new Map<string, string[]>();
  const fileImports = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (!fileImporters.has(e.to)) fileImporters.set(e.to, []);
    fileImporters.get(e.to)?.push(e.from);
    if (!fileImports.has(e.from)) fileImports.set(e.from, []);
    fileImports.get(e.from)?.push(e.to);
  }

  const targetSet = new Set(targets);
  const lines: string[] = [
    "# Edit targets (clarte)",
    "",
    "Based on dependency graph analysis, these files are most likely to need editing.",
    "Key symbols are listed so you can navigate directly without a broad search.",
    "",
  ];

  for (let i = 0; i < targets.length; i++) {
    const fp = targets[i];
    const ageSuffix = lastModified?.get(fp) ? `, modified ${lastModified.get(fp)}` : "";
    lines.push(`## ${fp} [rank ${i + 1}${ageSuffix}]`);

    const topSyms = symbolRanking.get(fp) ?? [];
    const intraCalls = graph.files[fp]?.intraFileCalls ?? [];

    // Annotated display with caller/callee chains
    let symParts = topSyms.map((x) => (x.line ? `${x.name} (L${x.line})` : x.name));
    for (const [caller, callee] of intraCalls) {
      const ci = topSyms.findIndex((x) => x.name === caller);
      const di = topSyms.findIndex((x) => x.name === callee);
      if (ci >= 0 && di >= 0) {
        const c = topSyms[ci];
        const d = topSyms[di];
        const chain = `${c.name} (L${c.line}) -> ${d.name} (L${d.line})`;
        const rest = topSyms
          .filter((_, idx) => idx !== ci && idx !== di)
          .map((x) => (x.line ? `${x.name} (L${x.line})` : x.name));
        symParts = [chain, ...rest];
        break;
      }
    }

    if (symParts.length) lines.push(`Key symbols: ${symParts.join(", ")}`);

    // Relationship hints: connections to other target files
    const relatedImporters = (fileImporters.get(fp) ?? []).filter((f) => targetSet.has(f));
    const relatedImports = (fileImports.get(fp) ?? []).filter((f) => targetSet.has(f));
    if (relatedImporters.length) lines.push(`Imported by: ${relatedImporters.join(", ")}`);
    if (relatedImports.length) lines.push(`Imports from: ${relatedImports.join(", ")}`);

    // Test file paths from testMapping
    const tests = graph.testMapping[fp] ?? [];
    if (tests.length) {
      lines.push(`Tests: ${tests.slice(0, 3).join(", ")}`);
      lines.push("When writing tests, update these existing test files rather than creating new ones.");
    }
    lines.push("");
  }

  // Negative guidance: warn about runners-up with same basename as a target (decoys)
  if (runnersUp.length > 0) {
    const targetBasenames = new Set(targets.map((t) => t.split("/").pop()));
    const decoys = runnersUp.filter((r) => targetBasenames.has(r.split("/").pop()));
    if (decoys.length > 0) {
      lines.push("## Do NOT edit these files");
      lines.push("These scored similarly but are in different paths. They are likely not the right target:");
      for (const d of decoys) lines.push(`- ${d}`);
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Render a minimal task-context.md for the git-history fallback path.
 */
export function renderFallbackContext(files: string[], commitMessage: string): string {
  const fileList = files.map((f) => `- ${f}`).join("\n");
  return `# Edit targets (clarte)\n\nBased on past fixes to similar issues, these files are most likely to need editing:\n\n${fileList}\n\nMatched commit: ${commitMessage}\n`;
}
