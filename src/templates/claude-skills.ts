import type { ClaudeSkill, ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";
import { buildDirectives, computeFileComplexity } from "./directives.js";
import { renderDependencySections } from "./sections/dependencies.js";
import { renderGitActivitySections } from "./sections/git-activity.js";
import { renderLayerConsistencySection } from "./sections/architecture.js";

/**
 * Build Claude Code skills based on detected project context.
 * @param scripts - Record of script name -> command from package.json (or equivalent)
 */
export async function buildClaudeSkills(
  ctx: DetectedContext,
  answers: UserAnswers,
  analysis?: ContextAnalysis,
  scripts?: Record<string, string>,
): Promise<ClaudeSkill[]> {
  const skills: ClaudeSkill[] = [];

  // Script-based skills from package.json
  if (scripts) {
    skills.push(...buildScriptSkills(ctx, scripts));
  }

  // Architecture exploration skill
  const archSkill = await buildArchitectureSkill(analysis, ctx);
  if (archSkill) skills.push(archSkill);

  // Code health skill (migrated sections from CLAUDE.md)
  if (analysis) {
    skills.push(...buildAnalysisSkills(analysis));
  }

  // CLI-invoking skills (always generated, they invoke clarte at runtime)
  skills.push(...buildClarteSkills());

  return skills;
}

/**
 * Scan package.json scripts for common commands and generate skills.
 */
function buildScriptSkills(ctx: DetectedContext, scripts: Record<string, string>): ClaudeSkill[] {
  const skills: ClaudeSkill[] = [];

  const scriptMap: Record<string, { description: string; keywords: string[] }> = {
    test: { description: "Run the test suite", keywords: ["test", "test:unit", "test:e2e"] },
    build: { description: "Build the project", keywords: ["build", "build:prod"] },
    lint: { description: "Run linter", keywords: ["lint", "lint:fix"] },
    dev: { description: "Start development server", keywords: ["dev", "start:dev"] },
    typecheck: { description: "Run type checking", keywords: ["typecheck", "type-check", "check-types"] },
  };

  const runCmd = getRunCommand(ctx);

  for (const [skillName, config] of Object.entries(scriptMap)) {
    const matchedScript = config.keywords.find((kw) => kw in scripts);
    if (!matchedScript) continue;

    const command = `${runCmd} ${matchedScript}`;
    skills.push({
      name: skillName,
      description: config.description,
      disableModelInvocation: true,
      body: [`# ${config.description}`, "", `Run: \`${command}\``].join("\n"),
    });
  }

  return skills;
}

function getRunCommand(ctx: DetectedContext): string {
  switch (ctx.packageManager) {
    case "pnpm":
      return "pnpm";
    case "yarn":
      return "yarn";
    case "bun":
      return "bun run";
    case "npm":
      return "npm run";
    case "cargo":
      return "cargo";
    case "go":
      return "go";
    default:
      return "npm run";
  }
}

/**
 * Build an architecture exploration skill with hub files, layers, circular deps, and directives.
 */
async function buildArchitectureSkill(analysis?: ContextAnalysis, ctx?: DetectedContext): Promise<ClaudeSkill | null> {
  if (!analysis) return null;

  const bodyLines: string[] = [
    "# Architecture Explorer",
    "",
    "Use this skill to understand the project architecture before making changes.",
    "",
  ];

  if (analysis.hubFiles.length > 0) {
    bodyLines.push("## Key Files (by HITS analysis)");
    bodyLines.push("");
    for (const hub of analysis.hubFiles) {
      bodyLines.push(
        `- \`${hub.path}\` — ${hub.role} (imported by ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"})`,
      );
    }
    bodyLines.push("");
  }

  if (analysis.layers.length > 0) {
    bodyLines.push("## Architecture Layers");
    bodyLines.push("");
    bodyLines.push("Dependency flow (foundational → consumer):");
    bodyLines.push("");
    bodyLines.push(analysis.layers.map((l) => `\`${l.name}\``).join(" → "));
    bodyLines.push("");
  }

  if (analysis.circularDeps.length > 0) {
    bodyLines.push("## Circular Dependencies");
    bodyLines.push("");
    for (const dep of analysis.circularDeps) {
      const severity =
        dep.severity != null ? (dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : "") : "";
      const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
      bodyLines.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}${severity}${hint}`);
    }
    bodyLines.push("");
  }

  // Working guidelines
  if (ctx) {
    const fileComplexity = analysis.hubFiles?.length
      ? await computeFileComplexity(ctx.rootDir, analysis.hubFiles)
      : undefined;
    const directives = buildDirectives(analysis, ctx, fileComplexity);
    if (directives.length > 0) {
      bodyLines.push("## Working Guidelines");
      bodyLines.push("");
      for (const d of directives) {
        bodyLines.push(`- ${d}`);
      }
      bodyLines.push("");
    }
  }

  // Only create the skill if there's meaningful content
  if (analysis.hubFiles.length === 0 && analysis.layers.length === 0) {
    return null;
  }

  return {
    name: "architecture",
    description: "Explore project architecture and key files",
    disableModelInvocation: false,
    allowedTools: "Read, Grep, Glob",
    body: bodyLines.join("\n"),
  };
}

/**
 * Build CLI-invoking skills that let the agent query Clarte on demand.
 * These are always generated regardless of analysis data.
 */
function buildClarteSkills(): ClaudeSkill[] {
  return [
    {
      name: "clarte-refresh",
      description: "Refresh the code snapshot in the context file to reflect recent source changes.",
      disableModelInvocation: true,
      allowedTools: "Bash",
      body: [
        "# Clarte Refresh",
        "",
        "Run `npx clarte --refresh-snapshot` to update the code snapshot.",
        "",
        "Use this skill when the user asks to refresh, update, or regenerate the context file.",
      ].join("\n"),
    },
    {
      name: "clarte-file",
      description:
        "Get detailed architectural analysis for a specific file: its role, centrality, what imports it, what it imports, related tests, and co-change partners.",
      disableModelInvocation: false,
      allowedTools: "Bash",
      body: [
        "# Clarte File Analysis",
        "",
        "To analyze a specific file's architectural role:",
        "",
        "1. Run `npx clarte --format=json` to get the full analysis",
        "2. Parse the JSON output",
        "3. Find the file in `analysis.hubFiles` for its role, centrality, and import counts",
        "4. Check `analysis.circularDeps` for cycles involving this file",
        "5. Check `analysis.testMapping.sourceToTests` for related test files",
        "6. Check `analysis.gitActivity.changeCoupling` for co-change partners",
        "",
        "Present a concise summary: role, how many files import it, what it imports, related tests, and files that frequently change with it.",
      ].join("\n"),
    },
    {
      name: "clarte-impact",
      description:
        "Assess the impact of modifying a file: what would break, which files to also check, and what tests to run.",
      disableModelInvocation: false,
      allowedTools: "Bash",
      body: [
        "# Clarte Impact Assessment",
        "",
        "To assess the impact of changing a file:",
        "",
        "1. Run `npx clarte --diff` to get change-aware context",
        "2. Or run `npx clarte --format=json` and analyze:",
        "   - Find the file in `analysis.hubFiles` for its role and `importedBy` count",
        "   - Check `analysis.circularDeps` for cycles it participates in",
        "   - Check `analysis.chokepoints` to see if it's a structural chokepoint",
        "   - Check `analysis.gitActivity.changeCoupling` for files that frequently co-change",
        "   - Check `analysis.testMapping.sourceToTests` for tests to run",
        "",
        "Present: risk level (based on role + importedBy count), files likely affected, co-change partners to also check, and tests to run.",
      ].join("\n"),
    },
  ];
}

/**
 * Build analysis skills from sections migrated out of the default CLAUDE.md.
 * Split into two skills so the agent has clear invocation signals:
 *   - coupling: file relationships (tight, hidden, change coupling)
 *   - code-health: structural risk (dead files, chokepoints, layer consistency)
 */
function buildAnalysisSkills(analysis: ContextAnalysis): ClaudeSkill[] {
  const COUPLING_IDS = new Set(["tight-coupling", "hidden-coupling", "change-coupling"]);
  const HEALTH_IDS = new Set(["dead-files", "chokepoints", "layer-consistency"]);

  const depSections = renderDependencySections(analysis);
  const gitSections = renderGitActivitySections(analysis);
  const lcSection = renderLayerConsistencySection(analysis);
  const allSections = [...depSections, ...gitSections, ...(lcSection ? [lcSection] : [])];

  const couplingSections = allSections.filter((s) => COUPLING_IDS.has(s.id));
  const healthSections = allSections.filter((s) => HEALTH_IDS.has(s.id));

  const skills: ClaudeSkill[] = [];

  if (couplingSections.length > 0) {
    skills.push({
      name: "coupling",
      description:
        "Analyze file coupling: which files frequently change together, which share many imports, and which have hidden dependencies",
      disableModelInvocation: false,
      body: couplingSections.map((s) => s.content).join("\n\n"),
    });
  }

  if (healthSections.length > 0) {
    skills.push({
      name: "code-health",
      description:
        "Analyze structural health: dead files that can be removed, architectural chokepoints, and layer consistency violations",
      disableModelInvocation: false,
      body: healthSections.map((s) => s.content).join("\n\n"),
    });
  }

  return skills;
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
