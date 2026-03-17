import type {
  CodeSnapshot,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  IDETarget,
  UserAnswers,
} from "../../core/types";
import { getProjectName, resetProjectNameCache, renderProjectInfoSections } from "./sections/project-info";

// Re-export for external consumers
export { resetProjectNameCache } from "./sections/project-info";

// Keep type export for backward compat (used by cli/args.ts)
export interface SectionFilterOptions {
  include?: Set<string>;
  exclude?: Set<string>;
}

/**
 * Build the main context file content.
 * Simple linear render: header, tech stack, config constraints, development.
 */
export async function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  _snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
): Promise<string> {
  const sections = await buildSections(ctx, answers, _snapshot, analysis);

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const generatedComment = `\n<!-- clarte: generated ${timestamp}. Run npx clarte to regenerate. -->\n`;

  return (
    sections
      .map((s) => s.content)
      .join("\n\n")
      .trimEnd() +
    "\n" +
    generatedComment
  );
}

/**
 * Build all context sections. Simple linear list from project-info.
 */
export async function buildSections(
  ctx: DetectedContext,
  answers: UserAnswers,
  _snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
): Promise<ContextSection[]> {
  resetProjectNameCache();
  const projectName = await getProjectName(ctx);
  return renderProjectInfoSections(ctx, answers, projectName, analysis);
}

/**
 * Get the filename for the main context file based on IDE target.
 */
export function getMainContextFilename(ide: IDETarget): string {
  switch (ide) {
    case "claude":
      return ".claude/rules/clarte.md";
    case "cursor":
      return ".cursor/rules/clarte.md";
    case "opencode":
      return "AGENTS.md";
    case "copilot":
      return ".github/copilot-instructions.md";
    case "windsurf":
      return ".windsurfrules";
    case "cline":
      return ".clinerules";
    case "continue":
      return ".continuerules";
    case "generic":
      return "CONTEXT.md";
  }
}
