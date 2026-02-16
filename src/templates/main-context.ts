import type {
  CodeSnapshot,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  IDETarget,
  ImportGraph,
  UserAnswers,
} from "../types.js";
import { estimateTokens } from "../utils.js";
import { getProjectName, resetProjectNameCache, renderProjectInfoSections } from "./sections/project-info.js";
import { renderArchitectureSections } from "./sections/architecture.js";
import { renderDependencySections } from "./sections/dependencies.js";
import { renderGitActivitySections } from "./sections/git-activity.js";
import { renderStructureSections } from "./sections/structure.js";
import { DEFAULT_BUDGET, DEFAULT_MAX_CHARS, applyBudget, enforceCharBudget } from "./budget.js";

// Re-export for external consumers
export { resetProjectNameCache } from "./sections/project-info.js";
export { DEFAULT_BUDGET, DEFAULT_MAX_CHARS, applyBudget, applyCharBudget } from "./budget.js";

export interface SectionFilterOptions {
  /** Promote these section IDs to priority 0 (always included). */
  include?: Set<string>;
  /** Remove these section IDs entirely. */
  exclude?: Set<string>;
}

/**
 * Apply include/exclude filters to sections.
 * Exclude runs first (removes sections), then include promotes survivors to P0.
 */
function applyFilters(sections: ContextSection[], options?: SectionFilterOptions): ContextSection[] {
  let result = sections;

  if (options?.exclude?.size) {
    result = result.filter((s) => !options.exclude!.has(s.id));
  }

  if (options?.include?.size) {
    for (const s of result) {
      if (options.include.has(s.id)) {
        s.priority = 0;
      }
    }
  }

  return result;
}

/**
 * Build the main context file content (CLAUDE.md, AGENTS.md, or CONTEXT.md).
 * When budget > 0, sections are prioritized and trimmed to fit within the token budget.
 * Defaults to DEFAULT_BUDGET (5000 tokens) when budget is not specified.
 * Pass budget=0 (--full) to disable budgeting and include all sections.
 *
 * maxChars enforces a character ceiling (default: 39,500). Two-level strategy:
 *   1. Shrink the Code Snapshot section (trim lowest-value entries)
 *   2. Drop lowest-priority sections (P3+)
 * Pass maxChars=0 to disable character budgeting.
 * reservedChars accounts for user sections that will be merged after generation.
 */
export async function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  budget?: number,
  options?: SectionFilterOptions,
  maxChars?: number,
  reservedChars: number = 0,
  graph?: ImportGraph,
  excludeDirectives?: Set<string>,
  onDemandSkills?: boolean,
  mcpEnabled?: boolean,
): Promise<string> {
  const allSections = await buildSections(
    ctx,
    answers,
    snapshot,
    analysis,
    graph,
    excludeDirectives,
    onDemandSkills,
    mcpEnabled,
  );
  const effectiveBudget = budget ?? DEFAULT_BUDGET;
  const effectiveMaxChars = maxChars ?? DEFAULT_MAX_CHARS;

  const timestamp = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const generatedComment = `\n<!-- clarte: generated ${timestamp}. Run npx clarte to regenerate. -->\n`;

  if (effectiveBudget <= 0) {
    // --full mode: include all sections, still apply filters
    const filtered = applyFilters(allSections, options);
    let result =
      filtered
        .map((s) => s.content)
        .join("\n\n")
        .trimEnd() +
      "\n" +
      generatedComment;

    // Apply character budget even in --full mode
    if (effectiveMaxChars > 0) {
      result = enforceCharBudget(filtered, result, effectiveMaxChars, reservedChars, generatedComment);
    }

    return result;
  }

  const filtered = applyFilters(allSections, options);
  const { included, omitted, overflowWarning } = applyBudget(filtered, effectiveBudget);
  let result =
    included
      .map((s) => s.content)
      .join("\n\n")
      .trimEnd() + "\n";

  if (overflowWarning) {
    result += `\n<!-- WARNING: ${overflowWarning} -->\n`;
  }
  if (omitted.length > 0) {
    result += `\n<!-- Sections omitted to fit token budget: ${omitted.join(", ")}. Run clarte --full for full output. -->\n`;
  }

  result += generatedComment;

  // Apply character budget after token budget
  if (effectiveMaxChars > 0) {
    result = enforceCharBudget(included, result, effectiveMaxChars, reservedChars, generatedComment);
  }

  return result;
}

/**
 * Build all context sections with priority and token estimates.
 * Exported for testing and programmatic use.
 */
