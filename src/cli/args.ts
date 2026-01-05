import path from "node:path";
import { theme as t, initTheme, resetTerminalColors } from "../theme.js";
import type { SectionFilterOptions } from "../templates/main-context.js";

declare const PKG_VERSION: string;
declare const PKG_NAME: string;
declare const PKG_DESCRIPTION: string;

export const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";
const NAME = typeof PKG_NAME !== "undefined" ? PKG_NAME : "clarte";
const DESCRIPTION = typeof PKG_DESCRIPTION !== "undefined" ? PKG_DESCRIPTION : "";

export function printHelp(): void {
  console.log("");
  console.log(t.textBold("Clart") + t.brandBold("\u00e9"));
  console.log(t.muted("  " + DESCRIPTION));
  console.log("");
  console.log(`  ${t.textBold("Usage:")}  ${t.text(`npx ${NAME} [directory] [options]`)}`);
  console.log("");
  console.log(`  ${t.textBold("Options:")}`);
  console.log(`    ${t.accent("-h, --help")}              ${t.text("Show this help message")}`);
  console.log(`    ${t.accent("-V, --version")}           ${t.text("Show version number")}`);
  console.log(`    ${t.accent("--force")}                 ${t.text("Overwrite existing files without asking")}`);
  console.log(`    ${t.accent("--dry-run")}               ${t.text("Preview what would be generated")}`);
  console.log(
    `    ${t.accent("--diff[=REF] [FILES]")}    ${t.text("Generate focused context for changed files (vs HEAD or REF)")}`,
  );
  console.log(`    ${t.accent("--diff-file=PATH")}        ${t.text("Write diff context to file instead of stdout")}`);
  console.log(`    ${t.accent("--reconfigure")}           ${t.text("Re-prompt even if .clarte.json exists")}`);
  console.log(
    `    ${t.accent("--refresh-snapshot")}      ${t.text("Re-scan source files, update code snapshot only")}`,
  );
  console.log(
    `    ${t.accent("--check")}                 ${t.text("Exit 0 if snapshot is fresh, 1 if stale (hash-based)")}`,
  );
  console.log(
    `    ${t.accent("--check=timestamp")}       ${t.text("Exit 0/1 based on age only (no Node.js needed in shell hooks)")}`,
  );
  console.log(
    `    ${t.accent("--ci")}                    ${t.text("Machine-readable output (use with --check for CI pipelines)")}`,
  );
  console.log(`    ${t.accent("--max-tokens=N")}          ${t.text("Set the token budget for the code snapshot")}`);
  console.log(
    `    ${t.accent("--format=json")}           ${t.text("Output full analysis as structured JSON to stdout")}`,
  );
  console.log(
    `    ${t.accent("--budget=N")}              ${t.text("Set token budget for the context file (prioritized sections)")}`,
  );
  console.log(`    ${t.accent("--full")}                  ${t.text("Disable token budget (include all sections)")}`);
  console.log(
    `    ${t.accent("--max-chars=N")}           ${t.text("Set character budget (default: 39500, 0 to disable)")}`,
  );
  console.log(
    `    ${t.accent("--include=a,b")}           ${t.text("Always include these sections (comma-separated IDs)")}`,
  );
  console.log(`    ${t.accent("--exclude=a,b")}           ${t.text("Exclude these sections entirely")}`);
  console.log(
    `    ${t.accent("--init-hook")}             ${t.text("Install git pre-commit hook for auto-refresh on commit")}`,
  );
  console.log(
    `    ${t.accent("--watch")}                 ${t.text("Watch for file changes and re-analyze continuously")}`,
  );
  console.log(`    ${t.accent("-v, --verbose")}           ${t.text("Show detailed progress output")}`);
  console.log(`    ${t.accent("--mcp")}                   ${t.text("Start MCP server for on-demand graph queries")}`);
  console.log("");
  console.log(`  ${t.textBold("Subcommands:")}`);
  console.log(
    `    ${t.accent("ci")}                      ${t.text("Analyze changed files and output risk assessment as JSON")}`,
  );
  console.log(`    ${t.accent("  --base=REF")}            ${t.text("Git ref to diff against (default: HEAD)")}`);
  console.log(
    `    ${t.accent("  --changed-files=a,b")}   ${t.text("Explicit list of changed files (comma-separated)")}`,
  );
  console.log("");
  console.log(`  ${t.textBold("Examples:")}`);
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME}`)}                   ${t.muted("# analyze current directory")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} ./my-project`)}      ${t.muted("# analyze a specific project")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} --diff`)}             ${t.muted("# focused context for uncommitted changes")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} --diff=main`)}        ${t.muted("# focused context vs main branch")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} --diff src/foo.ts`)}  ${t.muted("# diff context for a specific file")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} ci --base=main`)}     ${t.muted("# CI risk report for PR changes")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} --dry-run`)}          ${t.muted("# preview without writing files")}`,
  );
  console.log(
    `    ${t.muted("$")} ${t.text(`npx ${NAME} --refresh-snapshot`)} ${t.muted("# update code snapshot only")}`,
  );
  console.log("");
}

export interface CliArgs {
  rootDir: string;
  force: boolean;
  dryRun: boolean;
  refresh: boolean;
  reconfigure: boolean;
  diffMode: boolean;
  diffRef: string | undefined;
  diffFilterFiles: string[];
  diffFile: string | undefined;
  check: boolean;
  checkTimestamp: boolean;
  ciMode: boolean;
  ciSubcommand: boolean;
  ciBase: string | undefined;
  ciChangedFiles: string[];
  verbose: boolean;
  watchMode: boolean;
  maxTokens: number | undefined;
  jsonMode: boolean;
  effectiveBudget: number | undefined;
  sectionFilter: SectionFilterOptions | undefined;
  maxChars: number | undefined;
  initHook: boolean;
}

