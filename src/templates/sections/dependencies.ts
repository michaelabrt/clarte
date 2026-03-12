import type { ContextAnalysis, ContextSection } from "../../types.js";
import { estimateTokens } from "../../utils.js";
import { findFeedbackEdges } from "../../graph/cycles.js";
import { SECTION_LIMITS } from "../../config/thresholds.js";

export function renderDependencySections(analysis: ContextAnalysis): ContextSection[] {
  const sections: ContextSection[] = [];

  const circContent = renderCircularDepsContent(analysis);
  if (circContent) {
    sections.push({ id: "circular-deps", priority: 3, content: circContent, tokens: estimateTokens(circContent) });
  }

  const deadContent = renderDeadFilesContent(analysis);
  if (deadContent) {
    sections.push({ id: "dead-files", priority: 9, content: deadContent, tokens: estimateTokens(deadContent) });
  }

  const ccfContent = renderCrossCuttingContent(analysis);
  if (ccfContent) {
    sections.push({ id: "cross-cutting", priority: 9, content: ccfContent, tokens: estimateTokens(ccfContent) });
  }

  const cpContent = renderChokepointsContent(analysis);
  if (cpContent) {
    sections.push({ id: "chokepoints", priority: 9, content: cpContent, tokens: estimateTokens(cpContent) });
  }

  const tcContent = renderTightCouplingContent(analysis);
  if (tcContent) {
    sections.push({ id: "tight-coupling", priority: 10, content: tcContent, tokens: estimateTokens(tcContent) });
  }

  const smContent = renderHiddenCouplingContent(analysis);
  if (smContent) {
    sections.push({ id: "hidden-coupling", priority: 10, content: smContent, tokens: estimateTokens(smContent) });
  }

  return sections;
}

/** Render circular dependencies section content. */
export function renderCircularDepsContent(analysis: ContextAnalysis): string | null {
  if (!analysis.circularDeps || analysis.circularDeps.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Circular Dependencies");
  lines.push("");
  lines.push("> These circular import chains may cause unexpected behavior when modified.");
  lines.push("");
  for (const dep of analysis.circularDeps) {
    const severity =
      dep.severity != null ? (dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : "") : "";
    const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
    lines.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}${severity}${hint}`);
  }

  if (analysis.circularDeps.length > 1) {
    const feedbackEdges = findFeedbackEdges(analysis.circularDeps);
    if (feedbackEdges.length > 0) {
      lines.push("");
      lines.push("**Most impactful edges to break:**");
      for (const edge of feedbackEdges) {
        const shortFrom =
          edge.from
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? edge.from;
        const shortTo =
          edge.to
            .split("/")
            .pop()
            ?.replace(/\.[^.]+$/, "") ?? edge.to;
        lines.push(
          `- Breaking \`${shortFrom}\` -> \`${shortTo}\` would resolve ${edge.cyclesResolved} of ${analysis.circularDeps.length} cycles`,
        );
      }
    }
  }
  return lines.join("\n");
}

/** Render dead files section content. */
export function renderDeadFilesContent(analysis: ContextAnalysis): string | null {
  if (!analysis.deadFiles || analysis.deadFiles.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Dead Files");
  lines.push("");
  lines.push("Files not imported by any other source file. Candidates for removal or missing entry points.");
  lines.push("");
  for (const file of analysis.deadFiles.slice(0, SECTION_LIMITS.DEAD_FILES)) {
    lines.push(`- \`${file}\``);
  }
  if (analysis.deadFiles.length > SECTION_LIMITS.DEAD_FILES) {
    lines.push(`- ... and ${analysis.deadFiles.length - SECTION_LIMITS.DEAD_FILES} more`);
  }
  return lines.join("\n");
}

/** Render cross-cutting files section content. */
export function renderCrossCuttingContent(analysis: ContextAnalysis): string | null {
  if (!analysis.crossCuttingFiles || analysis.crossCuttingFiles.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Cross-Cutting Files");
  lines.push("");
  lines.push("These files are imported across multiple architectural layers. Changes here have wide blast radius.");
  lines.push("");
  lines.push("| File | Imported By | Layers |");
  lines.push("|------|------------|--------|");
  for (const f of analysis.crossCuttingFiles) {
    lines.push(
      `| \`${f.file}\` | ${f.totalImporters} file${f.totalImporters === 1 ? "" : "s"} | ${f.layers.join(", ")} |`,
    );
  }
  return lines.join("\n");
}

/** Render chokepoints section content. */
export function renderChokepointsContent(analysis: ContextAnalysis): string | null {
  if (!analysis.chokepoints || analysis.chokepoints.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Architectural Chokepoints");
  lines.push("");
  lines.push(
    "Files that bridge many upstream dependents to downstream dependencies. Changes to their exports will cascade.",
  );
  lines.push("");
  lines.push("| File | Upstream (dependents) | Downstream (deps) |");
  lines.push("|------|-----------------------|-------------------|");
  for (const cp of analysis.chokepoints.slice(0, SECTION_LIMITS.CHOKEPOINTS)) {
    const upstream = cp.upstreamCount;
    const downstream = cp.downstreamCount ?? 0;
    lines.push(`| \`${cp.file}\` | ${upstream} files | ${downstream} files |`);
  }
  if (analysis.chokepoints.length > SECTION_LIMITS.CHOKEPOINTS) {
    lines.push(`- ... and ${analysis.chokepoints.length - SECTION_LIMITS.CHOKEPOINTS} more`);
  }
  return lines.join("\n");
}

/** Render tight coupling section content. */
export function renderTightCouplingContent(analysis: ContextAnalysis): string | null {
  if (!analysis.tightCouplings || analysis.tightCouplings.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Tight Coupling");
  lines.push("");
  lines.push(
    "File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.",
  );
  lines.push("");
  for (const tc of analysis.tightCouplings) {
    const typeAnnotation = tc.typeOnlyCount ? ` (${tc.typeOnlyCount} type-only)` : "";
    lines.push(`- \`${tc.from}\` imports ${tc.importedNames} names from \`${tc.to}\`${typeAnnotation}`);
  }
  return lines.join("\n");
}

/** Render hidden coupling section content. */
export function renderHiddenCouplingContent(analysis: ContextAnalysis): string | null {
  if (!analysis.structuralMismatches || analysis.structuralMismatches.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Hidden Coupling");
  lines.push("");
  lines.push(
    "File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).",
  );
  lines.push("");
  lines.push("| File A | File B | Co-changes | Confidence | Graph Distance |");
  lines.push("|--------|--------|------------|------------|----------------|");
  for (const m of analysis.structuralMismatches) {
    const dist = m.graphDistance === -1 ? "unreachable" : `${m.graphDistance} hops`;
    lines.push(
      `| \`${m.fileA}\` | \`${m.fileB}\` | ${m.coChangeCount} | ${Math.round(m.coChangeConfidence * 100)}% | ${dist} |`,
    );
  }
  return lines.join("\n");
}
