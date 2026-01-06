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
import { fileExists, formatBytes } from "./utils.js";
import { detectContext, detectIDEs, detectProjectDescription, enrichFrameworksWithUsage } from "./detect/detect.js";
import { runPrompts } from "./cli/prompts.js";
import { generateSnapshot } from "./snapshot/snapshot.js";
import { generateFiles } from "./core/generate.js";
import { printSummary } from "./cli/summary.js";
import type { UserAnswers } from "./types.js";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash } from "./config/config.js";
import { refreshSnapshot } from "./modes/refresh.js";
import { initPreCommitHook } from "./cli/hooks.js";
import { runDiffMode } from "./modes/diff.js";
import { runWatchMode } from "./modes/watch.js";
import { buildGraphWithCache } from "./graph/cache.js";
import { buildImportGraph, mergeGraph } from "./graph/build.js";
import { getHubFiles } from "./graph/hub-files.js";
import { startShimmer } from "./cli/animations.js";
import type { DetectedContext, GeneratedFile, HubFile, ImportGraph, ProgressCallback } from "./types.js";
import { serializeAnalysis } from "./analysis/serialize.js";
import { buildDirectives } from "./templates/directives.js";
import { handleEarlyExits, parseCliArgs } from "./cli/args.js";
import { runCheckMode } from "./cli/check.js";
import { runCiMode } from "./cli/ci.js";
import { runAnalysis } from "./core/run-analysis.js";

