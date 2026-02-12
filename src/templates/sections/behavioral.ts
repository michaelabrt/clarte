import type { ContextSection } from "../../types.js";
import { estimateTokens } from "../../utils.js";

const BEHAVIORAL_TEXT =
  "Do not use Grep or Glob to explore the codebase upfront. Based on the task description, open the most relevant files directly. Only broaden your search if your first attempt doesn't find the right code.\nAfter editing, run tests once. Do not re-run tests to reformat output. If tests pass, stop.";

/**
 * Render a behavioral guidance section for AI agents.
 * Returns a standalone paragraph (no heading) to keep token cost minimal.
 */
export function renderBehavioralSection(): ContextSection {
  return {
    id: "behavioral",
    priority: 1,
    content: BEHAVIORAL_TEXT,
    tokens: estimateTokens(BEHAVIORAL_TEXT),
  };
}

const NEGATIVE_BEHAVIORAL_TEXT =
  "NEVER search the codebase with Grep or Glob before reading code. Open files directly by path based on the task description. Only broaden your search if your first attempt fails.\nDo not create new files when you can edit existing ones. Do not add comments, docstrings, or type annotations to code you didn't change. Do not explore files outside the immediate task scope.\nNEVER re-run tests to reformat output. Run tests once. If they pass, stop immediately.";

/**
 * Render a negative-framing behavioral section (variant D).
 * Uses constraint language ("NEVER do X") instead of positive guidance.
 */
export function renderNegativeBehavioralSection(): ContextSection {
  return {
    id: "behavioral",
    priority: 1,
    content: NEGATIVE_BEHAVIORAL_TEXT,
    tokens: estimateTokens(NEGATIVE_BEHAVIORAL_TEXT),
  };
}
