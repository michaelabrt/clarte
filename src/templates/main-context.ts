import type { CodeSnapshot, ContextAnalysis, DetectedContext, UserAnswers } from "../types.js";
import { summarizeDetection } from "../detect.js";
import { getFrameworkHintsSection } from "./framework-hints.js";

/**
 * Build the main context file content (CLAUDE.md, AGENTS.md, or CONTEXT.md).
 */
export function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
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

  // -- Framework Conventions --
  const fwHints = getFrameworkHintsSection(ctx);
  if (fwHints) {
    sections.push(fwHints);
  }

  // -- Project Structure --
  if (ctx.directories.length > 0) {
    sections.push("## Project Structure");
    sections.push("");
    sections.push("```");
    sections.push(buildStructureTree(ctx));
    sections.push("```");
    sections.push("");
  }

  // -- Monorepo Structure --
  if (ctx.monorepo && ctx.monorepo.packages.length > 0) {
    sections.push("## Monorepo Structure");
    sections.push("");
    sections.push(
      `${ctx.monorepo.type} workspace with ${ctx.monorepo.packages.length} packages:`,
    );
    sections.push("");
    for (const pkg of ctx.monorepo.packages) {
      const fws =
        pkg.frameworks.length > 0
          ? ` — ${pkg.frameworks.map((f) => f.name).join(", ")}`
          : "";
      sections.push(`- **${pkg.name}** (\`${pkg.path}\`)${fws}`);
    }
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

  // -- Key Files (hub files) --
  if (analysis?.hubFiles && analysis.hubFiles.length > 0) {
    // Build instability lookup for flagging risky files
    const instabilityMap = new Map<string, number>();
    if (analysis.instabilities) {
      for (const inst of analysis.instabilities) {
        instabilityMap.set(inst.path, inst.instability);
      }
    }

    sections.push("## Key Files");
    sections.push("");
    sections.push(
      "These are the most interconnected files. Read these first for architectural understanding.",
    );
    sections.push("");
    sections.push("| File | Imported By | Stability |");
    sections.push("|------|-------------|-----------|");
    for (const hub of analysis.hubFiles) {
      const inst = instabilityMap.get(hub.path);
      const stabilityCell = inst != null
        ? `${(inst * 100).toFixed(0)}% unstable ⚠️`
        : "stable";
      sections.push(
        `| \`${hub.path}\` | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
    sections.push("");
  }

  // -- Architecture (layer ordering) --
  if (analysis?.layers && analysis.layers.length > 1) {
    sections.push("## Architecture");
    sections.push("");
    sections.push("Dependency flow (foundational → consumer):");
    sections.push("");
    const layerNames = analysis.layers.map((l) => `\`${l.name}\``);
    sections.push(layerNames.join(" → "));
    sections.push("");
  }

  // -- Recently Active Files --
  if (analysis?.gitActivity && analysis.gitActivity.hotFiles.length > 0) {
    sections.push("## Recently Active Files");
    sections.push("");
    sections.push("| File | Commits (90d) | Last Changed |");
    sections.push("|------|--------------|--------------|");
    for (const hot of analysis.gitActivity.hotFiles.slice(0, 10)) {
      sections.push(
        `| \`${hot.path}\` | ${hot.commits} | ${hot.lastChanged} |`,
      );
    }
    sections.push("");
  }

  // -- Change Coupling --
  if (analysis?.gitActivity?.changeCoupling && analysis.gitActivity.changeCoupling.length > 0) {
    sections.push("## Change Coupling");
    sections.push("");
    sections.push(
      "Files that frequently change together. Consider whether they should be colocated or decoupled.",
    );
    sections.push("");
    sections.push("| File A | File B | Co-changes | Confidence |");
    sections.push("|--------|--------|------------|------------|");
    for (const pair of analysis.gitActivity.changeCoupling) {
      sections.push(
        `| \`${pair.fileA}\` | \`${pair.fileB}\` | ${pair.coChangeCount} | ${(pair.confidence * 100).toFixed(0)}% |`,
      );
    }
    sections.push("");
  }

  // -- Circular Dependencies --
  if (analysis?.circularDeps && analysis.circularDeps.length > 0) {
    sections.push("## Circular Dependencies");
    sections.push("");
    sections.push(
      "> These circular import chains may cause unexpected behavior when modified.",
    );
    sections.push("");
    for (const dep of analysis.circularDeps) {
      sections.push(`- ${dep.chain.map((f) => `\`${f}\``).join(" -> ")}`);
    }
    sections.push("");
  }

  // -- Module Clusters --
  if (analysis?.communities && analysis.communities.length > 0) {
    sections.push("## Module Clusters");
    sections.push("");
    sections.push(
      "Automatically detected groups of tightly-connected files.",
    );
    sections.push("");
    for (const community of analysis.communities) {
      sections.push(`- **${community.label}** (${community.files.length} files): ${community.files.map((f) => `\`${f}\``).join(", ")}`);
    }
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
      const usage = fw.importCount != null ? ` (used in ${fw.importCount} file${fw.importCount === 1 ? "" : "s"})` : "";
      lines.push(`- **${fw.name}**${ver}${usage}`);
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