async function main() {
  const startTime = performance.now();
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
    throw new ClarteError(`No project found at ${rootDir}. Run npx clarte from a project directory, or pass a path: npx clarte ./my-project`);
  }

  if (watchMode) {
    await runWatchMode(rootDir, verbose);
    return;
  }

  const noopProgress: ProgressCallback = () => {};
  const verboseLog: ProgressCallback = jsonMode
    ? noopProgress
    : (msg) => {
        if (verbose) p.log.info(t.muted(msg));
      };

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

  if (!jsonMode && dryRun) {
    p.log.warn(t.warn("DRY RUN: no files will be written"));
  }

  if (!jsonMode) p.log.info(t.text(`Analyzing ${t.accent(rootDir)}`));

  const noopShimmer = { message: (_: string) => {}, stop: () => {} };
  let shimmer = jsonMode ? noopShimmer : startShimmer("Detecting stack...");
  let detected: DetectedContext;
  try {
    detected = await detectContext(rootDir, verbose ? verboseLog : (msg) => shimmer.message(msg));
  } finally {
    shimmer.stop();
  }
  if (!jsonMode) p.log.step(t.text("Detection complete."));

  shimmer = jsonMode ? noopShimmer : startShimmer(`Building import graph (${detected.sourceFileCount} files)...`);
  let graph: ImportGraph;
  let topHub: HubFile | undefined;
  try {
    graph = await buildGraphWithCache(rootDir, detected.language, verbose ? verboseLog : (msg) => shimmer.message(msg));

    if (detected.secondaryLanguages) {
      for (const secLang of detected.secondaryLanguages) {
        shimmer.message(`Building ${secLang} import graph...`);
        const secGraph = await buildImportGraph(rootDir, secLang, verbose ? verboseLog : undefined);
        mergeGraph(graph, secGraph);
      }
    }

    topHub = getHubFiles(graph, 1)[0];
  } finally {
    shimmer.stop();
  }
  if (!jsonMode) {
    p.log.step(
      `${t.text("Import graph:")} ${t.textBold(String(graph.edges.length))} ${t.text("edges,")} ${t.textBold(String(graph.externalImportCounts.size))} ${t.text("packages.")}` +
        (topHub ? t.muted(` Top hub: ${topHub.path}`) : ""),
    );
  }

  detected.frameworks = enrichFrameworksWithUsage(detected.frameworks, graph.externalImportCounts);

  if (!jsonMode) {
    const lines: string[] = [];
    const lang = detected.hasTypeScript
      ? "TypeScript"
      : detected.language !== "other"
        ? detected.language.charAt(0).toUpperCase() + detected.language.slice(1)
        : "";
    if (lang) lines.push(`  ${"Language"}   ${t.text(lang)}`);
    if (detected.frameworks.length > 0) {
      lines.push(`  ${"Frameworks"} ${t.text(detected.frameworks.map((f) => f.name).join(", "))}`);
    }
    if (detected.linter !== "none") {
      lines.push(`  ${"Linter"}     ${t.text(detected.linter.charAt(0).toUpperCase() + detected.linter.slice(1))}`);
    }
    if (detected.packageManager !== "none") {
      lines.push(`  ${"Pkg mgr"}    ${t.text(detected.packageManager)}`);
    }
    if (detected.testFramework) {
      lines.push(`  ${"Testing"}    ${t.text(detected.testFramework)}`);
    }
    if (detected.ciProvider) {
      lines.push(`  ${"CI"}         ${t.text(detected.ciProvider)}`);
    }
    if (detected.monorepo) {
      lines.push(
        `  ${"Monorepo"}   ${t.text(`${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`)}`,
      );
    }
    if (detected.sourceFileCount > 0) {
      lines.push(
        `  ${"Files"}      ${t.textBold(`${detected.sourceFileCount}`)} ${t.muted(`(${formatBytes(detected.totalSourceBytes)})`)}`,
      );
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  const { analysis } = await runAnalysis(
    rootDir,
    graph,
    detected,
    savedConfig,
    verbose,
    jsonMode,
    verboseLog,
    noopProgress,
  );

  // Persist analysis graph for hooks and cursor rules (non-critical)
  let persistedGraph: import("./graph/types.js").PersistedGraph | null = null;
  try {
    const { persistGraph, loadPersistedGraph } = await import("./graph/persist.js");
    await persistGraph(rootDir, graph, analysis);
    persistedGraph = await loadPersistedGraph(rootDir);
  } catch {
    // Non-critical
  }

  if (jsonMode) {
    let snapshot = null;
    if (savedConfig?.generateSnapshot !== false) {
      snapshot = await generateSnapshot(
        detected,
        savedConfig?.snapshotPaths ?? [],
        graph,
        maxTokens,
        undefined,
        analysis.gitActivity,
      );
      if (snapshot.entries.length === 0) snapshot = null;
    }
    const directives = buildDirectives(analysis, detected, undefined, graph);
    const output = serializeAnalysis(detected, analysis, snapshot, graph, directives);
    await new Promise<void>((resolve, reject) => {
      process.stdout.write(JSON.stringify(output, null, 2) + "\n", (err) => (err ? reject(err) : resolve()));
    });
    process.exit(0);
  }

  {
    const fileCount = graph.centrality.size;
    const reportLines: string[] = [];
    reportLines.push(`  ${"Files analyzed"}  ${t.textBold(String(fileCount))}`);
    reportLines.push(`  ${"Import edges"}    ${t.textBold(String(graph.edges.length))}`);
    reportLines.push(`  ${"External pkgs"}   ${t.textBold(String(graph.externalImportCounts.size))}`);
    if (analysis.hubFiles.length > 0) {
      reportLines.push(
        `  ${"Hub files"}       ${t.textBold(String(analysis.hubFiles.length))}` +
          (analysis.hubFiles[0] ? ` ${t.text(`(most connected: ${analysis.hubFiles[0].path})`)}` : ""),
      );
    }
    if (analysis.layers.length > 0) {
      reportLines.push(`  ${"Architecture"}    ${t.textBold(analysis.layers.map((l) => l.name).join(" \u2192 "))}`);
    }
    reportLines.push(
      `  ${"Circular deps"}   ${analysis.circularDeps.length === 0 ? t.textBold("none") : t.text(`${analysis.circularDeps.length} chain${analysis.circularDeps.length === 1 ? "" : "s"}`)}`,
    );
    if (analysis.gitActivity) {
      reportLines.push(
        `  ${"Hot files (" + analysis.analysisDays + "d)"} ${t.textBold(String(analysis.gitActivity.hotFiles.length))}`,
      );
    }
    p.note(reportLines.join("\n"), "Analysis Report");

    if (analysis.circularDeps.length > 0) {
      for (const c of analysis.circularDeps.slice(0, 2)) {
        const shortChain = c.chain.map((f) => f.split("/").pop() ?? f);
        p.log.warn(t.warn(`Cycle: ${shortChain.join(" \u2192 ")}`));
      }
    }
  }

  if (savedConfig?.snapshotHash) {
    const currentHash = await computeSnapshotHash(rootDir, detected.language);
    if (currentHash !== savedConfig.snapshotHash && savedConfig.snapshotGeneratedAt) {
      const daysSince = Math.floor((Date.now() - savedConfig.snapshotGeneratedAt) / (1000 * 60 * 60 * 24));
      p.log.warn(
        t.text(
          `Code snapshot may be stale (source files changed${daysSince > 0 ? `, last generated ${daysSince}d ago` : ""}). ` +
            `Run ${t.bold("clarte")} to regenerate.`,
        ),
      );
    }
  }

  let answers: UserAnswers;

  if (savedConfig && !reconfigure) {
    p.log.info(
      t.text(`Using saved config from ${t.accent(".clarte.json")}`) +
        " " +
        t.muted("(run with --reconfigure to change)"),
    );
    answers = configToAnswers(savedConfig);

    if (detected.monorepo && detected.monorepo.packages.length > 0 && !savedConfig.generatePerPackage) {
      // Monorepo exists but wasn't configured, keep saved value
    }
  } else if (reconfigure) {
    answers = await runPrompts(detected, savedConfig, true);

    if (!dryRun) {
      const hash = await computeSnapshotHash(rootDir, detected.language);
      await saveConfig(rootDir, answers, hash, detected.language);
      p.log.info(t.muted("Saved config to .clarte.json for future runs."));
    }
  } else {
    const detectedIDEs = await detectIDEs(rootDir);
    const detectedDescription = await detectProjectDescription(rootDir);

    const snapshotLanguages = new Set(["typescript", "javascript", "python", "go", "rust", "java"]);
    answers = {
      ides: detectedIDEs,
      projectPurpose: detectedDescription ?? "",
      keyPatterns: "",
      gotchas: "",
      generateSnapshot: snapshotLanguages.has(detected.language),
      snapshotPaths: [],
      stackConfirmed: true,
      stackCorrections: "",
      generatePerPackage: false,
    };

    if (!jsonMode) {
      p.log.info(
        t.text(`Auto-detected IDEs: ${t.accent(detectedIDEs.join(", "))}`) +
          " " +
          t.muted("(run with --reconfigure to change)"),
      );
    }

    if (!dryRun) {
      const hash = await computeSnapshotHash(rootDir, detected.language);
      await saveConfig(rootDir, answers, hash, detected.language);
      p.log.info(t.muted("Saved config to .clarte.json for future runs."));
    }
  }

  let snapshot = null;
  if (answers.generateSnapshot) {
    shimmer = startShimmer("Scanning source files for code snapshot...");
    try {
      snapshot = await generateSnapshot(
        detected,
        answers.snapshotPaths,
        graph,
        maxTokens,
        verbose ? verboseLog : (msg) => shimmer.message(msg),
        analysis.gitActivity,
      );
    } finally {
      shimmer.stop();
    }
    const count = snapshot.entries.length;
    const budgetNote = snapshot.budgetExcluded ? ` (${snapshot.budgetExcluded} excluded by token budget)` : "";
    p.log.step(
      count > 0
        ? `${t.text("Found")} ${t.textBold(String(count))} ${t.text(`type${count === 1 ? "" : "s"}/signature${count === 1 ? "" : "s"}.${budgetNote}`)}`
        : t.text("No extractable types found (snapshot will be skipped)."),
    );

    if (count === 0) {
      snapshot = null;
    }
  }

  shimmer = startShimmer(dryRun ? "Preparing context files..." : "Generating context files...");
  const generateSkills = answers.ides.includes("claude");
  let files: GeneratedFile[];
  try {
    files = await generateFiles(
      detected,
      answers,
      snapshot,
      force,
      dryRun,
      analysis,
      generateSkills,
      verbose ? verboseLog : undefined,
      effectiveBudget,
      sectionFilter,
      maxChars,
      graph,
      persistedGraph,
    );
  } finally {
    shimmer.stop();
  }
  p.log.step(
    dryRun
      ? `${t.text("Would generate")} ${t.textBold(String(files.length))} ${t.text(`file${files.length === 1 ? "" : "s"}.`)}`
      : `${t.text("Generated")} ${t.textBold(String(files.length))} ${t.text(`file${files.length === 1 ? "" : "s"}.`)}`,
  );

  if (files.length === 0) {
    p.outro(t.text("Nothing to write. Done!"));
    return;
  }

  printSummary(files, snapshot, analysis, !savedConfig);

  // Generate Claude Code hooks for graph context delivery (non-critical)
  if (!dryRun && persistedGraph && answers.ides.includes("claude") && savedConfig?.hooks !== false) {
    try {
      const { generateHookFiles, configureClaudeHooks } = await import("./hooks/generate-hooks.js");
      await generateHookFiles(rootDir, persistedGraph);
      await configureClaudeHooks(rootDir);
    } catch {
      // Non-critical
    }
  }

  if (!savedConfig && !dryRun) {
    const gitDir = path.join(rootDir, ".git");
    if (await fileExists(gitDir)) {
      const installHook = await p.confirm({
        message: t.text("Install a git hook to keep context fresh automatically?"),
        active: t.soft("Yes"),
        inactive: t.soft("No"),
        initialValue: true,
      });
      if (!p.isCancel(installHook) && installHook) {
        await initPreCommitHook(rootDir);
      }
    }
  }

  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  if (dryRun) {
    p.outro(
      t.warn("DRY RUN complete. ") + t.muted(`no files were written. Remove --dry-run to generate. (${elapsed}s)`),
    );
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  p.outro(
    t.success(`Done in ${elapsed}s!`) +
      "\n\n" +
      t.muted("Your context files are ready. They are living documents: keep them up to date as your project evolves."),
  );
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
