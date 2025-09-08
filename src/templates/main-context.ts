import type { CodeSnapshot, DetectedContext, UserAnswers } from "../types.js";
import { summarizeDetection } from "../detect.js";

/**
 * Build the main context file content (CLAUDE.md, AGENTS.md, or CONTEXT.md).
 */
export function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
): string {
  const projectName = getProjectName(ctx);
  const stackSummary = answers.stackConfirmed
    ? summarizeDetection(ctx)
    : answers.stackCorrections || summarizeDetection(ctx);

  const sections: string[] = [];

  // -- Header --
  sections.push(`# ${projectName}`);
  sections.push("");

  // -- Maintenance directive --
  sections.push(
    "> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.",
  );

  if (answers.ide === "cursor") {
    sections.push(
      "> Scoped rules are in `.cursor/rules/` -- update them when conventions change.",
    );
  }

  sections.push("");

  // -- What Is This --
  sections.push("## What Is This");
  sections.push("");
  sections.push(answers.projectPurpose);
  sections.push("");

  // -- Tech Stack --
  sections.push("## Tech Stack");
  sections.push("");
  sections.push(buildTechStackSection(ctx, stackSummary));
  sections.push("");

  // -- Project Structure --
  if (ctx.directories.length > 0) {
    sections.push("## Project Structure");
    sections.push("");
    sections.push("```");
    sections.push(buildStructureTree(ctx));
    sections.push("```");
    sections.push("");
  }

  // -- Code Snapshot --
  if (snapshot?.markdown) {
    sections.push("## Code Snapshot");
    sections.push("");
    sections.push(
      "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->",
    );
    sections.push("");
    sections.push(snapshot.markdown);
    sections.push("");
    sections.push("<!-- /CODE SNAPSHOT -->");
    sections.push("");
  }

  // -- Key Patterns --
  if (answers.keyPatterns) {
    sections.push("## Key Patterns");
    sections.push("");
    // Split on newlines or periods to create bullet points
    const patterns = answers.keyPatterns
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of patterns) {
      sections.push(`- ${p}`);
    }
    sections.push("");
  }

  // -- Gotchas --
  if (answers.gotchas) {
    sections.push("## Gotchas");
    sections.push("");
    const gotchas = answers.gotchas
      .split(/[.\n]/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const g of gotchas) {
      sections.push(`- ${g}`);
    }
    sections.push("");
  }

  // -- Development --
  sections.push("## Development");
  sections.push("");
  sections.push(buildDevSection(ctx));
  sections.push("");

  return sections.join("\n").trimEnd() + "\n";
}

function getProjectName(ctx: DetectedContext): string {
  // Extract from directory name
  const dirName = ctx.rootDir.split("/").pop() ?? "Project";
  // Capitalize first letter
  return dirName.charAt(0).toUpperCase() + dirName.slice(1);
}

function buildTechStackSection(ctx: DetectedContext, summary: string): string {
  const lines: string[] = [];

  if (ctx.frameworks.length > 0) {
    for (const fw of ctx.frameworks) {
      const ver = fw.version ? ` ${fw.version}` : "";
      lines.push(`- **${fw.name}**${ver}`);
    }
  }

  if (ctx.hasTypeScript) {
    lines.push("- **TypeScript**");
  }

  if (ctx.linter !== "none") {
    const name = ctx.linter.charAt(0).toUpperCase() + ctx.linter.slice(1);
    lines.push(`- **${name}** (linter/formatter)`);
  }

  if (ctx.packageManager !== "none") {
    lines.push(`- **${ctx.packageManager}** (package manager)`);
  }

  if (lines.length === 0) {
    lines.push(`Stack: ${summary}`);
  }

  return lines.join("\n");
}

function buildStructureTree(ctx: DetectedContext): string {
  // Group directories by top-level
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

  for (const [dir, children] of grouped) {
    lines.push(`${dir}/`);
    for (const child of children) {
      lines.push(`  ${child}/`);
    }
  }

  return lines.join("\n");
}

function buildDevSection(ctx: DetectedContext): string {
  const lines: string[] = [];

  // Run command
  switch (ctx.packageManager) {
    case "pnpm":
      lines.push("```bash");
      lines.push("pnpm install");
      lines.push("pnpm dev");
      lines.push("```");
      break;
    case "yarn":
      lines.push("```bash");
      lines.push("yarn install");
      lines.push("yarn dev");
      lines.push("```");
      break;
    case "bun":
      lines.push("```bash");
      lines.push("bun install");
      lines.push("bun dev");
      lines.push("```");
      break;
    case "npm":
      lines.push("```bash");
      lines.push("npm install");
      lines.push("npm run dev");
      lines.push("```");
      break;
    case "pip":
    case "poetry":
      lines.push("```bash");
      lines.push(
        ctx.packageManager === "poetry"
          ? "poetry install"
          : "pip install -r requirements.txt",
      );
      lines.push("```");
      break;
    case "cargo":
      lines.push("```bash");
      lines.push("cargo build");
      lines.push("cargo run");
      lines.push("```");
      break;
    case "go":
      lines.push("```bash");
      lines.push("go build ./...");
      lines.push("go run .");
      lines.push("```");
      break;
    default:
      lines.push("(add your build/run commands here)");
  }

  // Lint command
  if (ctx.linter !== "none") {
    lines.push("");
    lines.push(`Linter: **${ctx.linter}**`);
  }

  return lines.join("\n");
}

/**
 * Get the filename for the main context file based on IDE target.
 */
export function getMainContextFilename(ide: UserAnswers["ide"]): string {
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
