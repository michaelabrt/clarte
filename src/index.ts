import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError, ExitCode } from "./errors.js";
import {
  theme as t,
  initTheme,
  patchPicocolors,
  unpatchPicocolors,
  resetTerminalColors,
  detectTerminalBackground,
} from "./theme.js";
import { fileExists } from "./utils.js";
import { loadConfig } from "./config/config.js";
import { refreshSnapshot } from "./modes/refresh.js";
import { initPreCommitHook } from "./cli/hooks.js";
import { runDiffMode } from "./modes/diff.js";
import { runWatchMode } from "./modes/watch.js";
import { handleEarlyExits, parseCliArgs } from "./cli/args.js";
import { runCheckMode } from "./cli/check.js";
import { runCiMode } from "./cli/ci.js";
import { runGenerateMode } from "./modes/generate.js";

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

async function main() {
  const rawArgs = process.argv.slice(2);

  handleEarlyExits(rawArgs);

  const {
    rootDir,
    yes,
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
    maxChars,
    initHook,
    learnSubcommand,
    learnSessionPath,
    runSubcommand,
    runTaskDescription,
    runPassthroughArgs,
    serveSubcommand,
    mcpMode,
  } = parseCliArgs(rawArgs);

  if (initHook) {
    await initPreCommitHook(rootDir);
    process.exit(ExitCode.SUCCESS);
  }

  if (ciSubcommand) {
    const result = await runCiMode(rootDir, ciChangedFiles.length > 0 ? ciChangedFiles : null, ciBase, verbose);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n", (err) => (err ? reject(err) : resolve()));
    });
    process.exit(ExitCode.SUCCESS);
  }

  if (learnSubcommand) {
    if (!learnSessionPath) {
      throw new ClarteError("Usage: clarte learn <session-log.jsonl>");
    }
    const { runLearnMode } = await import("./cli/learn.js");
    const result = await runLearnMode(rootDir, learnSessionPath, verbose, jsonMode);
    if (jsonMode) {
      await new Promise<void>((resolve, reject) => {
        process.stdout.write(JSON.stringify(result, null, 2) + "\n", (err) => (err ? reject(err) : resolve()));
      });
    }
    process.exit(ExitCode.SUCCESS);
  }

  if (runSubcommand) {
    if (!runTaskDescription) {
      throw new ClarteError('Usage: clarte run "task description" [-- claude flags]');
    }
    const { runRunMode } = await import("./cli/run.js");
    const code = await runRunMode(rootDir, runTaskDescription, runPassthroughArgs, verbose);
    process.exit(code);
  }

  if (serveSubcommand) {
    const { runServeMode } = await import("./modes/serve.js");
    await runServeMode(rootDir);
    return;
  }

  const hasProjectMarker = (await Promise.all(PROJECT_MARKERS.map((f) => fileExists(path.join(rootDir, f))))).some(
    Boolean,
  );

  if (!hasProjectMarker) {
    throw new ClarteError(
      `No project found at ${rootDir}. Run npx clarte from a project directory, or pass a path: npx clarte ./my-project`,
    );
  }

  if (watchMode) {
    await runWatchMode(rootDir, verbose);
    return;
  }

  if (check) {
    await runCheckMode(rootDir, checkTimestamp, ciMode);
  }

  const savedConfig = await loadConfig(rootDir);

  let colorScheme: "dark" | "light" = "dark";
  if (jsonMode) {
    initTheme("dark");
    patchPicocolors();
  } else {
    const envTheme = process.env.CLARTE_THEME;
    if (envTheme === "dark" || envTheme === "light") {
      colorScheme = envTheme;
    } else {
      if (savedConfig?.colorScheme) {
        colorScheme = savedConfig.colorScheme;
      } else {
        const detected = detectTerminalBackground();
        if (detected) colorScheme = detected;
      }
    }
    initTheme(colorScheme);
    patchPicocolors();
  }

  if (!jsonMode) {
    console.log("");
    p.intro(t.textBold("Clart") + t.brandBold("\u00e9"));
    p.log.info(t.muted("architecture intelligence for AI coding agents"));
  }

  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.success("Snapshot refreshed!"));
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  if (diffMode) {
    p.log.info(t.muted("diff-aware context"));
    await runDiffMode(rootDir, diffRef, verbose, diffFile, diffFilterFiles);
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  await runGenerateMode({
    rootDir,
    yes,
    dryRun,
    reconfigure,
    verbose,
    jsonMode,
    maxTokens,
    effectiveBudget,
    sectionFilter,
    maxChars,
    savedConfig,
    mcpMode,
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
  const msg = err instanceof Error ? err.message : String(err);

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
