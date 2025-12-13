import type { CodeSnapshot, ContextAnalysis, ContextSection, DetectedContext } from "../../types.js";
import { estimateTokens } from "../../utils.js";
import { getFrameworkHintsSection } from "../framework-hints.js";
import { renderConventionsSection } from "../../conventions/conventions.js";
import { renderTestMappingSection } from "../../test-map.js";

export function renderStructureSections(
  ctx: DetectedContext,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
): ContextSection[] {
  const sections: ContextSection[] = [];

  const fwHints = getFrameworkHintsSection(ctx);
  if (fwHints) {
    sections.push({ id: "framework-hints", priority: 5, content: fwHints, tokens: estimateTokens(fwHints) });
  }

  if (analysis?.conventions) {
    const conventionsSection = renderConventionsSection(analysis.conventions);
    if (conventionsSection) {
      sections.push({
        id: "conventions",
        priority: 5,
        content: conventionsSection,
        tokens: estimateTokens(conventionsSection),
      });
    }
  }

  if (snapshot?.markdown) {
    const snapLines: string[] = [];
    snapLines.push("## Code Snapshot");
    snapLines.push("");
    snapLines.push("<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->");
    snapLines.push("");
    snapLines.push(snapshot.markdown);
    snapLines.push("");
    snapLines.push("<!-- /CODE SNAPSHOT -->");
    const snapContent = snapLines.join("\n");
    sections.push({ id: "code-snapshot", priority: 6, content: snapContent, tokens: estimateTokens(snapContent) });
  }

  if (analysis?.testMapping) {
    const testSection = renderTestMappingSection(analysis.testMapping, analysis.hubFiles);
    if (testSection) {
      sections.push({ id: "test-mapping", priority: 8, content: testSection, tokens: estimateTokens(testSection) });
    }
  }

  if (ctx.directories.length > 0) {
    const structLines: string[] = [];
    structLines.push("## Project Structure");
    structLines.push("");
    structLines.push("```");
    structLines.push(buildStructureTree(ctx));
    structLines.push("```");
    const structContent = structLines.join("\n");
    sections.push({ id: "structure", priority: 8, content: structContent, tokens: estimateTokens(structContent) });
  }

  if (ctx.monorepo && ctx.monorepo.packages.length > 0) {
    const monoLines: string[] = [];
    monoLines.push("## Monorepo Structure");
    monoLines.push("");
    monoLines.push(`${ctx.monorepo.type} workspace with ${ctx.monorepo.packages.length} packages:`);
    monoLines.push("");
    for (const pkg of ctx.monorepo.packages) {
      const fws = pkg.frameworks.length > 0 ? ` (${pkg.frameworks.map((f) => f.name).join(", ")})` : "";
      monoLines.push(`- **${pkg.name}** (\`${pkg.path}\`)${fws}`);
    }
    const monoContent = monoLines.join("\n");
    sections.push({ id: "monorepo-structure", priority: 8, content: monoContent, tokens: estimateTokens(monoContent) });
  }

  return sections;
}

function buildStructureTree(ctx: DetectedContext): string {
  const lines: string[] = [];
  const grouped = new Map<string, string[]>();

  for (const dir of ctx.directories) {
    const parts = dir.split("/");
    if (parts.length === 1) {
      if (!grouped.has(dir)) grouped.set(dir, []);
    } else {
      const parent = parts[0];
      const child = parts.slice(1).join("/");
      const children = grouped.get(parent) ?? [];
      children.push(child);
      grouped.set(parent, children);
    }
  }

  for (const [dir, children] of [...grouped.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${dir}/`);
    for (const child of [...children].sort()) {
      lines.push(`  ${child}/`);
    }
  }

  return lines.join("\n");
}
