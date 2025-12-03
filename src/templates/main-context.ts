import type {
  CodeSnapshot,
  ContextAnalysis,
  ContextSection,
  DetectedContext,
  IDETarget,
  ImportGraph,
  UserAnswers,
} from "../types.js";
import { getProjectName, resetProjectNameCache, renderProjectInfoSections } from "./sections/project-info.js";
import { renderArchitectureSections } from "./sections/architecture.js";
import { renderDependencySections } from "./sections/dependencies.js";
import { renderGitActivitySections } from "./sections/git-activity.js";
import { renderStructureSections } from "./sections/structure.js";

// Re-export for external consumers
export { resetProjectNameCache } from "./sections/project-info.js";

/** Default token budget for context files. */
export const DEFAULT_BUDGET = 5000;

/** Default character budget for context files (Claude Code warns above 40k). */
export const DEFAULT_MAX_CHARS = 39_500;

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
): Promise<string> {
  const allSections = await buildSections(ctx, answers, snapshot, analysis, graph);
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
): Promise<ContextSection[]> {
  resetProjectNameCache();
  const projectName = await getProjectName(ctx);

  // Collect sections from all submodules
  const projectInfo = await renderProjectInfoSections(ctx, answers, projectName);
  const architecture = analysis ? await renderArchitectureSections(analysis, ctx, graph) : [];
  const dependencies = analysis ? renderDependencySections(analysis) : [];
  const structure = renderStructureSections(ctx, snapshot, analysis);
  const gitActivity = analysis ? renderGitActivitySections(analysis) : [];

  // Index all sections by id for ordered insertion
  const byId = new Map<string, ContextSection>();
  for (const s of [...projectInfo, ...architecture, ...dependencies, ...structure, ...gitActivity]) {
    byId.set(s.id, s);
  }

  // Insert in the exact order matching the original monolithic buildSections().
  // This order determines tiebreaking when sections share a priority level.
  const SECTION_ORDER = [
    "header",
    "what-is-this",
    "tech-stack",
    "config-constraints",
    "working-guidelines",
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
 * Boost a section's priority if the section exists.
 */
function applySectionBoost(sections: ContextSection[], id: string, priority: number): void {
  const section = sections.find((s) => s.id === id);
  if (section && section.priority > priority) {
    section.priority = priority;
  }
}

/**
 * Apply a token budget to sections, including by priority order.
 * Priority 0 sections are always included.
 */
export function applyBudget(
  sections: ContextSection[],
  budget: number,
): { included: ContextSection[]; omitted: string[]; overflowWarning?: string } {
  // Priority 0 is always included
  const always = sections.filter((s) => s.priority === 0);
  const budgeted = sections.filter((s) => s.priority > 0);

  // Sort by priority (ascending = highest priority first)
  budgeted.sort((a, b) => a.priority - b.priority);

  let remaining = budget;
  for (const s of always) {
    remaining -= s.tokens;
  }

  const included: ContextSection[] = [...always];
  const omitted: string[] = [];

  // Priority 1-2 are always included (even if over budget)
  for (const s of budgeted) {
    if (s.priority <= 2) {
      included.push(s);
      remaining -= s.tokens;
    } else if (remaining >= s.tokens) {
      included.push(s);
      remaining -= s.tokens;
    } else {
      omitted.push(s.id);
    }
  }

  // Restore original order by re-sorting based on position in the original array
  const orderMap = new Map(sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  // Check for budget overflow: mandatory sections (p0-2) exceed the budget
  const mandatoryTokens = included.filter((s) => s.priority <= 2).reduce((sum, s) => sum + s.tokens, 0);
  let overflowWarning: string | undefined;
  if (mandatoryTokens > budget) {
    overflowWarning = `Mandatory sections (priority 0-2) use ~${mandatoryTokens} tokens, exceeding the ${budget}-token budget. Consider increasing --budget or reducing project scope.`;
  }

  return { included, omitted, overflowWarning };
}

/**
 * Enforce a character budget on the fully-assembled output.
 * Two-level strategy:
 *   1. Shrink the Code Snapshot (trim lowest-value entries via binary search)
 *   2. Drop lowest-priority sections (P3+), highest priority number first
 *
 * Returns the (possibly trimmed) result string.
 */
function enforceCharBudget(
  sections: ContextSection[],
  result: string,
  maxChars: number,
  reservedChars: number,
  generatedComment: string,
): string {
  const available = maxChars - reservedChars;
  if (result.length <= available) return result;

  // Level 1: Try shrinking the code-snapshot section
  const snapSection = sections.find((s) => s.id === "code-snapshot");
  if (snapSection) {
    const overshoot = result.length - available;
    const targetSnapChars = Math.max(0, snapSection.content.length - overshoot);

    // Parse snapshot entries from the section content
    // The section wraps the markdown between CODE SNAPSHOT markers
    const snapshotStart = "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
    const snapshotEnd = "<!-- /CODE SNAPSHOT -->";
    const startIdx = snapSection.content.indexOf(snapshotStart);
    const endIdx = snapSection.content.indexOf(snapshotEnd);

    if (startIdx >= 0 && endIdx >= 0) {
      const prefix = snapSection.content.slice(0, startIdx + snapshotStart.length + 1);
      const suffix = "\n" + snapSection.content.slice(endIdx);
      const wrapperChars = prefix.length + suffix.length;
      const targetMarkdownChars = Math.max(100, targetSnapChars - wrapperChars);

      // We need access to the snapshot entries. Re-import is not possible here,
      // so we use a simpler approach: progressively remove lines from the end
      // of the markdown block until it fits.
      const snapshotMarkdown = snapSection.content.slice(startIdx + snapshotStart.length + 1, endIdx).trim();
      const trimmedMarkdown = trimMarkdownToChars(snapshotMarkdown, targetMarkdownChars);

      if (trimmedMarkdown.length < snapshotMarkdown.length) {
        const newSnapContent = prefix + trimmedMarkdown + "\n" + suffix.trimStart();
        const newResult = result.replace(snapSection.content, newSnapContent);

        if (newResult.length <= available) {
          // Add omission comment so the user knows the snapshot was trimmed
          const trimComment = `\n<!-- Sections omitted to fit char budget: code-snapshot (trimmed). Run clarte --full for full output. -->\n`;
          return newResult.replace(generatedComment, trimComment + generatedComment);
        }
        // Partially helped; continue with section dropping
        result = newResult;
        snapSection.content = newSnapContent;
      }
    }
  }

  // Level 2: Drop lowest-priority sections (highest priority number first, P3+)
  const { included: charIncluded, dropped } = applyCharBudget(sections, available, generatedComment);
  let charResult =
    charIncluded
      .map((s) => s.content)
      .join("\n\n")
      .trimEnd() + "\n";
  if (dropped.length > 0) {
    charResult += `\n<!-- Sections omitted to fit char budget: ${dropped.join(", ")}. Run clarte --full for full output. -->\n`;
  }
  charResult += generatedComment;
  return charResult;
}

/**
 * Trim a markdown code snapshot by removing entries from the end.
 * Entries are separated by blank lines within code blocks.
 * This is a character-level trim, not entry-level.
 */
function trimMarkdownToChars(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;

  let result = markdown;

  // Recompute section starts from current result on each pass
  const findSectionStarts = (text: string): number[] => {
    const starts: number[] = [];
    let from = 0;
    while (true) {
      const idx = text.indexOf("### ", from);
      if (idx < 0) break;
      starts.push(idx);
      from = idx + 4;
    }
    return starts;
  };

  // Remove entries from the last section first, working backwards
  let changed = true;
  while (changed && result.length > maxChars) {
    changed = false;
    const sectionStarts = findSectionStarts(result);

    for (let si = sectionStarts.length - 1; si >= 0 && result.length > maxChars; si--) {
      const secStart = sectionStarts[si];
      const secEnd = si + 1 < sectionStarts.length ? sectionStarts[si + 1] : result.length;
      const secContent = result.slice(secStart, secEnd);

      // Find the code block within this section
      const codeStart = secContent.indexOf("```");
      if (codeStart < 0) continue;
      const codeEnd = secContent.indexOf("\n```", codeStart + 3);
      if (codeEnd < 0) continue;

      const codeBlock = secContent.slice(codeStart, codeEnd + 4);
      // Split code block entries by double newlines
      const firstNewline = codeBlock.indexOf("\n");
      const fence = codeBlock.slice(0, firstNewline + 1);
      const closeFence = "\n```";
      const codeBody = codeBlock.slice(firstNewline + 1, codeBlock.length - 4);
      const entries = codeBody.split("\n\n");

      if (entries.length > 1) {
        // Remove one entry and restart (section offsets change after mutation)
        entries.pop();
        const newCodeBlock = fence + entries.join("\n\n") + closeFence;
        const newSecContent = secContent.slice(0, codeStart) + newCodeBlock + secContent.slice(codeEnd + 4);
        result = result.slice(0, secStart) + newSecContent + result.slice(secEnd);
        changed = true;
        break; // Restart with fresh section offsets
      }

      // If section is now empty (only fence), remove the entire section
      if (entries.length <= 1 && entries[0]?.trim() === "") {
        result = result.slice(0, secStart) + result.slice(secEnd);
        changed = true;
        break; // Restart with fresh section offsets
      }
    }
  }

  return result;
}

/**
 * Drop lowest-priority sections to fit within a character budget.
 * Never drops P0-2 sections. Drops highest priority number first.
 */
export function applyCharBudget(
  sections: ContextSection[],
  maxChars: number,
  generatedComment: string,
): { included: ContextSection[]; dropped: string[] } {
  // Start with all sections
  const sorted = [...sections].sort((a, b) => a.priority - b.priority);
  const _mandatory = sorted.filter((s) => s.priority <= 2);
  const droppable = sorted.filter((s) => s.priority > 2).reverse(); // highest priority number first

  const included = [...sorted];
  const dropped: string[] = [];

  // Compute total size incrementally instead of O(n) string rebuild on each drop
  let totalChars =
    included.reduce((sum, s) => sum + s.content.trimEnd().length, 0) +
    (included.length > 1 ? (included.length - 1) * 2 : 0) + // "\n\n" separators
    1 +
    generatedComment.length;

  while (totalChars > maxChars && droppable.length > 0) {
    const toDrop = droppable.shift()!;
    const idx = included.findIndex((s) => s.id === toDrop.id);
    if (idx >= 0) {
      totalChars -= toDrop.content.trimEnd().length;
      if (included.length > 1) totalChars -= 2; // remove one "\n\n" separator
      included.splice(idx, 1);
      dropped.push(toDrop.id);
    }
  }

  // Restore original order
  const orderMap = new Map(sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  return { included, dropped };
}

/**
 * Get the filename for the main context file based on IDE target.
 */
export function getMainContextFilename(ide: IDETarget): string {
  switch (ide) {
    case "claude":
      return "CLAUDE.md";
    case "cursor":
      return "CLAUDE.md";
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
    case "aider":
      return ".aider.conf.yml";
    case "generic":
      return "CONTEXT.md";
  }
}
