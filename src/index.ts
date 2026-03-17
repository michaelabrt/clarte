import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError, ExitCode } from "./core/errors";
import {
  theme as t,
  initTheme,
  patchPicocolors,
  unpatchPicocolors,
  resetTerminalColors,
  detectTerminalBackground,
} from "./core/theme";
import { errorMessage, fileExists, writeJsonStdout } from "./core/utils";
import { loadConfig } from "./core/config/config";
import { refreshSnapshot } from "./cli/refresh";
import { initPreCommitHook } from "./cli/hooks";
import { handleEarlyExits, parseCliArgs } from "./cli/args";
import { runCheckMode } from "./cli/check";
import { runCiMode } from "./cli/ci";
import { runInitMode } from "./cli/init";
import { runObserveMode } from "./cli/observe";

const PROJECT_MARKERS = [
  "package.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
  "requirements.txt",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "Makefile",
  "CMakeLists.txt",
  "Gemfile",
  "composer.json",
];

function resolveColorScheme(savedConfig: { colorScheme?: "dark" | "light" } | null): "dark" | "light" {
  const envTheme = process.env.CLARTE_THEME;
  if (envTheme === "dark" || envTheme === "light") return envTheme;
  if (savedConfig?.colorScheme) return savedConfig.colorScheme;
  return detectTerminalBackground() ?? "dark";
}

async function main() {
  const rawArgs = process.argv.slice(2);

  handleEarlyExits(rawArgs);

  const args = parseCliArgs(rawArgs);
  const {
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
  } = args;

  if (initHook) {
    await initPreCommitHook(rootDir);
    process.exit(ExitCode.SUCCESS);
  }

  // Subcommand: observe
  if (args.observeSubcommand) {
    await runObserveMode({
      rootDir,
      sessionId: args.observeSessionId,
      all: args.observeAll,
      since: args.observeSince,
      json: jsonMode,
    });
    process.exit(ExitCode.SUCCESS);
  }

  if (ciSubcommand) {
    const result = await runCiMode(rootDir, ciChangedFiles.length > 0 ? ciChangedFiles : null, ciBase, verbose);
    await writeJsonStdout(result);
    process.exit(ExitCode.SUCCESS);
  }

  const hasProjectMarker = (await Promise.all(PROJECT_MARKERS.map((f) => fileExists(path.join(rootDir, f))))).some(
    Boolean,
  );

  if (!hasProjectMarker) {
    throw new ClarteError(
      `No project found at ${rootDir}. Run npx clarte from a project directory, or pass a path: npx clarte ./my-project`,
    );
  }

  if (check) {
    await runCheckMode(rootDir, checkTimestamp, ciMode);
  }

  const savedConfig = await loadConfig(rootDir);

  const colorScheme = jsonMode ? "dark" : resolveColorScheme(savedConfig);
  initTheme(colorScheme);
  patchPicocolors();

  if (!jsonMode) {
    console.log("");
    p.intro(t.textBold("Clart") + t.brandBold("\u00e9"));
    p.log.info(t.muted("the starting point your agent is missing"));
  }

  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.success("Snapshot refreshed!"));
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  await runInitMode({
    rootDir,
    yes,
    dryRun,
    reconfigure,
    verbose,
    jsonMode,
    maxTokens,
    savedConfig,
  });

  unpatchPicocolors();
}

main().catch((err) => {
  if (err instanceof ClarteError) {
    console.error(t.error(err.message));
    unpatchPicocolors();
    resetTerminalColors();
    process.exit(err.exitCode);
  }

  // Unexpected errors: provide context-specific messages
  const msg = errorMessage(err);

  if (msg.includes("ENOENT")) {
    console.error(t.error("File not found:"), msg);
  } else if (msg.includes("ETIMEDOUT") || /\btimeout\b/i.test(msg)) {
    console.error(t.error("Git operation timed out. Try reducing the analysis window with staleDays in .clarte.json."));
  } else if (msg.includes("TOML") || msg.includes("SyntaxError") || msg.includes("Unexpected token")) {
    console.error(t.error("Failed to parse config file:"), msg);
  } else {
    console.error(t.error("Fatal error:"), err);
  }

  unpatchPicocolors();
  resetTerminalColors();
  process.exit(ExitCode.FAILURE);
});
