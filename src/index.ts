import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t, gradient } from "./theme.js";
import { fileExists } from "./utils.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect.js";
import { runPrompts } from "./prompts.js";
import { generateSnapshot } from "./snapshot.js";
import { generateFiles } from "./generate.js";
import { printSummary } from "./summary.js";
import {
  loadConfig,
  saveConfig,
  configToAnswers,
  computeSnapshotHash,
} from "./config.js";
import { refreshSnapshot } from "./refresh.js";
import {
  buildImportGraph,
  getHubFiles,
  findCircularDeps,
  detectArchitecturalLayers,
  computeInstability,
  detectCommunities,
  computeExportCoverage,
} from "./graph.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { formatBytes } from "./utils.js";
import {
  animateGraphBuild,
  animatePageRank,
  animateCycleDetection,
  animateLayerStack,
  animateCommunities,
} from "./animations.js";
import type { ContextAnalysis, ProgressCallback } from "./types.js";

declare const PKG_VERSION: string;
declare const PKG_NAME: string;
declare const PKG_DESCRIPTION: string;

const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";
const NAME = typeof PKG_NAME !== "undefined" ? PKG_NAME : "codebrief";
const DESCRIPTION = typeof PKG_DESCRIPTION !== "undefined" ? PKG_DESCRIPTION : "";

function printHelp(): void {
  console.log("");
  console.log(gradient(" codebrief ", [90, 130, 220], [137, 180, 250], t.brandBold));
  console.log(t.muted("  " + DESCRIPTION));
  console.log("");
  console.log(`  ${t.bold("Usage:")}  npx ${NAME} [directory] [options]`);
  console.log("");
  console.log(`  ${t.bold("Options:")}`);
  console.log(`    ${t.accent("-h, --help")}              Show this help message`);
  console.log(`    ${t.accent("-V, --version")}           Show version number`);
  console.log(`    ${t.accent("--force")}                 Overwrite existing files without asking`);
  console.log(`    ${t.accent("--dry-run")}               Preview what would be generated`);
  console.log(`    ${t.accent("--reconfigure")}           Re-prompt even if .codebrief.json exists`);
  console.log(`    ${t.accent("--refresh-snapshot")}      Re-scan source files, update code snapshot only`);
  console.log(`    ${t.accent("--check")}                 Exit 0 if snapshot is fresh, 1 if stale (hash-based)`);
  console.log(`    ${t.accent("--check=timestamp")}       Exit 0/1 based on age only (no Node.js needed in shell hooks)`);
  console.log(`    ${t.accent("--max-tokens=N")}          Set the token budget for the code snapshot`);
  console.log(`    ${t.accent("--generate-skills")}       Generate Claude Code skill files`);
  console.log(`    ${t.accent("-v, --verbose")}           Show detailed progress output`);
  console.log("");
  console.log(`  ${t.bold("Examples:")}`);
  console.log(`    ${t.muted("$")} npx ${NAME}                   ${t.muted("# analyze current directory")}`);
  console.log(`    ${t.muted("$")} npx ${NAME} ./my-project      ${t.muted("# analyze a specific project")}`);
  console.log(`    ${t.muted("$")} npx ${NAME} --dry-run          ${t.muted("# preview without writing files")}`);
  console.log(`    ${t.muted("$")} npx ${NAME} --refresh-snapshot ${t.muted("# update code snapshot only")}`);
  console.log("");
}

