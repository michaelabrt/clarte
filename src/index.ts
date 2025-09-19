import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
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
import type { ContextAnalysis, ProgressCallback } from "./types.js";

async function main() {
  const startTime = performance.now();
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const refresh = args.includes("--refresh-snapshot");
  const reconfigure = args.includes("--reconfigure");
  const check = args.includes("--check");
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
    p.intro(pc.bold(" codebrief "));
    p.log.error(`No project found at ${pc.cyan(rootDir)}`);
    p.log.info(`Run ${pc.bold("npx codebrief")} from a project directory, or pass a path:\n  ${pc.dim("npx codebrief ./my-project")}`);
    p.outro("");
    process.exit(1);
  }

  // Verbose logger: persists messages on screen (not swallowed by spinner)
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(pc.dim(msg));
  };

  // --check: fast path for shell integration (silent, exit code only)
  if (check) {
    const config = await loadConfig(rootDir);
    if (!config?.snapshotHash) {
      process.exit(0); // No config or no hash — nothing to check
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
  p.intro(pc.bold(" codebrief "));

  // --refresh-snapshot: fast path — update snapshot in existing context file
  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(pc.green("Snapshot refreshed!"));
    return;
  }

  if (dryRun) {
    p.log.warn(pc.yellow("DRY RUN — no files will be written"));
  }

  p.log.info(`Analyzing ${pc.cyan(rootDir)}`);

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

  // Step 1.6: Enrich framework detection with actual import usage
  detected.frameworks = enrichFrameworksWithUsage(
    detected.frameworks,
    graph.externalImportCounts,
  );

  // Discovery log (enhanced stack box)
  {
    const lines: string[] = [];
    const lang = detected.hasTypeScript ? "TypeScript" : detected.language !== "other" ? detected.language.charAt(0).toUpperCase() + detected.language.slice(1) : "";
    if (lang) lines.push(`  Language:   ${lang}`);
    if (detected.frameworks.length > 0) {
      lines.push(`  Frameworks: ${detected.frameworks.map((f) => f.name).join(", ")}`);
    }
    if (detected.linter !== "none") {
      lines.push(`  Linter:     ${detected.linter.charAt(0).toUpperCase() + detected.linter.slice(1)}`);
    }
    if (detected.packageManager !== "none") {
      lines.push(`  Pkg mgr:    ${detected.packageManager}`);
    }
    if (detected.testFramework) {
      lines.push(`  Testing:    ${detected.testFramework}`);
    }
    if (detected.ciProvider) {
      lines.push(`  CI:         ${detected.ciProvider}`);
    }
    if (detected.monorepo) {
      lines.push(`  Monorepo:   ${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`);
    }
    if (detected.sourceFileCount > 0) {
      lines.push(`  Files:      ${detected.sourceFileCount} (${formatBytes(detected.totalSourceBytes)})`);
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  // Step 1.7: Structural analysis (progressive reveal — one spinner per algorithm)
  const fileCount = graph.centrality.size;

  spinner.start(`Running PageRank on ${fileCount} files...`);
  const hubFiles = getHubFiles(graph);
  const topHubName = hubFiles[0]?.path ?? "";
  spinner.stop(
    hubFiles.length > 0
      ? `${pc.green("PageRank")}       found ${pc.bold(String(hubFiles.length))} hub files` +
        (topHubName ? pc.dim(` (top: ${topHubName})`) : "")
      : `${pc.green("PageRank")}       ${pc.dim("no hub files detected")}`,
  );
  if (verbose && hubFiles.length > 0) {
    for (const h of hubFiles.slice(0, 5)) {
      p.log.info(pc.dim(`  ${h.path} (centrality: ${h.centrality.toFixed(3)}, imported by ${h.importedBy})`));
    }
  }

  spinner.start("Finding circular dependencies...");
  const circularDeps = findCircularDeps(graph);
  spinner.stop(
    circularDeps.length === 0
      ? `${pc.green("Tarjan SCC")}     no cycles found ${pc.green("✓")}`
      : `${pc.yellow("Tarjan SCC")}     ${pc.bold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found`,
  );
  if (verbose && circularDeps.length > 0) {
    for (const c of circularDeps.slice(0, 3)) {
      p.log.info(pc.dim(`  ${c.chain.join(" → ")}`));
    }
  }

  spinner.start("Detecting architecture layers...");
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  spinner.stop(
    layers.length > 0
      ? `${pc.green("Layers")}         ${layers.map((l) => l.name).join(" → ")}`
      : `${pc.green("Layers")}         ${pc.dim("no clear layers detected")}`,
  );
  if (verbose && layers.length > 0) {
    for (const l of layers) {
      p.log.info(pc.dim(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
    }
  }

  spinner.start("Computing instability metrics...");
  const instabilities = computeInstability(graph);
  const highInstability = instabilities.filter((f) => f.instability > 0.8);
  spinner.stop(
    highInstability.length > 0
      ? `${pc.yellow("Instability")}    ${pc.bold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"}`
      : `${pc.green("Instability")}    ${pc.dim("all files within healthy range")} ${pc.green("✓")}`,
  );
  if (verbose && highInstability.length > 0) {
    for (const f of highInstability.slice(0, 5)) {
      p.log.info(pc.dim(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
    }
  }

  spinner.start("Detecting module communities...");
  const communities = detectCommunities(graph);
  spinner.stop(
    communities.length > 0
      ? `${pc.green("Communities")}    ${pc.bold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
      : `${pc.green("Communities")}    ${pc.dim("single cohesive module")}`,
  );
  if (verbose && communities.length > 0) {
    for (const c of communities.slice(0, 5)) {
      p.log.info(pc.dim(`  ${c.label} (${c.files.length} files)`));
    }
  }

  spinner.start("Computing export coverage...");
  const exportCoverage = computeExportCoverage(graph);
  {
    const totalExp = exportCoverage.reduce((s, e) => s + e.totalExports, 0);
    const totalUsed = exportCoverage.reduce((s, e) => s + e.usedExports, 0);
    const unusedCount = totalExp - totalUsed;
    const filesWithUnused = exportCoverage.filter((e) => e.usedExports < e.totalExports).length;
    spinner.stop(
      unusedCount > 0
        ? `${pc.yellow("Exports")}        ${pc.bold(String(unusedCount))} unused export${unusedCount === 1 ? "" : "s"} in ${filesWithUnused} file${filesWithUnused === 1 ? "" : "s"}`
        : `${pc.green("Exports")}        ${pc.dim("all exports used")} ${pc.green("✓")}`,
    );
    if (verbose && unusedCount > 0) {
      for (const e of exportCoverage.filter((e) => e.usedExports < e.totalExports).slice(0, 5)) {
        p.log.info(pc.dim(`  ${e.file}: ${e.totalExports - e.usedExports} unused of ${e.totalExports}`));
      }
    }
  }

  spinner.start("Analyzing git history...");
  const gitActivity = detected.isGitRepo ? analyzeGitActivity(rootDir, verbose ? verboseLog : spinnerProgress) : null;
  if (gitActivity) {
    const coupledPairs = gitActivity.changeCoupling.length;
    spinner.stop(
      `${pc.green("Git (90d)")}      ${pc.bold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${pc.bold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
    );
    if (verbose) {
      for (const h of gitActivity.hotFiles.slice(0, 5)) {
        p.log.info(pc.dim(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
      }
    }
  } else {
    spinner.stop(`${pc.green("Git")}            ${pc.dim("not a git repo — skipped")}`);
  }

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, layerEdges, gitActivity, instabilities, communities, exportCoverage };

  // Analysis report box
  {
    const reportLines: string[] = [];
    reportLines.push(`  Files analyzed:  ${fileCount}`);
    reportLines.push(`  Import edges:    ${graph.edges.length}`);
    reportLines.push(`  External pkgs:   ${graph.externalImportCounts.size}`);
    if (hubFiles.length > 0) {
      reportLines.push(`  Hub files:       ${hubFiles.length}` + (hubFiles[0] ? ` (most connected: ${hubFiles[0].path})` : ""));
    }
    if (layers.length > 0) {
      reportLines.push(`  Architecture:    ${layers.map((l) => l.name).join(" → ")}`);
    }
    reportLines.push(`  Circular deps:   ${circularDeps.length === 0 ? "none" : `${circularDeps.length} chain${circularDeps.length === 1 ? "" : "s"}`}`);
    if (gitActivity) {
      reportLines.push(`  Hot files (90d): ${gitActivity.hotFiles.length}`);
    }
    p.note(reportLines.join("\n"), "Analysis Report");

    // Show cycle chains inline below the box (max 2)
    if (circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 2)) {
        const shortChain = c.chain.map((f) => f.split("/").pop() ?? f);
        p.log.warn(pc.yellow(`Cycle: ${shortChain.join(" → ")}`));
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
        pc.yellow(
          `Code snapshot may be stale (source files changed${daysSince > 0 ? `, last generated ${daysSince}d ago` : ""}). ` +
            `Run with ${pc.bold("--refresh-snapshot")} to update.`,
        ),
      );
    }
  }

  let answers;

  if (savedConfig && !reconfigure) {
    // Use saved config — skip prompts
    p.log.info(
      `Using saved config from ${pc.cyan(".codebrief.json")} ` +
        pc.dim("(run with --reconfigure to change)"),
    );
    answers = configToAnswers(savedConfig);

    // Re-check monorepo (structure may have changed)
    if (
      detected.monorepo &&
      detected.monorepo.packages.length > 0 &&
      !savedConfig.generatePerPackage
    ) {
      // Monorepo exists but wasn't configured — keep saved value
    }
  } else {
    // Step 2: Interactive prompts (with defaults from saved config if --reconfigure)
    answers = await runPrompts(detected, reconfigure ? savedConfig : null);

    // Save config for future runs
    if (!dryRun) {
      const hash = await computeSnapshotHash(rootDir, detected.language);
      await saveConfig(rootDir, answers, hash, detected.language);
      p.log.info(
        pc.dim("Saved config to .codebrief.json for future runs."),
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
  const shouldGenerateSkills = generateSkills || answers.ide === "claude";
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
      pc.yellow("DRY RUN complete — ") +
        pc.dim(`no files were written. Remove --dry-run to generate. (${elapsed}s)`),
    );
    return;
  }

  // Step 6: Done!
  p.outro(
    pc.green(`Done in ${elapsed}s! `) +
      pc.dim(
        "Your context files are ready. They are living documents — keep them up to date as your project evolves.",
      ),
  );
}

main().catch((err) => {
  console.error(pc.red("Fatal error:"), err);
  process.exit(1);
});