export async function buildSections(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
  graph?: ImportGraph,
  excludeDirectives?: Set<string>,
  onDemandSkills?: boolean,
  mcpEnabled?: boolean,
): Promise<ContextSection[]> {
  resetProjectNameCache();
  const projectName = await getProjectName(ctx);

  // Collect sections from all submodules
  const projectInfo = await renderProjectInfoSections(ctx, answers, projectName);
  const architecture = analysis ? await renderArchitectureSections(analysis, ctx, graph, excludeDirectives) : [];
  const dependencies = analysis ? renderDependencySections(analysis) : [];
  const structure = renderStructureSections(ctx, snapshot, analysis);
  const gitActivity = analysis ? renderGitActivitySections(analysis) : [];

  // Index all sections by id for ordered insertion
  const byId = new Map<string, ContextSection>();
  for (const s of [...projectInfo, ...architecture, ...dependencies, ...structure, ...gitActivity]) {
    byId.set(s.id, s);
  }

  // Add graph-tools section when MCP server is configured
  if (mcpEnabled) {
    const graphToolsContent = buildGraphToolsSection();
    byId.set("graph-tools", {
      id: "graph-tools",
      priority: 2,
      content: graphToolsContent,
      tokens: estimateTokens(graphToolsContent),
    });
  }

  // Insert in the exact order matching the original monolithic buildSections().
  // This order determines tiebreaking when sections share a priority level.
  const SECTION_ORDER = [
    "header",
    "what-is-this",
    "tech-stack",
    "config-constraints",
    "working-guidelines",
    "graph-tools",
    "key-files",
    "circular-deps",
    "architecture",
    "package-dependencies",
    "framework-hints",
    "conventions",
    "code-snapshot",
    "hot-files",
    "change-coupling",
    "test-mapping",
    "structure",
    "monorepo-structure",
    "dead-files",
    "cross-cutting",
    "chokepoints",
    "tight-coupling",
    "hidden-coupling",
    "layer-consistency",
    "key-patterns",
    "gotchas",
    "development",
  ];

  const sections: ContextSection[] = [];
  for (const id of SECTION_ORDER) {
    const s = byId.get(id);
    if (s) sections.push(s);
  }

  // Append any sections not in the canonical order (future-proofing)
  for (const s of byId.values()) {
    if (!sections.includes(s)) sections.push(s);
  }

  // Append on-demand skills pointer to key-patterns section (Exp 3)
  if (onDemandSkills) {
    const keyPatternsSection = sections.find((s) => s.id === "key-patterns");
    if (keyPatternsSection) {
      const pointer =
        "- Detailed coupling analysis, health diagnostics and test coverage are available via /coupling, /health and /tests";
      keyPatternsSection.content += `\n${pointer}`;
      keyPatternsSection.tokens = estimateTokens(keyPatternsSection.content);
    }
  }

  // -- Per-IDE section priority boosts (Task 1c) --
  // Only apply when a single IDE is targeted.
  if (answers.ides.length === 1) {
    const ide = answers.ides[0];
    if (ide === "claude") {
      applySectionBoost(sections, "working-guidelines", 1);
      applySectionBoost(sections, "config-constraints", 1);
    } else if (ide === "cursor") {
      applySectionBoost(sections, "architecture", 2);
    } else if (ide === "copilot") {
      applySectionBoost(sections, "conventions", 2);
      applySectionBoost(sections, "code-snapshot", 3);
    }
  }

  // -- User-controlled section ordering (Task 1a) --
  const sectionOrder = answers.sectionOrder;
  if (sectionOrder && Array.isArray(sectionOrder) && sectionOrder.length > 0) {
    const excludeSet = new Set<string>();
    const orderList: string[] = [];

    for (const entry of sectionOrder) {
      if (entry.startsWith("-")) {
        excludeSet.add(entry.slice(1));
      } else {
        orderList.push(entry);
      }
    }

    // Remove excluded sections
    for (let i = sections.length - 1; i >= 0; i--) {
      if (excludeSet.has(sections[i].id)) {
        sections.splice(i, 1);
      }
    }

    // Re-assign priorities based on array position for ordered sections.
    // Sections not in the list keep their default priority but are offset
    // so they appear after all explicitly ordered sections.
    const maxOrderedPriority = orderList.length;
    for (const section of sections) {
      const idx = orderList.indexOf(section.id);
      if (idx !== -1) {
        section.priority = idx;
      } else {
        // Offset non-listed sections so they sort after the ordered ones
        section.priority = maxOrderedPriority + section.priority;
      }
    }
  }

  return sections;
}

/**
 * Build the Graph Tools section for the MCP CORE DIRECTIVE.
 */
function buildGraphToolsSection(): string {
  return `## Graph Tools

When \`.clarte/task-context.md\` exists, always run the pre-flight scan first:
\`Agent(subagent_type="clarte-pre-flight", prompt="<task description>")\`
It reads the target files and returns the exact edit locations with full code context. Apply its findings directly - the code is already in your context, no need to re-read those files.

| Trigger | Tool | What it returns |
|---------|------|-----------------|
| **Before renaming or removing** a function | \`clarte_calls(<name>)\` | All call sites + all functions it calls |
| **Before changing** a public API or export | \`clarte_impact(<path>)\` | Full transitive dependent set + risk level |

**STOP CONDITIONS:**
- Do NOT call \`clarte_calls\` for trivial one-line functions.
- Do NOT call \`clarte_impact\` on leaf files with zero importers.`;
}

/**
 * Boost a section's priority if the section exists.
 */
function applySectionBoost(sections: ContextSection[], id: string, priority: number): void {
  const section = sections.find((s) => s.id === id);
  if (section && section.priority > priority) {
    section.priority = priority;
  }
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
