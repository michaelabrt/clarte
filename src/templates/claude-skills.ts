import type { ClaudeSkill, ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";
import { buildDirectives } from "./directives.js";

/**
 * Build Claude Code skills based on detected project context.
 * @param scripts - Record of script name -> command from package.json (or equivalent)
 */
export function buildClaudeSkills(
  ctx: DetectedContext,
  answers: UserAnswers,
  analysis?: ContextAnalysis,
  scripts?: Record<string, string>,
): ClaudeSkill[] {
  const skills: ClaudeSkill[] = [];

  // Script-based skills from package.json
  if (scripts) {
    skills.push(...buildScriptSkills(ctx, scripts));
  }

  // Architecture exploration skill
  const archSkill = buildArchitectureSkill(analysis, ctx);
  if (archSkill) skills.push(archSkill);

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
      body: [
        `# ${config.description}`,
        "",
        `Run: \`${command}\``,
      ].join("\n"),
    });
  }

  return skills;
}

function getRunCommand(ctx: DetectedContext): string {
  switch (ctx.packageManager) {
    case "pnpm": return "pnpm";
    case "yarn": return "yarn";
    case "bun": return "bun run";
    case "npm": return "npm run";
    case "cargo": return "cargo";
    case "go": return "go";
    default: return "npm run";
  }
}

/**
 * Build an architecture exploration skill with hub files, layers, circular deps, and directives.
 */
function buildArchitectureSkill(analysis?: ContextAnalysis, ctx?: DetectedContext): ClaudeSkill | null {
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
      bodyLines.push(`- \`${hub.path}\` — ${hub.role} (imported by ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"})`);
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
      const severity = dep.severity != null
        ? dep.severity === 0 ? " (type-only)" : dep.severity < 1 ? " (mixed)" : ""
        : "";
      const hint = dep.breakHint ? ` -- ${dep.breakHint}` : "";
      bodyLines.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}${severity}${hint}`);
    }
    bodyLines.push("");
  }

  // Working guidelines
  if (ctx) {
    const directives = buildDirectives(analysis, ctx);
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
 * Render a ClaudeSkill as YAML frontmatter + markdown body.
 */
export function renderClaudeSkill(skill: ClaudeSkill): string {
  const lines: string[] = [
    "---",
    `description: ${skill.description}`,
  ];

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
