import path from "node:path";
import type { ContextAnalysis, ContextSection, DetectedContext, UserAnswers } from "../../../core/types.js";
import { summarizeDetection } from "../../../core/detect/detect.js";
import { renderConstraintsSection } from "../../../core/config/scan.js";
import { estimateTokens, readJsonFile, readFileOr } from "../../../core/utils.js";
import { getFrameworkHintsSection } from "../framework-hints.js";

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
  analysis?: ContextAnalysis,
): Promise<ContextSection[]> {
  const sections: ContextSection[] = [];
  const stackSummary = answers.stackConfirmed
    ? summarizeDetection(ctx)
    : answers.stackCorrections || summarizeDetection(ctx);

  // Header
  const headerLines: string[] = [];
  headerLines.push(`# ${projectName}`);
  if (answers.projectPurpose) {
    headerLines.push("");
    headerLines.push(`> ${answers.projectPurpose}`);
  }
  const headerContent = headerLines.join("\n");
  sections.push({ id: "header", priority: 0, content: headerContent, tokens: estimateTokens(headerContent) });

  // Tech Stack
  const techContent = `## Tech Stack\n\n${buildTechStackSection(ctx, stackSummary)}`;
  sections.push({ id: "tech-stack", priority: 0, content: techContent, tokens: estimateTokens(techContent) });

  // Behavioral (two imperative lines, no heading - proven +2 turns when removed)
  const behavioralText =
    "Do not use Grep or Glob to explore the codebase upfront. Based on the task description, open the most relevant files directly. Only broaden your search if your first attempt doesn't find the right code. When searching is needed, prefer clarte-grep over plain grep for graph-annotated results.\nAfter editing, run tests once. Do not re-run tests to reformat output. If tests pass, stop.";
  sections.push({
    id: "behavioral",
    priority: 0,
    content: behavioralText,
    tokens: estimateTokens(behavioralText),
  });

  // Config Constraints (from analysis if available)
  if (analysis?.configConstraints) {
    const constraintsContent = renderConstraintsSection(analysis.configConstraints);
    if (constraintsContent) {
      sections.push({
        id: "config-constraints",
        priority: 0,
        content: constraintsContent,
        tokens: estimateTokens(constraintsContent),
      });
    }
  }

  // Key Files (proven -19pp pass rate when removed)
  if (analysis?.hubFiles && analysis.hubFiles.length > 0) {
    const instabilityMap = new Map<string, number>();
    if (analysis.instabilities) {
      for (const inst of analysis.instabilities) {
        instabilityMap.set(inst.path, inst.instability);
      }
    }
    const keyLines: string[] = [];
    keyLines.push("## Key Files");
    keyLines.push("");
    keyLines.push("Most interconnected files. Read these first for architectural understanding.");
    keyLines.push("");
    keyLines.push("| File | Imported By | I |");
    keyLines.push("|------|-------------|---|");
    for (const hub of analysis.hubFiles) {
      const inst = instabilityMap.get(hub.path);
      const stabilityCell = inst == null ? "stable" : `I=${(inst * 100).toFixed(0)}%`;
      const roleTag = hub.role !== "Leaf" ? ` (${hub.role})` : "";
      keyLines.push(
        `| \`${hub.path}\`${roleTag} | ${hub.importedBy} file${hub.importedBy === 1 ? "" : "s"} | ${stabilityCell} |`,
      );
    }
    const keyContent = keyLines.join("\n");
    // Priority 1: proven -19pp pass rate when removed but not always needed. Budget can shed this.
    sections.push({ id: "key-files", priority: 1, content: keyContent, tokens: estimateTokens(keyContent) });
  }

  // Change Coupling (proven +1 turn when removed)
  if (analysis?.gitActivity?.changeCoupling && analysis.gitActivity.changeCoupling.length > 0) {
    const ccLines: string[] = [];
    ccLines.push("## Change Coupling");
    ccLines.push("");
    ccLines.push("Files that frequently change together -- when modifying one, check if the other needs updates too.");
    ccLines.push("");
    ccLines.push("| File A | File B | Co-changes | Confidence |");
    ccLines.push("|--------|--------|------------|------------|");
    for (const pair of analysis.gitActivity.changeCoupling) {
      const ab = pair.confidenceAB ?? pair.confidence;
      const ba = pair.confidenceBA ?? pair.confidence;
      const diff = Math.abs(ab - ba);
      let confLabel: string;
      if (diff >= 0.2 && (ab >= 0.6 || ba >= 0.6)) {
        confLabel = ab > ba ? `A->B ${(ab * 100).toFixed(0)}%` : `B->A ${(ba * 100).toFixed(0)}%`;
      } else {
        confLabel = `${(pair.confidence * 100).toFixed(0)}%`;
      }
      ccLines.push(`| \`${pair.fileA}\` | \`${pair.fileB}\` | ${pair.coChangeCount} | ${confLabel} |`);
    }
    const ccContent = ccLines.join("\n");
    // Priority 1: proven +1 turn when removed but not always needed. Budget can shed this.
    sections.push({ id: "change-coupling", priority: 1, content: ccContent, tokens: estimateTokens(ccContent) });
  }

  // Development
  const devContent = `## Development\n\n${await buildDevSection(ctx)}`;
  sections.push({ id: "development", priority: 0, content: devContent, tokens: estimateTokens(devContent) });

  // Framework Conventions (priority 3: shed when budget is tight, untested in ablation)
  const fwContent = getFrameworkHintsSection(ctx);
  if (fwContent) {
    sections.push({ id: "framework-hints", priority: 3, content: fwContent, tokens: estimateTokens(fwContent) });
  }

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

const SLOW_COMPILE_RE = /\b(gulp|tsc|compile)\b.*&&/;

async function buildDevSection(ctx: DetectedContext): Promise<string> {
  const lines: string[] = [];

  const pkg = await readJsonFile(path.join(ctx.rootDir, "package.json"));
  const scripts = (pkg?.scripts as Record<string, string> | undefined) ?? {};
  const hasSlowCompile = (() => {
    const rawTest = scripts.test ?? "";
    if (!SLOW_COMPILE_RE.test(rawTest)) return false;
    // tsc --noEmit is type-checking only, not compilation
    const segments = rawTest.split("&&").map((p) => p.trim());
    const compileSegs = segments.filter((p) => /\b(gulp|tsc|compile)\b/.test(p));
    return compileSegs.some((p) => !(/\btsc\b/.test(p) && /--noEmit\b/.test(p)));
  })();

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
        if (hasSlowCompile) {
          const compileCmd = scripts.compile ? runPrefix("compile") : runPrefix("test");
          lines.push("");
          lines.push(
            `Note: \`${runPrefix("test")}\` includes a compilation step. After source edits, recompile with \`${compileCmd}\` before running tests.`,
          );
        }
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

  if (ctx.testFramework) {
    lines.push("");
    if (hasSlowCompile) {
      lines.push(
        "Always use `.clarte/scripts/check-tests.sh` instead of running tests directly. It runs the fast test step (no recompilation) and appends a structured summary. Recompile first when source files changed (see note above).",
      );
    } else {
      lines.push(
        "Always use `.clarte/scripts/check-tests.sh` instead of running tests directly. It runs the same test command but appends a one-line structured summary (pass/fail counts and failure names).",
      );
    }

    const hasRunTest = ["Mocha", "Jest", "Vitest", "pytest"].includes(ctx.testFramework);
    if (hasRunTest) {
      lines.push("");
      if (hasSlowCompile) {
        lines.push(
          "Always use `.clarte/scripts/run-tests.sh '<pattern>'` to run a subset of tests by name. It compiles automatically before running - never run the compile step separately. Never run the full suite when you only need to verify specific tests.",
        );
      } else {
        lines.push(
          "Always use `.clarte/scripts/run-tests.sh '<pattern>'` to run a subset of tests by name. Never run the full suite when you only need to verify specific tests.",
        );
      }
    }
  }

  lines.push("");
  lines.push(
    "When tests pass, commit immediately. Do not re-run tests on unmodified code to check for pre-existing failures - note any unrelated failures in the commit message instead.",
  );
  lines.push("");
  lines.push("After significant changes, use `/check` to verify no architectural regressions.");

  return lines.join("\n");
}