async function main() {
  const startTime = performance.now();
  const args = process.argv.slice(2);

  // Early-exit flags (before any project validation)
  if (args.includes("--help") || args.includes("-h")) {
    printHelp();
    process.exit(0);
  }

  if (args.includes("--version") || args.includes("-V")) {
    console.log(VERSION);
    process.exit(0);
  }

  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const refresh = args.includes("--refresh-snapshot");
  const reconfigure = args.includes("--reconfigure");
  const checkArg = args.find((a) => a === "--check" || a.startsWith("--check="));
  const check = !!checkArg;
  const checkTimestamp = checkArg === "--check=timestamp";
  const verbose = args.includes("--verbose") || args.includes("-v");
  const generateSkills = args.includes("--generate-skills");
  const maxTokensArg = args.find((a) => a.startsWith("--max-tokens="));
  const maxTokens = maxTokensArg ? parseInt(maxTokensArg.split("=")[1], 10) : undefined;
  const targetDir = args.find((a) => !a.startsWith("-") && a !== "-v") ?? process.cwd();
  const rootDir = path.resolve(targetDir);

  // Early validation: ensure this looks like a project directory
  const PROJECT_MARKERS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt"];
  const hasProjectMarker = (await Promise.all(
    PROJECT_MARKERS.map(f => fileExists(path.join(rootDir, f)))
  )).some(Boolean);

  if (!hasProjectMarker) {
    console.log("");
    p.intro(t.bold(" codebrief "));
    p.log.error(`No project found at ${t.accent(rootDir)}`);
    p.log.info(`Run ${t.bold("npx codebrief")} from a project directory, or pass a path:\n  ${t.muted("npx codebrief ./my-project")}`);
    p.outro("");
    process.exit(1);
  }

  // Verbose logger: persists messages on screen (not swallowed by spinner)
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(t.muted(msg));
  };

  // --check: fast path for shell integration (silent, exit code only)
  if (check) {
    const config = await loadConfig(rootDir);

    if (checkTimestamp) {
      // Timestamp-only check: no file globbing or hashing
      if (!config?.snapshotGeneratedAt) {
        process.exit(0); // No config or no timestamp: nothing to check
      }
      const staleDays = config.staleDays ?? 7;
      const daysSince = Math.floor(
        (Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24),
      );
      if (daysSince > staleDays) {
        console.log(`codebrief: snapshot is ${daysSince}d old. Run: npx codebrief --refresh-snapshot`);
        process.exit(1);
      }
      process.exit(0);
    }

    // Hash-based check (original behavior)
    if (!config?.snapshotHash) {
      process.exit(0); // No config or no hash: nothing to check
    }
    const lang = config.language ?? "other";
    const currentHash = await computeSnapshotHash(rootDir, lang);
    if (currentHash !== config.snapshotHash) {
      const daysSince = config.snapshotGeneratedAt
        ? Math.floor((Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24))
        : 0;
      const staleMsg = daysSince > 0 ? ` (last generated ${daysSince}d ago)` : "";
      console.log(`codebrief: snapshot is stale${staleMsg}. Run npx codebrief --refresh-snapshot`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.log("");
  p.intro(gradient(" codebrief ", [90, 130, 220], [137, 180, 250], t.brandBold));
  p.log.info(t.muted("code analysis for AI context"));

  // --refresh-snapshot: fast path, update snapshot in existing context file
  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.success("Snapshot refreshed!"));
    return;
  }

  if (dryRun) {
    p.log.warn(t.warn("DRY RUN: no files will be written"));
  }

  p.log.info(`Analyzing ${t.accent(rootDir)}`);

  // Step 1: Auto-detect
  const spinner = p.spinner();
  const spinnerProgress: ProgressCallback = (msg) => spinner.message(msg);

  spinner.start("Detecting tech stack...");
  const detected = await detectContext(rootDir, spinnerProgress);
  spinner.stop("Detection complete.");

  // Step 1.5: Build import graph
  spinner.start(`Building import graph (${detected.sourceFileCount} files)...`);
  const graph = await buildImportGraph(rootDir, detected.language, verbose ? verboseLog : spinnerProgress);
  const topHub = getHubFiles(graph, 1)[0];
  spinner.stop(
    `Import graph: ${graph.edges.length} edges, ${graph.externalImportCounts.size} packages.` +
      (topHub ? ` Top hub: ${topHub.path}` : ""),
  );

  // Graph build animation (runs after spinner to avoid conflict)
  await animateGraphBuild(detected.sourceFileCount, graph.edges.length);

  // Step 1.6: Enrich framework detection with actual import usage
  detected.frameworks = enrichFrameworksWithUsage(
    detected.frameworks,
    graph.externalImportCounts,
  );

  // Discovery log (enhanced stack box)
  {
    const lines: string[] = [];
    const lang = detected.hasTypeScript ? "TypeScript" : detected.language !== "other" ? detected.language.charAt(0).toUpperCase() + detected.language.slice(1) : "";
    if (lang) lines.push(`  ${"Language"}   ${t.accentBold(lang)}`);
    if (detected.frameworks.length > 0) {
      lines.push(`  ${"Frameworks"} ${t.accentBold(detected.frameworks.map((f) => f.name).join(", "))}`);
    }
    if (detected.linter !== "none") {
      lines.push(`  ${"Linter"}     ${t.accentBold(detected.linter.charAt(0).toUpperCase() + detected.linter.slice(1))}`);
    }
    if (detected.packageManager !== "none") {
      lines.push(`  ${"Pkg mgr"}    ${t.accentBold(detected.packageManager)}`);
    }
    if (detected.testFramework) {
      lines.push(`  ${"Testing"}    ${t.accentBold(detected.testFramework)}`);
    }
    if (detected.ciProvider) {
      lines.push(`  ${"CI"}         ${t.accentBold(detected.ciProvider)}`);
    }
    if (detected.monorepo) {
      lines.push(`  ${"Monorepo"}   ${t.accentBold(`${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`)}`);
    }
    if (detected.sourceFileCount > 0) {
      lines.push(`  ${"Files"}      ${t.accentBold(`${detected.sourceFileCount}`)} ${t.muted(`(${formatBytes(detected.totalSourceBytes)})`)}`);
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  // Step 1.7: Structural analysis (progressive reveal, one animation per algorithm)
  const fileCount = graph.centrality.size;

  // PageRank
  await animatePageRank();
  const hubFiles = getHubFiles(graph);
  const topHubName = hubFiles[0]?.path ?? "";
  p.log.step(
    hubFiles.length > 0
      ? `${t.brand("PageRank")}       found ${t.bold(String(hubFiles.length))} hub files` +
        (topHubName ? t.muted(` (top: ${topHubName})`) : "")
      : `${t.brand("PageRank")}       ${t.muted("no hub files detected")}`,
  );
  if (verbose && hubFiles.length > 0) {
    for (const h of hubFiles.slice(0, 5)) {
      p.log.info(t.muted(`  ${h.path} (centrality: ${h.centrality.toFixed(3)}, imported by ${h.importedBy})`));
    }
  }

  // Tarjan SCC: cycle detection (single call with real data)
  const circularDeps = findCircularDeps(graph);
  await animateCycleDetection(circularDeps.length);
  p.log.step(
    circularDeps.length === 0
      ? `${t.brand("Tarjan SCC")}     no cycles found ${t.check()}`
      : `${t.warn("Tarjan SCC")}     ${t.bold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found`,
  );
  if (verbose && circularDeps.length > 0) {
    for (const c of circularDeps.slice(0, 3)) {
      p.log.info(t.muted(`  ${c.chain.join(" → ")}`));
    }
  }

  // Architecture layers
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  await animateLayerStack(layers.map((l) => l.name));
  p.log.step(
    layers.length > 0
      ? `${t.brand("Layers")}         ${layers.map((l) => l.name).join(" → ")}`
      : `${t.brand("Layers")}         ${t.muted("no clear layers detected")}`,
  );
  if (verbose && layers.length > 0) {
    for (const l of layers) {
      p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
    }
  }

  // Instability metrics (no dedicated animation, fast computation)
  const instabilities = computeInstability(graph);
  const highInstability = instabilities.filter((f) => f.instability > 0.8);
  p.log.step(
    highInstability.length > 0
      ? `${t.warn("Instability")}    ${t.bold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"}`
      : `${t.brand("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
  );
  if (verbose && highInstability.length > 0) {
    for (const f of highInstability.slice(0, 5)) {
      p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
    }
  }

  // Communities
  const communities = detectCommunities(graph);
  await animateCommunities(communities.length);
  p.log.step(
    communities.length > 0
      ? `${t.brand("Communities")}    ${t.bold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
      : `${t.brand("Communities")}    ${t.muted("single cohesive module")}`,
  );
  if (verbose && communities.length > 0) {
    for (const c of communities.slice(0, 5)) {
      p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
    }
  }

  // Export coverage
  const exportCoverage = computeExportCoverage(graph);
  {
    const totalExp = exportCoverage.reduce((s, e) => s + e.totalExports, 0);
    const totalUsed = exportCoverage.reduce((s, e) => s + e.usedExports, 0);
    const unusedCount = totalExp - totalUsed;
    const filesWithUnused = exportCoverage.filter((e) => e.usedExports < e.totalExports).length;
    p.log.step(
      unusedCount > 0
        ? `${t.warn("Exports")}        ${t.bold(String(unusedCount))} unused export${unusedCount === 1 ? "" : "s"} in ${filesWithUnused} file${filesWithUnused === 1 ? "" : "s"}`
        : `${t.brand("Exports")}        ${t.muted("all exports used")} ${t.check()}`,
    );
    if (verbose && unusedCount > 0) {
      for (const e of exportCoverage.filter((e) => e.usedExports < e.totalExports).slice(0, 5)) {
        p.log.info(t.muted(`  ${e.file}: ${e.totalExports - e.usedExports} unused of ${e.totalExports}`));
      }
    }
  }

  // Git history
  const noopProgress: ProgressCallback = () => {};
  const gitActivity = detected.isGitRepo ? await analyzeGitActivity(rootDir, verbose ? verboseLog : noopProgress) : null;
  if (gitActivity) {
    const coupledPairs = gitActivity.changeCoupling.length;
    p.log.step(
      `${t.brand("Git (90d)")}      ${t.bold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${t.bold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
    );
    if (verbose) {
      for (const h of gitActivity.hotFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
      }
    }
  } else {
    p.log.step(`${t.brand("Git")}            ${t.muted("not a git repo, skipped")}`);
  }

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, layerEdges, gitActivity, instabilities, communities, exportCoverage };

  // Analysis report box
  {
    const reportLines: string[] = [];
    reportLines.push(`  ${"Files analyzed"}  ${t.brandBold(String(fileCount))}`);
    reportLines.push(`  ${"Import edges"}    ${t.brandBold(String(graph.edges.length))}`);
    reportLines.push(`  ${"External pkgs"}   ${t.brandBold(String(graph.externalImportCounts.size))}`);
    if (hubFiles.length > 0) {
      reportLines.push(`  ${"Hub files"}       ${t.brandBold(String(hubFiles.length))}` + (hubFiles[0] ? ` ${t.muted(`(most connected: ${hubFiles[0].path})`)}` : ""));
    }
    if (layers.length > 0) {
      reportLines.push(`  ${"Architecture"}    ${t.accentBold(layers.map((l) => l.name).join(" → "))}`);
    }
    reportLines.push(`  ${"Circular deps"}   ${circularDeps.length === 0 ? t.success("none") : t.warn(`${circularDeps.length} chain${circularDeps.length === 1 ? "" : "s"}`)}`);
    if (gitActivity) {
      reportLines.push(`  ${"Hot files (90d)"} ${t.brandBold(String(gitActivity.hotFiles.length))}`);
    }
    p.note(reportLines.join("\n"), "Analysis Report");

    // Show cycle chains inline below the box (max 2)
    if (circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 2)) {
        const shortChain = c.chain.map((f) => f.split("/").pop() ?? f);
        p.log.warn(t.warn(`Cycle: ${shortChain.join(" → ")}`));
      }
    }
  }

  // Step 1.8: Check for saved config + staleness
  const savedConfig = await loadConfig(rootDir);

  if (savedConfig?.snapshotHash) {
    const currentHash = await computeSnapshotHash(rootDir, detected.language);
    if (currentHash !== savedConfig.snapshotHash && savedConfig.snapshotGeneratedAt) {
      const daysSince = Math.floor(
        (Date.now() - savedConfig.snapshotGeneratedAt) / (1000 * 60 * 60 * 24),
      );
      p.log.warn(
        t.warn(
          `Code snapshot may be stale (source files changed${daysSince > 0 ? `, last generated ${daysSince}d ago` : ""}). ` +
            `Run with ${t.bold("--refresh-snapshot")} to update.`,
        ),
      );
    }
  }

  let answers;

  if (savedConfig && !reconfigure) {
    // Use saved config, skip prompts
    p.log.info(
      `Using saved config from ${t.accent(".codebrief.json")} ` +
        t.muted("(run with --reconfigure to change)"),
    );
    answers = configToAnswers(savedConfig);

    // Re-check monorepo (structure may have changed)
    if (
      detected.monorepo &&
      detected.monorepo.packages.length > 0 &&
      !savedConfig.generatePerPackage
    ) {
      // Monorepo exists but wasn't configured, keep saved value
    }
  } else {
    // Step 2: Interactive prompts (with defaults from saved config if --reconfigure)
    answers = await runPrompts(detected, reconfigure ? savedConfig : null, reconfigure);

    // Save config for future runs
    if (!dryRun) {
      const hash = await computeSnapshotHash(rootDir, detected.language);
      await saveConfig(rootDir, answers, hash, detected.language);
      p.log.info(
        t.muted("Saved config to .codebrief.json for future runs."),
      );
    }
  }

  // Step 3: Code snapshot (if requested)
  let snapshot = null;
  if (answers.generateSnapshot) {
    spinner.start("Scanning source files for code snapshot...");
    snapshot = await generateSnapshot(detected, answers.snapshotPaths, graph, maxTokens, verbose ? verboseLog : spinnerProgress, gitActivity);
    const count = snapshot.entries.length;
    const budgetNote = snapshot.budgetExcluded
      ? ` (${snapshot.budgetExcluded} excluded by token budget)`
      : "";
    spinner.stop(
      count > 0
        ? `Found ${count} type${count === 1 ? "" : "s"}/signature${count === 1 ? "" : "s"}.${budgetNote}`
        : "No extractable types found (snapshot will be skipped).",
    );

    if (count === 0) {
      snapshot = null;
    }
  }

  // Step 4: Generate files
  spinner.start(
    dryRun ? "Preparing context files..." : "Generating context files...",
  );
  const shouldGenerateSkills = generateSkills || answers.ides.includes("claude");
  const files = await generateFiles(detected, answers, snapshot, force, dryRun, analysis, shouldGenerateSkills, verbose ? verboseLog : undefined);
  spinner.stop(
    dryRun
      ? `Would generate ${files.length} file${files.length === 1 ? "" : "s"}.`
      : `Generated ${files.length} file${files.length === 1 ? "" : "s"}.`,
  );

  if (files.length === 0) {
    p.outro("Nothing to write. Done!");
    return;
  }

  // Step 5: Summary + token estimate
  printSummary(files, detected, snapshot, analysis);

  // Elapsed time
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  if (dryRun) {
    p.outro(
      t.warn("DRY RUN complete. ") +
        t.muted(`no files were written. Remove --dry-run to generate. (${elapsed}s)`),
    );
    return;
  }

  // Step 6: Done!
  p.outro(
    t.success(`Done in ${elapsed}s! `) +
      t.muted(
        "Your context files are ready. They are living documents: keep them up to date as your project evolves.",
      ),
  );
}

main().catch((err) => {
  console.error(t.error("Fatal error:"), err);
  process.exit(1);
});
