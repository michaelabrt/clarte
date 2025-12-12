import type { ClaudeSkill } from "../types.js";

/**
 * Build Claude Code skills. Only two skills are generated:
 *   - /check: detect architectural regressions after code changes (auto-invocable)
 *   - /refresh: regenerate code snapshot (user-invoked)
 */
export function buildClaudeSkills(): ClaudeSkill[] {
  return [
    {
      name: "check",
      description: "Detect architectural regressions after code changes",
      disableModelInvocation: false,
      allowedTools: "Bash",
      body: [
        "# Post-Change Regression Check",
        "",
        "Run `npx clarte --format=json` and compare the output against the current context file to detect regressions:",
        "",
        "1. **New circular dependencies** not listed in the context file",
        "2. **New chokepoints** (files whose removal would disconnect the graph)",
        "3. **Coupling increases** (new tight-coupling or hidden-coupling pairs)",
        "4. **New dead files** (files with zero importers)",
        "",
        "Report only NEW issues (not already documented in the context file). If no regressions are found, confirm the changes are clean.",
      ].join("\n"),
    },
    {
      name: "refresh",
      description: "Regenerate code snapshot to reflect recent source changes",
      disableModelInvocation: true,
      allowedTools: "Bash",
      body: [
        "# Refresh Code Snapshot",
        "",
        "Run `npx clarte --refresh-snapshot` to update the code snapshot in the context file.",
        "",
        "Use this when the user asks to refresh, update, or regenerate the context file.",
      ].join("\n"),
    },
  ];
}

/**
 * Render a ClaudeSkill as YAML frontmatter + markdown body.
 */
export function renderClaudeSkill(skill: ClaudeSkill): string {
  const lines: string[] = ["---", `description: ${skill.description}`];

  if (skill.disableModelInvocation) {
    lines.push("disable-model-invocation: true");
  }

  if (skill.allowedTools) {
    lines.push(`allowed-tools: ${skill.allowedTools}`);
  }

  lines.push("---");
  lines.push("");
  lines.push(skill.body);
  lines.push("");

  return lines.join("\n");
}
