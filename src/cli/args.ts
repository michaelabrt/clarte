import path from "node:path";
import { ClarteError, ExitCode } from "../core/errors.js";
import { theme as t, initTheme, resetTerminalColors } from "../core/theme.js";

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
  console.log(`    ${t.accent("--yes")}                   ${t.text("Overwrite existing files without asking")}`);
  console.log(`    ${t.accent("--dry-run")}               ${t.text("Preview what would be generated")}`);
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
  console.log(
    `    ${t.accent("--format=json")}           ${t.text("Output full analysis as structured JSON to stdout")}`,
  );
  console.log(
    `    ${t.accent("--init-hook")}             ${t.text("Install git pre-commit hook for auto-refresh on commit")}`,
  );
  console.log(`    ${t.accent("-v, --verbose")}           ${t.text("Show detailed progress output")}`);
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
  yes: boolean;
  dryRun: boolean;
  refresh: boolean;
  reconfigure: boolean;
  check: boolean;
  checkTimestamp: boolean;
  ciMode: boolean;
  ciSubcommand: boolean;
  ciBase: string | undefined;
  ciChangedFiles: string[];
  verbose: boolean;
  maxTokens: number | undefined;
  jsonMode: boolean;
  initHook: boolean;
}

export function parseCliArgs(rawArgs: string[]): CliArgs {
  const yes = rawArgs.includes("--yes");
  const dryRun = rawArgs.includes("--dry-run");
  const refresh = rawArgs.includes("--refresh-snapshot");
  const reconfigure = rawArgs.includes("--reconfigure");
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
  const maxTokensArg = rawArgs.find((a) => a.startsWith("--max-tokens="));
  const maxTokensRaw = maxTokensArg ? parseInt(maxTokensArg.split("=").slice(1).join("="), 10) : undefined;
  if (maxTokensRaw !== undefined && Number.isNaN(maxTokensRaw)) {
    throw new ClarteError(`Invalid --max-tokens value: ${maxTokensArg?.split("=").slice(1).join("=")}`);
  }
  const maxTokens = maxTokensRaw;
  const formatArg = rawArgs.find((a) => a.startsWith("--format="));
  const jsonMode = formatArg?.split("=")[1] === "json";
  const initHook = rawArgs.includes("--init-hook");
  const subcommands = new Set(["ci"]);
  const targetDir =
    rawArgs.find((a) => !a.startsWith("-") && !subcommands.has(a)) ??
    process.cwd();
  const rootDir = path.resolve(targetDir);

  if (dryRun && check) {
    throw new ClarteError("--dry-run and --check cannot be used together.", ExitCode.FAILURE);
  }

  // Warn on unknown flags
  const knownFlags = new Set([
    "--yes",
    "--dry-run",
    "--refresh-snapshot",
    "--reconfigure",
    "--check",
    "--ci",
    "--verbose",
    "-v",
    "--init-hook",
    "--help",
    "-h",
    "--version",
    "-V",
  ]);
  const knownPrefixes = [
    "--check=",
    "--max-tokens=",
    "--format=",
    "--base=",
    "--changed-files=",
  ];
  for (const arg of rawArgs) {
    if (!arg.startsWith("-")) continue;
    if (knownFlags.has(arg)) continue;
    if (knownPrefixes.some((p) => arg.startsWith(p))) continue;
    console.warn(`[clarte] Unknown flag: ${arg}`);
  }

  return {
    rootDir,
    yes,
    dryRun,
    refresh,
    reconfigure,
    check,
    checkTimestamp,
    ciMode,
    ciSubcommand,
    ciBase,
    ciChangedFiles,
    verbose,
    maxTokens,
    jsonMode,
    initHook,
  };
}

/**
 * Handle early CLI exits (--help, --version) before main() runs.
 * Returns true if the process should exit.
 */
export function handleEarlyExits(rawArgs: string[]): void {
  if (rawArgs.includes("--help") || rawArgs.includes("-h")) {
    initTheme("dark");
    printHelp();
    resetTerminalColors();
    process.exit(ExitCode.SUCCESS);
  }

  if (rawArgs.includes("--version") || rawArgs.includes("-V")) {
    console.log(VERSION);
    process.exit(ExitCode.SUCCESS);
  }
}