export function parseCliArgs(rawArgs: string[]): CliArgs {
  const force = rawArgs.includes("--force");
  const dryRun = rawArgs.includes("--dry-run");
  const refresh = rawArgs.includes("--refresh-snapshot");
  const reconfigure = rawArgs.includes("--reconfigure");
  const diffArg = rawArgs.find((a) => a === "--diff" || a.startsWith("--diff="));
  const diffMode = !!diffArg;
  const diffRef = diffArg?.startsWith("--diff=") ? diffArg.split("=")[1] : undefined;
  const diffFilterFiles: string[] = [];
  if (diffMode) {
    const diffIdx = rawArgs.indexOf(diffArg!);
    for (let i = diffIdx + 1; i < rawArgs.length; i++) {
      const a = rawArgs[i];
      if (a.startsWith("-")) break;
      diffFilterFiles.push(a);
    }
  }
  const checkArg = rawArgs.find((a) => a === "--check" || a.startsWith("--check="));
  const check = !!checkArg;
  const checkTimestamp = checkArg === "--check=timestamp";
  const ciMode = rawArgs.includes("--ci");
  const ciSubcommand = rawArgs[0] === "ci";
  const ciBaseArg = rawArgs.find((a) => a.startsWith("--base="));
  const ciBase = ciBaseArg?.split("=").slice(1).join("=");
  const ciChangedFilesArg = rawArgs.find((a) => a.startsWith("--changed-files="));
  const ciChangedFiles = ciChangedFilesArg
    ? ciChangedFilesArg.split("=").slice(1).join("=").split(",").filter(Boolean)
    : [];
  const verbose = rawArgs.includes("--verbose") || rawArgs.includes("-v");
  const watchMode = rawArgs.includes("--watch");
  const maxTokensArg = rawArgs.find((a) => a.startsWith("--max-tokens="));
  const maxTokensRaw = maxTokensArg ? parseInt(maxTokensArg.split("=").slice(1).join("="), 10) : undefined;
  if (maxTokensRaw !== undefined && Number.isNaN(maxTokensRaw)) {
    console.error(`Invalid --max-tokens value: ${maxTokensArg?.split("=").slice(1).join("=")}`);
    process.exit(1);
  }
  const maxTokens = maxTokensRaw;
  const formatArg = rawArgs.find((a) => a.startsWith("--format="));
  const jsonMode = formatArg?.split("=")[1] === "json";
  const budgetArg = rawArgs.find((a) => a.startsWith("--budget="));
  const budgetRaw = budgetArg ? parseInt(budgetArg.split("=").slice(1).join("="), 10) : undefined;
  if (budgetRaw !== undefined && Number.isNaN(budgetRaw)) {
    console.error(`Invalid --budget value: ${budgetArg?.split("=").slice(1).join("=")}`);
    process.exit(1);
  }
  const fullMode = rawArgs.includes("--full");
  const includeArg = rawArgs.find((a) => a.startsWith("--include="));
  const excludeArg = rawArgs.find((a) => a.startsWith("--exclude="));
  const sectionFilter: SectionFilterOptions | undefined =
    includeArg || excludeArg
      ? {
          include: includeArg ? new Set(includeArg.split("=").slice(1).join("=").split(",")) : undefined,
          exclude: excludeArg ? new Set(excludeArg.split("=").slice(1).join("=").split(",")) : undefined,
        }
      : undefined;
  const effectiveBudget = fullMode ? 0 : budgetRaw;
  const maxCharsArg = rawArgs.find((a) => a.startsWith("--max-chars="));
  const maxCharsRaw = maxCharsArg ? parseInt(maxCharsArg.split("=").slice(1).join("="), 10) : undefined;
  if (maxCharsRaw !== undefined && Number.isNaN(maxCharsRaw)) {
    console.error(`Invalid --max-chars value: ${maxCharsArg?.split("=").slice(1).join("=")}`);
    process.exit(1);
  }
  const initHook = rawArgs.includes("--init-hook");
  const diffFileArg = rawArgs.find((a) => a.startsWith("--diff-file="));
  const diffFile = diffFileArg?.split("=").slice(1).join("=");
  const diffFilterSet = new Set(diffFilterFiles);
  const subcommands = new Set(["ci"]);
  const targetDir =
    rawArgs.find((a) => !a.startsWith("-") && !diffFilterSet.has(a) && !subcommands.has(a)) ?? process.cwd();
  const rootDir = path.resolve(targetDir);

  if (diffFile && !diffMode) {
    console.error("[clarte] --diff-file requires --diff mode; ignoring.");
  }

  return {
    rootDir,
    force,
    dryRun,
    refresh,
    reconfigure,
    diffMode,
    diffRef,
    diffFilterFiles,
    diffFile,
    check,
    checkTimestamp,
    ciMode,
    ciSubcommand,
    ciBase,
    ciChangedFiles,
    verbose,
    watchMode,
    maxTokens,
    jsonMode,
    effectiveBudget,
    sectionFilter,
    maxChars: maxCharsRaw,
    initHook,
  };
}

/**
 * Handle early CLI exits (--help, --version) before main() runs.
 * Returns true if the process should exit.
 */
export function handleEarlyExits(rawArgs: string[]): boolean {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    initTheme("dark");
    printHelp();
    resetTerminalColors();
    process.exit(0);
  }

  if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
    console.log(VERSION);
    process.exit(0);
  }

  return false;
}
