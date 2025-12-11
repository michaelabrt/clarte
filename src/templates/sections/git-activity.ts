import type { ContextAnalysis, ContextSection } from "../../types.js";
import { estimateTokens } from "../../utils.js";

export function renderGitActivitySections(analysis: ContextAnalysis): ContextSection[] {
  const sections: ContextSection[] = [];

  if (analysis.gitActivity && analysis.gitActivity.hotFiles.length > 0) {
    const hotLines: string[] = [];
    hotLines.push("## Recently Active Files");
    hotLines.push("");
    const days = analysis.analysisDays ?? 90;
    hotLines.push(`| File | Commits (${days}d) | Last Changed |`);
    hotLines.push("|------|--------------|--------------|");
    for (const hot of analysis.gitActivity.hotFiles.slice(0, 10)) {
      hotLines.push(`| \`${hot.path}\` | ${hot.commits} | ${hot.lastChanged} |`);
    }
    const hotContent = hotLines.join("\n");
    sections.push({ id: "hot-files", priority: 7, content: hotContent, tokens: estimateTokens(hotContent) });
  }

  if (analysis.gitActivity?.changeCoupling && analysis.gitActivity.changeCoupling.length > 0) {
    const ccLines: string[] = [];
    ccLines.push("## Change Coupling");
    ccLines.push("");
    ccLines.push("Files that frequently change together -- when modifying one, check if the other needs updates too.");
    ccLines.push("");
    ccLines.push("| File A | File B | Co-changes | Jaccard |");
    ccLines.push("|--------|--------|------------|---------|");
    for (const pair of analysis.gitActivity.changeCoupling) {
      ccLines.push(
        `| \`${pair.fileA}\` | \`${pair.fileB}\` | ${pair.coChangeCount} | ${(pair.confidence * 100).toFixed(0)}% |`,
      );
    }
    const ccContent = ccLines.join("\n");
    sections.push({ id: "change-coupling", priority: 7, content: ccContent, tokens: estimateTokens(ccContent) });
  }

  return sections;
}
