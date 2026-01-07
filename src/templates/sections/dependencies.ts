import type { ContextAnalysis, ContextSection } from "../../types.js";
import { estimateTokens } from "../../utils.js";
import { findFeedbackEdges } from "../../graph/cycles.js";

export function renderDependencySections(analysis: ContextAnalysis): ContextSection[] {
  const sections: ContextSection[] = [];

  if (analysis.circularDeps && analysis.circularDeps.length > 0) {
    const circLines: string[] = [];
    circLines.push("## Circular Dependencies");
    circLines.push("");
    circLines.push("> These circular import chains may cause unexpected behavior when modified.");
    circLines.push("");
    for (const dep of analysis.circularDeps) {
      const severity =
        dep.severity != null ? (dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : "") : "";
      const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
      circLines.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}${severity}${hint}`);
    }

    if (analysis.circularDeps.length > 1) {
      const feedbackEdges = findFeedbackEdges(analysis.circularDeps);
      if (feedbackEdges.length > 0) {
        circLines.push("");
        circLines.push("**Most impactful edges to break:**");
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
          circLines.push(
            `- Breaking \`${shortFrom}\` -> \`${shortTo}\` would resolve ${edge.cyclesResolved} of ${analysis.circularDeps.length} cycles`,
          );
        }
      }
    }
    const circContent = circLines.join("\n");
    sections.push({ id: "circular-deps", priority: 3, content: circContent, tokens: estimateTokens(circContent) });
  }

  if (analysis.deadFiles && analysis.deadFiles.length > 0) {
    const deadLines: string[] = [];
    deadLines.push("## Dead Files");
    deadLines.push("");
    deadLines.push("Files not imported by any other source file. Candidates for removal or missing entry points.");
    deadLines.push("");
    for (const file of analysis.deadFiles.slice(0, 15)) {
      deadLines.push(`- \`${file}\``);
    }
    if (analysis.deadFiles.length > 15) {
      deadLines.push(`- ... and ${analysis.deadFiles.length - 15} more`);
    }
    const deadContent = deadLines.join("\n");
    sections.push({ id: "dead-files", priority: 9, content: deadContent, tokens: estimateTokens(deadContent) });
  }

  if (analysis.crossCuttingFiles && analysis.crossCuttingFiles.length > 0) {
    const ccfLines: string[] = [];
    ccfLines.push("## Cross-Cutting Files");
    ccfLines.push("");
    ccfLines.push(
      "These files are imported across multiple architectural layers. Changes here have wide blast radius.",
    );
    ccfLines.push("");
    ccfLines.push("| File | Imported By | Layers |");
    ccfLines.push("|------|------------|--------|");
    for (const f of analysis.crossCuttingFiles) {
      ccfLines.push(
        `| \`${f.file}\` | ${f.totalImporters} file${f.totalImporters === 1 ? "" : "s"} | ${f.layers.join(", ")} |`,
      );
    }
    const ccfContent = ccfLines.join("\n");
    sections.push({ id: "cross-cutting", priority: 9, content: ccfContent, tokens: estimateTokens(ccfContent) });
  }

  if (analysis.chokepoints && analysis.chokepoints.length > 0) {
    const cpLines: string[] = [];
    cpLines.push("## Architectural Chokepoints");
    cpLines.push("");
    cpLines.push("Files whose removal would disconnect parts of the codebase. Refactor with extreme care.");
    cpLines.push("");
    cpLines.push("| File | Separates | Imported By |");
    cpLines.push("|------|-----------|-------------|");
    for (const cp of analysis.chokepoints.slice(0, 10)) {
      cpLines.push(
        `| \`${cp.file}\` | ${cp.separates} component${cp.separates === 1 ? "" : "s"} | ${cp.importedBy} file${cp.importedBy === 1 ? "" : "s"} |`,
      );
    }
    const cpContent = cpLines.join("\n");
    sections.push({ id: "chokepoints", priority: 9, content: cpContent, tokens: estimateTokens(cpContent) });
  }

  if (analysis.tightCouplings && analysis.tightCouplings.length > 0) {
    const tcLines: string[] = [];
    tcLines.push("## Tight Coupling");
    tcLines.push("");
    tcLines.push(
      "File pairs where one file imports many named exports from another, indicating strong coupling. Consider an intermediate interface if refactoring.",
    );
    tcLines.push("");
    for (const tc of analysis.tightCouplings) {
      const typeAnnotation = tc.typeOnlyCount ? ` (${tc.typeOnlyCount} type-only)` : "";
      tcLines.push(`- \`${tc.from}\` imports ${tc.importedNames} names from \`${tc.to}\`${typeAnnotation}`);
    }
    const tcContent = tcLines.join("\n");
    sections.push({ id: "tight-coupling", priority: 10, content: tcContent, tokens: estimateTokens(tcContent) });
  }

  if (analysis.structuralMismatches && analysis.structuralMismatches.length > 0) {
    const smLines: string[] = [];
    smLines.push("## Hidden Coupling");
    smLines.push("");
    smLines.push(
      "File pairs that frequently change together but have no direct import path. These suggest hidden dependencies (shared schema, duplicated logic, or a missing shared module).",
    );
    smLines.push("");
    smLines.push("| File A | File B | Co-changes | Confidence | Graph Distance |");
    smLines.push("|--------|--------|------------|------------|----------------|");
    for (const m of analysis.structuralMismatches) {
      const dist = m.graphDistance === -1 ? "unreachable" : `${m.graphDistance} hops`;
      smLines.push(
        `| \`${m.fileA}\` | \`${m.fileB}\` | ${m.coChangeCount} | ${Math.round(m.coChangeConfidence * 100)}% | ${dist} |`,
      );
    }
    const smContent = smLines.join("\n");
    sections.push({ id: "hidden-coupling", priority: 10, content: smContent, tokens: estimateTokens(smContent) });
  }

  return sections;
}
