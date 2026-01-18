import path from "node:path";
import type { ContextSection, DetectedContext, UserAnswers } from "../../types.js";
import { summarizeDetection } from "../../detect/detect.js";
import { estimateTokens, readJsonFile, readFileOr } from "../../utils.js";

// Cache for getProjectName to avoid redundant filesystem reads within a single
// generation. Ideally the project name would be threaded through
// DetectedContext.projectName, but types.ts is owned by another worker.
let _projectNameCache: { rootDir: string; name: string } | null = null;

export async function getProjectName(ctx: DetectedContext): Promise<string> {
  // Return cached result if available for the same rootDir
  if (_projectNameCache && _projectNameCache.rootDir === ctx.rootDir) {
    return _projectNameCache.name;
  }

  let name: string | null = null;

  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  if (pkg?.name && typeof pkg.name === "string") {
    name = pkg.name;
  }

  if (!name) {
    const cargo = await readFileOr(path.join(ctx.rootDir, "Cargo.toml"));
    if (cargo) {
      const match = cargo.match(/^\[package\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (match) name = match[1];
    }
  }

  if (!name) {
    const gomod = await readFileOr(path.join(ctx.rootDir, "go.mod"));
    if (gomod) {
      const match = gomod.match(/^module\s+(\S+)/m);
      if (match) {
        const parts = match[1].split("/");
        name = parts[parts.length - 1];
      }
    }
  }

  if (!name) {
    const pyproject = await readFileOr(path.join(ctx.rootDir, "pyproject.toml"));
    if (pyproject) {
      const match = pyproject.match(/^\[project\][\s\S]*?^name\s*=\s*"([^"]+)"/m);
      if (match) name = match[1];
    }
  }

  if (!name) {
    const dirName = path.basename(ctx.rootDir) || "Project";
    name = dirName.charAt(0).toUpperCase() + dirName.slice(1);
  }

  _projectNameCache = { rootDir: ctx.rootDir, name };
  return name;
}

/**
 * Reset the project name cache. Called at the start of buildSections()
 * to ensure fresh results per generation run.
 * Exported for testing.
 */
export function resetProjectNameCache(): void {
  _projectNameCache = null;
}

export async function renderProjectInfoSections(
  ctx: DetectedContext,
  answers: UserAnswers,
  projectName: string,
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];
  const stackSummary = answers.stackConfirmed
    ? summarizeDetection(ctx)
    : answers.stackCorrections || summarizeDetection(ctx);

  const headerLines: string[] = [];
  headerLines.push(`# ${projectName}`);
  headerLines.push("");
  headerLines.push(
    "> **Keep this file up to date.** When you change the architecture, add a dependency, create a new pattern, or learn a gotcha, update this file in the same step. This is the source of truth for how the project works.",
  );
  headerLines.push(
    "> **This file is your starting point.** Only read additional files when the task requires implementation details not captured here.",
  );
  if (answers.ides.includes("cursor")) {
    headerLines.push("> Scoped rules are in `.cursor/rules/` -- update them when conventions change.");
  }
  const headerContent = headerLines.join("\n");
  sections.push({ id: "header", priority: 0, content: headerContent, tokens: estimateTokens(headerContent) });

  // What Is This (skip when projectPurpose is empty, e.g. zero-config runs)
  if (answers.projectPurpose) {
    const whatContent = `## What Is This\n\n${answers.projectPurpose}`;
    sections.push({ id: "what-is-this", priority: 0, content: whatContent, tokens: estimateTokens(whatContent) });
  }

  const techContent = `## Tech Stack\n\n${buildTechStackSection(ctx, stackSummary)}`;
  sections.push({ id: "tech-stack", priority: 1, content: techContent, tokens: estimateTokens(techContent) });

  if (answers.keyPatterns) {
    const patLines: string[] = [];
    patLines.push("## Key Patterns");
    patLines.push("");
    const patterns = answers.keyPatterns
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const p of patterns) {
      patLines.push(`- ${p}`);
    }
    const patContent = patLines.join("\n");
    sections.push({ id: "key-patterns", priority: 0, content: patContent, tokens: estimateTokens(patContent) });
  }

  if (answers.gotchas) {
    const gotLines: string[] = [];
    gotLines.push("## Gotchas");
    gotLines.push("");
    const gotchas = answers.gotchas
      .split(/\n/)
      .map((s) => s.trim())
      .filter(Boolean);
    for (const g of gotchas) {
      gotLines.push(`- ${g}`);
    }
    const gotContent = gotLines.join("\n");
    sections.push({ id: "gotchas", priority: 0, content: gotContent, tokens: estimateTokens(gotContent) });
  }

  const devContent = `## Development\n\n${await buildDevSection(ctx)}`;
  sections.push({ id: "development", priority: 0, content: devContent, tokens: estimateTokens(devContent) });

  return sections;
}

