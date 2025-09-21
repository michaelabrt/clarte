import path from "node:path";
import type { ArchitecturalLayer, CodeSnapshot, ContextAnalysis, DetectedContext, IDETarget, LayerEdge, UserAnswers } from "../types.js";
import { summarizeDetection } from "../detect.js";
import { readJsonFile, readFileOr } from "../utils.js";
import { getFrameworkHintsSection } from "./framework-hints.js";
import { renderConstraintsSection } from "../config-scan.js";

/**
 * Build the main context file content (CLAUDE.md, AGENTS.md, or CONTEXT.md).
 */
export async function buildMainContext(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  analysis?: ContextAnalysis,
): Promise<string> {
  const projectName = await getProjectName(ctx);
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
  sections.push(
    "> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.",
  );

  if (answers.ides.includes("cursor")) {
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

  // -- Config Constraints --
  if (analysis?.configConstraints) {
    const constraintsSection = renderConstraintsSection(analysis.configConstraints);
    if (constraintsSection) {
      sections.push(constraintsSection);
      sections.push("");
    }
  }

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
          ? ` (${pkg.frameworks.map((f) => f.name).join(", ")})`
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
      const roleTag = hub.role !== "Leaf" ? ` (${hub.role})` : "";
      sections.push(
        `| \`${hub.path}\`${roleTag} | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
    sections.push("");
  }

  // -- Architecture (layer ordering) --
  if (analysis?.layers && analysis.layers.length > 1) {
    sections.push("## Architecture");
    sections.push("");
    const diagram = renderArchitectureDiagram(analysis.layers, analysis.layerEdges ?? []);
    sections.push(diagram);
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
      "Files that frequently change together — when modifying one, check if the other needs updates too.",
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

  // -- Dead Files --
  if (analysis?.deadFiles && analysis.deadFiles.length > 0) {
    sections.push("## Dead Files");
    sections.push("");
    sections.push(
      "Files not imported by any other source file. Candidates for removal or missing entry points.",
    );
    sections.push("");
    for (const file of analysis.deadFiles.slice(0, 15)) {
      sections.push(`- \`${file}\``);
    }
    if (analysis.deadFiles.length > 15) {
      sections.push(`- ... and ${analysis.deadFiles.length - 15} more`);
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
  sections.push(await buildDevSection(ctx));
  sections.push("");

  return sections.join("\n").trimEnd() + "\n";
}

/**
 * Render a compact architecture diagram showing dependency flow.
 * Uses inline `types → stores → ...` format to save context tokens.
 */
function renderArchitectureDiagram(layers: ArchitecturalLayer[], layerEdges: LayerEdge[]): string {
  const layerNames = layers.map((l) => `\`${l.name}\``);
  const lines: string[] = [];

  lines.push("Dependency flow (foundational → consumer):");
  lines.push("");
  lines.push(layerNames.join(" → "));

  // Show cross-layer edges that don't follow the main flow
  const mainFlow = new Set<string>();
  for (let i = 0; i < layers.length - 1; i++) {
    mainFlow.add(`${layers[i].name}->${layers[i + 1].name}`);
  }
  const crossEdges = layerEdges.filter(
    (e) => !mainFlow.has(`${e.from}->${e.to}`),
  );
  if (crossEdges.length > 0) {
    lines.push("");
    lines.push(
      "Cross-layer edges: " +
        crossEdges.map((e) => `${e.from} → ${e.to}`).join(", "),
    );
  }

  return lines.join("\n");
}

async function getProjectName(ctx: DetectedContext): Promise<string> {
  // 1. package.json name field
  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  if (pkg?.name && typeof pkg.name === "string") return pkg.name;

  // 2. Cargo.toml [package] name
  const cargo = await readFileOr(path.join(ctx.rootDir, "Cargo.toml"));
  if (cargo) {
    const match = cargo.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  }

  // 3. go.mod module path (last segment)
  const gomod = await readFileOr(path.join(ctx.rootDir, "go.mod"));
  if (gomod) {
    const match = gomod.match(/^module\s+(\S+)/m);
    if (match) {
      const parts = match[1].split("/");
      return parts[parts.length - 1];
    }
  }

  // 4. pyproject.toml [project] name
  const pyproject = await readFileOr(path.join(ctx.rootDir, "pyproject.toml"));
  if (pyproject) {
    const match = pyproject.match(/^\[project\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
    if (match) return match[1];
  }

  // 5. Fallback: directory name
  const dirName = ctx.rootDir.split("/").pop() ?? "Project";
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

async function buildDevSection(ctx: DetectedContext): Promise<string> {
  const lines: string[] = [];

  // For JS/TS projects, read actual scripts from package.json
  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};

  // Determine the run prefix for JS package managers
  const runPrefix = (script: string) => {
    switch (ctx.packageManager) {
      case "pnpm": return `pnpm ${script}`;
      case "yarn": return `yarn ${script}`;
      case "bun": return `bun run ${script}`;
      case "npm": return `npm run ${script}`;
      default: return `npm run ${script}`;
    }
  };

  const installCmd = (() => {
    switch (ctx.packageManager) {
      case "pnpm": return "pnpm install";
      case "yarn": return "yarn install";
      case "bun": return "bun install";
      case "npm": return "npm install";
      default: return null;
    }
  })();

  switch (ctx.packageManager) {
    case "pnpm":
    case "yarn":
    case "bun":
    case "npm": {
      lines.push("```bash");
      if (installCmd) lines.push(installCmd);
      // Pick the best dev command from actual scripts
      const devScript = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
      if (devScript) lines.push(runPrefix(devScript));
      lines.push("```");

      // Add test command if it exists
      if (scripts.test) {
        lines.push("");
        lines.push("```bash");
        lines.push(runPrefix("test"));
        lines.push("```");
      }
      break;
    }
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
