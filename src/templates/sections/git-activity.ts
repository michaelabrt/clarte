import type { ContextAnalysis, ContextSection } from "../../types.js";
import { estimateTokens } from "../../utils.js";
import { SECTION_LIMITS } from "../../config/thresholds.js";

export function renderGitActivitySections(analysis: ContextAnalysis): ContextSection[] {
  const sections: ContextSection[] = [];

  if (analysis.gitActivity && analysis.gitActivity.hotFiles.length > 0) {
    const hotLines: string[] = [];
    hotLines.push("## Recently Active Files");
    hotLines.push("");
    const days = analysis.analysisDays ?? 90;
    hotLines.push(`| File | Commits (${days}d) | Last Changed |`);
    hotLines.push("|------|--------------|--------------|");
    for (const hot of analysis.gitActivity.hotFiles.slice(0, SECTION_LIMITS.HOT_FILES)) {
      hotLines.push(`| \`${hot.path}\` | ${hot.commits} | ${hot.lastChanged} |`);
    }
    const hotContent = hotLines.join("\n");
    sections.push({ id: "hot-files", priority: 7, content: hotContent, tokens: estimateTokens(hotContent) });
  }

  const ccContent = renderChangeCouplingContent(analysis);
  if (ccContent) {
    sections.push({ id: "change-coupling", priority: 7, content: ccContent, tokens: estimateTokens(ccContent) });
  }

  return sections;
}

/** Render the change coupling section content. */
export function renderChangeCouplingContent(analysis: ContextAnalysis): string | null {
  if (!analysis.gitActivity?.changeCoupling || analysis.gitActivity.changeCoupling.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Change Coupling");
  lines.push("");
  lines.push("Files that frequently change together -- when modifying one, check if the other needs updates too.");
  lines.push("");
  lines.push("| File A | File B | Co-changes | Confidence |");
  lines.push("|--------|--------|------------|------------|");
  for (const pair of analysis.gitActivity.changeCoupling) {
    const ab = pair.confidenceAB ?? pair.confidence;
    const ba = pair.confidenceBA ?? pair.confidence;
    const diff = Math.abs(ab - ba);
    let confLabel: string;
    if (diff >= 0.2 && (ab >= 0.6 || ba >= 0.6)) {
      if (ab > ba) {
        confLabel = `A->B ${(ab * 100).toFixed(0)}%`;
      } else {
        confLabel = `B->A ${(ba * 100).toFixed(0)}%`;
      }
    } else {
      confLabel = `${(pair.confidence * 100).toFixed(0)}%`;
    }
    lines.push(`| \`${pair.fileA}\` | \`${pair.fileB}\` | ${pair.coChangeCount} | ${confLabel} |`);
  }
  return lines.join("\n");
}