function buildTechStackSection(ctx: DetectedContext, summary: string): string {
  const lines: string[] = [];

  if (ctx.frameworks.length > 0) {
    for (const fw of ctx.frameworks) {
      const ver = fw.version ? ` ${fw.version}` : "";
      const usage =
        fw.importCount != null
          ? fw.importCount === 0
            ? " (config-only)"
            : ` (used in ${fw.importCount} file${fw.importCount === 1 ? "" : "s"})`
          : "";
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

async function buildDevSection(ctx: DetectedContext): Promise<string> {
  const lines: string[] = [];

  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};

  const runPrefix = (script: string) => {
    switch (ctx.packageManager) {
      case "pnpm":
        return `pnpm ${script}`;
      case "yarn":
        return `yarn ${script}`;
      case "bun":
        return `bun run ${script}`;
      case "npm":
        return `npm run ${script}`;
      default:
        return `npm run ${script}`;
    }
  };

  const installCmd = (() => {
    switch (ctx.packageManager) {
      case "pnpm":
        return "pnpm install";
      case "yarn":
        return "yarn install";
      case "bun":
        return "bun install";
      case "npm":
        return "npm install";
      default:
        return null;
    }
  })();

  switch (ctx.packageManager) {
    case "pnpm":
    case "yarn":
    case "bun":
    case "npm": {
      lines.push("```bash");
      if (installCmd) lines.push(installCmd);
      const devScript = scripts.dev ? "dev" : scripts.start ? "start" : scripts.serve ? "serve" : null;
      if (devScript) lines.push(runPrefix(devScript));
      lines.push("```");

      if (scripts.test) {
        lines.push("");
        lines.push("```bash");
        lines.push(runPrefix("test"));
        lines.push("```");
      }
      if (scripts.build) {
        lines.push("");
        lines.push("```bash");
        lines.push(runPrefix("build"));
        lines.push("```");
      }
      break;
    }
    case "pip":
    case "poetry": {
      const poetryPrefix = ctx.packageManager === "poetry" ? "poetry run " : "";
      lines.push("```bash");
      lines.push(ctx.packageManager === "poetry" ? "poetry install" : "pip install -r requirements.txt");

      const fwNames = ctx.frameworks.map((f) => f.name);
      if (fwNames.includes("Django")) {
        lines.push(`${poetryPrefix}python manage.py runserver`);
      } else if (fwNames.includes("FastAPI")) {
        lines.push(`${poetryPrefix}uvicorn app.main:app --reload`);
      } else if (fwNames.includes("Flask")) {
        lines.push(`${poetryPrefix}flask run`);
      }

      lines.push("```");

      if (fwNames.includes("pytest")) {
        lines.push("");
        lines.push("```bash");
        lines.push(`${poetryPrefix}pytest`);
        lines.push("```");
      }
      break;
    }
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

  if (ctx.linter !== "none") {
    lines.push("");
    lines.push(`Linter: **${ctx.linter}**`);
  }

  lines.push("");
  lines.push("After significant changes, use `/check` to verify no architectural regressions.");

  return lines.join("\n");
}
