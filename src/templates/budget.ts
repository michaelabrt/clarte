import type { ContextSection } from "../types.js";

/**
 * Default token budget for context files.
 * Rationale: 5000 tokens ~ 20k characters of markdown. This leaves room for user
 * sections while keeping the context file within the sweet spot where agents read
 * the full file without summarization. Benchmarked against Claude, Cursor and Copilot.
 */
export const DEFAULT_BUDGET = 5000;

/**
 * Default character budget for context files (Claude Code warns above 40k).
 * Rationale: Claude Code displays a warning when CLAUDE.md exceeds 40k characters.
 * 39,500 provides a 500-char safety margin for the user-sections block that gets
 * appended after generation.
 */
export const DEFAULT_MAX_CHARS = 39_500;

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
export function enforceCharBudget(
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

    const snapshotStart = "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
    const snapshotEnd = "<!-- /CODE SNAPSHOT -->";
    const startIdx = snapSection.content.indexOf(snapshotStart);
    const endIdx = snapSection.content.indexOf(snapshotEnd);

    if (startIdx >= 0 && endIdx >= 0) {
      const prefix = snapSection.content.slice(0, startIdx + snapshotStart.length + 1);
      const suffix = "\n" + snapSection.content.slice(endIdx);
      const wrapperChars = prefix.length + suffix.length;
      const targetMarkdownChars = Math.max(100, targetSnapChars - wrapperChars);

      const snapshotMarkdown = snapSection.content.slice(startIdx + snapshotStart.length + 1, endIdx).trim();
      const trimmedMarkdown = trimMarkdownToChars(snapshotMarkdown, targetMarkdownChars);

      if (trimmedMarkdown.length < snapshotMarkdown.length) {
        const newSnapContent = prefix + trimmedMarkdown + "\n" + suffix.trimStart();
        const newResult = result.replace(snapSection.content, newSnapContent);

        if (newResult.length <= available) {
          const trimComment = `\n<!-- Sections omitted to fit char budget: code-snapshot (trimmed). Run clarte --full for full output. -->\n`;
          return newResult.replace(generatedComment, trimComment + generatedComment);
        }
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
 */
function trimMarkdownToChars(markdown: string, maxChars: number): string {
  if (markdown.length <= maxChars) return markdown;

  let result = markdown;

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

  let changed = true;
  while (changed && result.length > maxChars) {
    changed = false;
    const sectionStarts = findSectionStarts(result);

    for (let si = sectionStarts.length - 1; si >= 0 && result.length > maxChars; si--) {
      const secStart = sectionStarts[si];
      const secEnd = si + 1 < sectionStarts.length ? sectionStarts[si + 1] : result.length;
      const secContent = result.slice(secStart, secEnd);

      const codeStart = secContent.indexOf("```");
      if (codeStart < 0) continue;
      const codeEnd = secContent.indexOf("\n```", codeStart + 3);
      if (codeEnd < 0) continue;

      const codeBlock = secContent.slice(codeStart, codeEnd + 4);
      const firstNewline = codeBlock.indexOf("\n");
      const fence = codeBlock.slice(0, firstNewline + 1);
      const closeFence = "\n```";
      const codeBody = codeBlock.slice(firstNewline + 1, codeBlock.length - 4);
      const entries = codeBody.split("\n\n");

      if (entries.length > 1) {
        entries.pop();
        const newCodeBlock = fence + entries.join("\n\n") + closeFence;
        const newSecContent = secContent.slice(0, codeStart) + newCodeBlock + secContent.slice(codeEnd + 4);
        result = result.slice(0, secStart) + newSecContent + result.slice(secEnd);
        changed = true;
        break;
      }

      if (entries.length <= 1 && entries[0]?.trim() === "") {
        result = result.slice(0, secStart) + result.slice(secEnd);
        changed = true;
        break;
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
  // Shallow-copy section objects so callers retain unmodified references
  const sorted = [...sections].map((s) => ({ ...s })).sort((a, b) => a.priority - b.priority);
  const droppable = sorted.filter((s) => s.priority > 2).reverse();

  const included = [...sorted];
  const dropped: string[] = [];

  let totalChars =
    included.reduce((sum, s) => sum + s.content.trimEnd().length, 0) +
    (included.length > 1 ? (included.length - 1) * 2 : 0) +
    1 +
    generatedComment.length;

  while (totalChars > maxChars && droppable.length > 0) {
    const toDrop = droppable.shift();
    if (!toDrop) break;
    const idx = included.findIndex((s) => s.id === toDrop.id);
    if (idx >= 0) {
      totalChars -= toDrop.content.trimEnd().length;
      if (included.length > 1) totalChars -= 2;
      included.splice(idx, 1);
      dropped.push(toDrop.id);
    }
  }

  const orderMap = new Map(sections.map((s, i) => [s.id, i]));
  included.sort((a, b) => (orderMap.get(a.id) ?? 0) - (orderMap.get(b.id) ?? 0));

  return { included, dropped };
}
