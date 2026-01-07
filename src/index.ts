import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError } from "./errors.js";
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

async function main() {
  const rawArgs = process.argv.slice(2);

  handleEarlyExits(rawArgs);

  const {
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
    maxChars,
    initHook,
  } = parseCliArgs(rawArgs);

  if (initHook) {
    await initPreCommitHook(rootDir);
    process.exit(0);
  }

  if (ciSubcommand) {
    const result = await runCiMode(rootDir, ciChangedFiles.length > 0 ? ciChangedFiles : null, ciBase, verbose);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(result, null, 2) + "\n", (err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  }

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
    return;
  }

  await runGenerateMode({
    rootDir,
    force,
    dryRun,
    reconfigure,
    verbose,
    jsonMode,
    maxTokens,
    effectiveBudget,
    sectionFilter,
    maxChars,
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
  const msg = err instanceof Error ? err.message : String(err);

  if (msg.includes("ENOENT")) {
    console.error(t.error("File not found:"), msg);
  } else if (msg.includes("ETIMEDOUT") || /\btimeout\b/i.test(msg)) {
    console.error(t.error("Git operation timed out. Try reducing the analysis window with staleDays in .clarte.json."));
  } else if (msg.includes("TOML") || /\bparse\b/i.test(msg)) {
    console.error(t.error("Failed to parse config file:"), msg);
  } else {
    console.error(t.error("Fatal error:"), err);
  }

  unpatchPicocolors();
  resetTerminalColors();
  process.exit(1);
});
