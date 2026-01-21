import type { ClaudeSkill, ContextAnalysis } from "../types.js";
import {
  renderTightCouplingContent,
  renderHiddenCouplingContent,
  renderCircularDepsContent,
  renderDeadFilesContent,
  renderCrossCuttingContent,
  renderChokepointsContent,
} from "./sections/dependencies.js";
import { renderChangeCouplingContent } from "./sections/git-activity.js";
import { renderLayerConsistencySection } from "./sections/architecture.js";
import { renderTestMappingSection } from "../analysis/test-map.js";

/**
 * Build Claude Code skills.
 * Base skills: /check (auto-invocable) and /refresh (user-invoked).
 * When onDemandSkills=true and analysis is available, generates up to 3 additional
 * data skills: /coupling, /health, /tests.
 */
export function buildClaudeSkills(analysis?: ContextAnalysis, onDemandSkills?: boolean): ClaudeSkill[] {
  const skills: ClaudeSkill[] = [
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

  if (onDemandSkills && analysis) {
    const couplingSkill = buildCouplingSkill(analysis);
    if (couplingSkill) skills.push(couplingSkill);

    const healthSkill = buildHealthSkill(analysis);
    if (healthSkill) skills.push(healthSkill);

    const testsSkill = buildTestsSkill(analysis);
    if (testsSkill) skills.push(testsSkill);
  }

  return skills;
}

function buildCouplingSkill(analysis: ContextAnalysis): ClaudeSkill | null {
  const parts: string[] = [];

  const tc = renderTightCouplingContent(analysis);
  if (tc) parts.push(tc);

  const hc = renderHiddenCouplingContent(analysis);
  if (hc) parts.push(hc);

  const cc = renderChangeCouplingContent(analysis);
  if (cc) parts.push(cc);

  if (parts.length === 0) return null;

  return {
    name: "coupling",
    description:
      "Analyze file coupling: tight coupling (file pairs importing many names from each other), hidden coupling (files co-changing in git without import paths) and change coupling frequency. Use before refactoring, restructuring exports or investigating why unrelated files break together.",
    disableModelInvocation: false,
    body: parts.join("\n\n"),
  };
}

function buildHealthSkill(analysis: ContextAnalysis): ClaudeSkill | null {
  const parts: string[] = [];

  const dead = renderDeadFilesContent(analysis);
  if (dead) parts.push(dead);

  const circ = renderCircularDepsContent(analysis);
  if (circ) parts.push(circ);

  const choke = renderChokepointsContent(analysis);
  if (choke) parts.push(choke);

  const ccf = renderCrossCuttingContent(analysis);
  if (ccf) parts.push(ccf);

  const lc = renderLayerConsistencySection(analysis);
  if (lc) parts.push(lc.content);

  if (parts.length === 0) return null;

  return {
    name: "health",
    description:
      "Diagnose architectural problems: dead files (zero importers), circular dependency chains with break-point suggestions, chokepoints (single points of failure in the import graph), cross-cutting files and layer consistency violations. Use before architectural changes, debt cleanup or quality review.",
    disableModelInvocation: false,
    body: parts.join("\n\n"),
  };
}

function buildTestsSkill(analysis: ContextAnalysis): ClaudeSkill | null {
  if (!analysis.testMapping) return null;

  const testSection = renderTestMappingSection(analysis.testMapping, analysis.hubFiles);
  if (!testSection) return null;

  return {
    name: "tests",
    description:
      "Show test coverage: which test files cover each source file, untested files needing coverage and test conventions. Use before writing tests, checking what to run after a change or assessing coverage gaps.",
    disableModelInvocation: false,
    body: testSection,
  };
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
