import path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { theme as t, gradient, patchClackColors } from "./theme.js";
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
  findDeadFiles,
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
} from "./graph.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { formatBytes } from "./utils.js";
import { startShimmer } from "./animations.js";
import type { ContextAnalysis, ImportGraph, ProgressCallback } from "./types.js";

declare const PKG_VERSION: string;
declare const PKG_NAME: string;
declare const PKG_DESCRIPTION: string;

const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";
const NAME = typeof PKG_NAME !== "undefined" ? PKG_NAME : "clarte";
const DESCRIPTION = typeof PKG_DESCRIPTION !== "undefined" ? PKG_DESCRIPTION : "";

// Patch @clack/prompts colors before any output
patchClackColors();

function printHelp(): void {
  console.log("");
  console.log(gradient(" clart\u00e9 ", [233, 206, 161], [235, 220, 185], t.brandBold));
  console.log(t.muted("  " + DESCRIPTION));
  console.log("");
  console.log(`  ${t.textBold("Usage:")}  ${t.text(`npx ${NAME} [directory] [options]`)}`);
  console.log("");
  console.log(`  ${t.textBold("Options:")}`);
  console.log(`    ${t.text("-h, --help")}              ${t.text("Show this help message")}`);
  console.log(`    ${t.text("-V, --version")}           ${t.text("Show version number")}`);
  console.log(`    ${t.text("--force")}                 ${t.text("Overwrite existing files without asking")}`);
  console.log(`    ${t.text("--dry-run")}               ${t.text("Preview what would be generated")}`);
  console.log(`    ${t.text("--reconfigure")}           ${t.text("Re-prompt even if .clarte.json exists")}`);
  console.log(`    ${t.text("--refresh-snapshot")}      ${t.text("Re-scan source files, update code snapshot only")}`);
  console.log(`    ${t.text("--check")}                 ${t.text("Exit 0 if snapshot is fresh, 1 if stale (hash-based)")}`);
  console.log(`    ${t.text("--check=timestamp")}       ${t.text("Exit 0/1 based on age only (no Node.js needed in shell hooks)")}`);
  console.log(`    ${t.text("--max-tokens=N")}          ${t.text("Set the token budget for the code snapshot")}`);
  console.log(`    ${t.text("--generate-skills")}       ${t.text("Generate Claude Code skill files")}`);
  console.log(`    ${t.text("--diff[=REF]")}            ${t.text("Output focused context for changed files (vs HEAD or REF)")}`);
  console.log(`    ${t.text("-v, --verbose")}           ${t.text("Show detailed progress output")}`);
  console.log("");
  console.log(`  ${t.textBold("Examples:")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME}`)}                   ${t.muted("# analyze current directory")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} ./my-project`)}      ${t.muted("# analyze a specific project")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --dry-run`)}          ${t.muted("# preview without writing files")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --refresh-snapshot`)} ${t.muted("# update code snapshot only")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff`)}             ${t.muted("# focused context for uncommitted changes")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff=main`)}        ${t.muted("# focused context vs main branch")}`);
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
  const diffArg = args.find((a) => a === "--diff" || a.startsWith("--diff="));
  const diffMode = !!diffArg;
  const diffRef = diffArg?.startsWith("--diff=") ? diffArg.split("=")[1] : undefined;
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
    p.intro(t.bold(" clarte "));
    p.log.error(t.text(`No project found at ${rootDir}`));
    p.log.info(t.text("Run ") + t.textBold("npx clarte") + t.text(" from a project directory, or pass a path:\n  ") + t.muted("npx clarte ./my-project"));
    p.outro("");
    process.exit(1);
  }

  // Verbose logger: persists messages on screen (not swallowed by shimmer)
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
        console.log(`clarte: snapshot is ${daysSince}d old. Run: npx clarte --refresh-snapshot`);
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
      console.log(`clarte: snapshot is stale${staleMsg}. Run npx clarte --refresh-snapshot`);
      process.exit(1);
    }
    process.exit(0);
  }

  // --diff: focused context for changed files
  if (diffMode) {
    console.log("");
    p.intro(gradient(" clart\u00e9 ", [233, 206, 161], [235, 220, 185], t.brandBold));
    p.log.info(t.muted("diff-aware context"));
    await runDiffMode(rootDir, diffRef, verbose);
    const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);
    p.outro(t.brand(`Done in ${elapsed}s`));
    return;
  }

  console.log("");
  p.intro(gradient(" clart\u00e9 ", [233, 206, 161], [235, 220, 185], t.brandBold));
  p.log.info(t.muted("code analysis for AI context"));

  // --refresh-snapshot: fast path, update snapshot in existing context file
  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.text("Snapshot refreshed!"));
    return;
  }

  if (dryRun) {
    p.log.warn(t.text("DRY RUN: no files will be written"));
  }

  p.log.info(t.text(`Analyzing ${rootDir}`));

  // Step 1: Auto-detect
  const shimmer = startShimmer("Detecting tech stack...");
  const shimmerProgress: ProgressCallback = (msg) => shimmer.message(msg);

  const detected = await detectContext(rootDir, shimmerProgress);
  shimmer.stop();
  p.log.step(t.text("Detection complete."));

  // Step 1.5: Build import graph
  const graphShimmer = startShimmer(`Building import graph (${detected.sourceFileCount} files)...`);
  const graphProgress: ProgressCallback = (msg) => graphShimmer.message(msg);
  const graph = await buildImportGraph(rootDir, detected.language, verbose ? verboseLog : graphProgress);
  const topHub = getHubFiles(graph, 1)[0];
  graphShimmer.stop();
  p.log.step(
    t.text(`Import graph: ${graph.edges.length} edges, ${graph.externalImportCounts.size} packages.`) +
      (topHub ? t.muted(` Top hub: ${topHub.path}`) : ""),
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
    if (lang) lines.push(`  ${t.soft("Language")}   ${t.soft(lang)}`);
    if (detected.frameworks.length > 0) {
      lines.push(`  ${t.soft("Frameworks")} ${t.soft(detected.frameworks.map((f) => f.name).join(", "))}`);
    }
    if (detected.linter !== "none") {
      lines.push(`  ${t.soft("Linter")}     ${t.soft(detected.linter.charAt(0).toUpperCase() + detected.linter.slice(1))}`);
    }
    if (detected.packageManager !== "none") {
      lines.push(`  ${t.soft("Pkg mgr")}    ${t.soft(detected.packageManager)}`);
    }
    if (detected.testFramework) {
      lines.push(`  ${t.soft("Testing")}    ${t.soft(detected.testFramework)}`);
    }
    if (detected.ciProvider) {
      lines.push(`  ${t.soft("CI")}         ${t.soft(detected.ciProvider)}`);
    }
    if (detected.monorepo) {
      lines.push(`  ${t.soft("Monorepo")}   ${t.soft(`${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`)}`);
    }
    if (detected.sourceFileCount > 0) {
      lines.push(`  ${t.soft("Files")}      ${t.soft(`${detected.sourceFileCount} (${formatBytes(detected.totalSourceBytes)})`)}`);
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  // Step 1.7: Structural analysis (progressive reveal via shimmer)
  const fileCount = graph.centrality.size;

  // HITS analysis
  await animatePageRank();
  const hubFiles = getHubFiles(graph);
  const topHubName = hubFiles[0]?.path ?? "";
  p.log.step(
    hubFiles.length > 0
      ? `${t.brand("HITS")}           found ${t.bold(String(hubFiles.length))} key files` +
        (topHubName ? t.muted(` (top: ${topHubName})`) : "")
      : `${t.brand("HITS")}           ${t.muted("no key files detected")}`,
  );
  if (verbose && hubFiles.length > 0) {
    for (const h of hubFiles.slice(0, 5)) {
      p.log.info(t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`));
    }
    var analysisHubFiles = hubFiles;
  }

  // Tarjan SCC: cycle detection
  {
    const s = startShimmer("Finding circular import chains...");
    const circularDeps = findCircularDeps(graph);
    s.stop();
    p.log.step(
      circularDeps.length === 0
        ? `${t.text("Tarjan SCC")}     ${t.text("no cycles found")} ${t.check()}`
        : `${t.text("Tarjan SCC")}     ${t.text(String(circularDeps.length))} ${t.text(`cycle${circularDeps.length === 1 ? "" : "s"} found`)}`,
    );
    if (verbose && circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 3)) {
        p.log.info(t.muted(`  ${c.chain.join(" \u2192 ")}`));
      }
    }
    var analysisCircularDeps = circularDeps;
  }

  // Architecture layers
  {
    const s = startShimmer("Detecting architecture layers...");
    const { layers, layerEdges } = detectArchitecturalLayers(graph);
    s.stop();
    p.log.step(
      layers.length > 0
        ? `${t.text("Layers")}         ${t.text(layers.map((l) => l.name).join(" \u2192 "))}`
        : `${t.text("Layers")}         ${t.muted("no clear layers detected")}`,
    );
    if (verbose && layers.length > 0) {
      for (const l of layers) {
        p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
      }
    }
    var analysisLayers = layers;
    var analysisLayerEdges = layerEdges;
  }

  // Instability metrics
  {
    const s = startShimmer("Computing instability metrics...");
    const instabilities = computeInstability(graph);
    s.stop();
    const highInstability = instabilities.filter((f) => f.instability > 0.8);
    p.log.step(
      highInstability.length > 0
        ? `${t.text("Instability")}    ${t.text(String(highInstability.length))} ${t.text(`high-risk file${highInstability.length === 1 ? "" : "s"}`)}`
        : `${t.text("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
    );
    if (verbose && highInstability.length > 0) {
      for (const f of highInstability.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
      }
    }
    var analysisInstabilities = instabilities;
  }

  // Communities
  {
    const s = startShimmer("Clustering module communities...");
    const communities = detectCommunities(graph);
    s.stop();
    p.log.step(
      communities.length > 0
        ? `${t.text("Communities")}    ${t.text(String(communities.length))} ${t.text(`module cluster${communities.length === 1 ? "" : "s"}`)}`
        : `${t.text("Communities")}    ${t.muted("single cohesive module")}`,
    );
    if (verbose && communities.length > 0) {
      for (const c of communities.slice(0, 5)) {
        p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
      }
    }
    var analysisCommunities = communities;
  }

  // Export coverage
  {
    const s = startShimmer("Scanning export coverage...");
    const exportCoverage = computeExportCoverage(graph);
    s.stop();
    const totalExp = exportCoverage.reduce((sum, e) => sum + e.totalExports, 0);
    const totalUsed = exportCoverage.reduce((sum, e) => sum + e.usedExports, 0);
    const unusedCount = totalExp - totalUsed;
    const filesWithUnused = exportCoverage.filter((e) => e.usedExports < e.totalExports).length;
    p.log.step(
      unusedCount > 0
        ? `${t.text("Exports")}        ${t.text(`${unusedCount} unused export${unusedCount === 1 ? "" : "s"} in ${filesWithUnused} file${filesWithUnused === 1 ? "" : "s"}`)}`
        : `${t.text("Exports")}        ${t.muted("all exports used")} ${t.check()}`,
    );
    if (verbose && unusedCount > 0) {
      for (const e of exportCoverage.filter((e) => e.usedExports < e.totalExports).slice(0, 5)) {
        p.log.info(t.muted(`  ${e.file}: ${e.totalExports - e.usedExports} unused of ${e.totalExports}`));
      }
    }
    var analysisExportCoverage = exportCoverage;
  }

  // Git history
  const noopProgress: ProgressCallback = () => {};
  let gitActivity = null;
  if (detected.isGitRepo) {
    const s = startShimmer("Analyzing git history (90 days)...");
    gitActivity = await analyzeGitActivity(rootDir, verbose ? verboseLog : noopProgress);
    s.stop();
  }
  if (gitActivity) {
    const coupledPairs = gitActivity.changeCoupling.length;
    p.log.step(
      `${t.text("Git (90d)")}      ${t.text(`${gitActivity.hotFiles.length} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${coupledPairs} coupled pair${coupledPairs === 1 ? "" : "s"}`)}`,
    );
    if (verbose) {
      for (const h of gitActivity.hotFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
      }
    }
  } else {
    p.log.step(`${t.text("Git")}            ${t.muted("not a git repo, skipped")}`);
  }

  // Dead files (zero in-degree, excluding entry points and tests)
  const deadFiles = findDeadFiles(graph);
  if (deadFiles.length > 0) {
    p.log.step(
      `${t.warn("Dead files")}     ${t.bold(String(deadFiles.length))} file${deadFiles.length === 1 ? "" : "s"} not imported by anything`,
    );
    if (verbose) {
      for (const f of deadFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f}`));
      }
    }
  }

  // Cross-cutting files (imported across multiple layers)
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  if (crossCuttingFiles.length > 0) {
    p.log.step(
      `${t.brand("Cross-cutting")}  ${t.bold(String(crossCuttingFiles.length))} file${crossCuttingFiles.length === 1 ? "" : "s"} span ${t.bold("3+")} layers`,
    );
    if (verbose) {
      for (const f of crossCuttingFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.file} (${f.layerSpread} layers: ${f.layers.join(", ")})`));
      }
    }
  }

  // Layer consistency score
  const layerConsistency = layers.length >= 2
    ? computeLayerConsistency(graph, layers, layerEdges)
    : undefined;
  if (layerConsistency) {
    const pct = (layerConsistency.consistency * 100).toFixed(0);
    const violationCount = layerConsistency.violations.length;
    p.log.step(
      violationCount === 0
        ? `${t.brand("Layer order")}    ${pct}% consistent ${t.check()}`
        : `${t.warn("Layer order")}    ${pct}% consistent, ${t.bold(String(violationCount))} violation${violationCount === 1 ? "" : "s"}`,
    );
    if (verbose && violationCount > 0) {
      for (const v of layerConsistency.violations.slice(0, 3)) {
        p.log.info(t.muted(`  ${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`));
      }
    }
  }

  // Chokepoints (articulation points)
  const chokepoints = findChokepoints(graph);
  if (chokepoints.length > 0) {
    p.log.step(
      `${t.brand("Chokepoints")}   ${t.bold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
    );
    if (verbose) {
      for (const cp of chokepoints.slice(0, 5)) {
        p.log.info(t.muted(`  ${cp.file} (separates ${cp.separates} components, ${cp.importedBy} importers)`));
      }
    }
  }

  // Config constraint extraction
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  const hasConstraints = configConstraints.typescript || configConstraints.linter || configConstraints.formatter;
  if (hasConstraints) {
    const parts: string[] = [];
    if (configConstraints.typescript) parts.push("tsconfig");
    if (configConstraints.linter) parts.push(configConstraints.linter.tool.toLowerCase());
    if (configConstraints.formatter && !configConstraints.linter) parts.push(configConstraints.formatter.tool.toLowerCase());
    p.log.step(`${t.brand("Config")}         extracted constraints from ${parts.join(", ")}`);
  }

  // Convention inference (fills gaps not covered by config constraints)
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  if (conventions) {
    const parts: string[] = [];
    if (Object.values(conventions.naming).some((v) => v !== "mixed")) parts.push("naming");
    if (conventions.exportStyle.preferNamed) parts.push("exports");
    if (conventions.importOrdering) parts.push("imports");
    if (parts.length > 0) {
      p.log.step(`${t.brand("Conventions")}   inferred ${parts.join(", ")} patterns`);
    }
  }

  // Test-source mapping
  const testMapping = buildTestMapping(graph, detected);
  if (testMapping) {
    const coveredCount = testMapping.sourceToTests.size;
    const untestedCount = testMapping.untestedFiles.length;
    p.log.step(
      `${t.brand("Test map")}       ${t.bold(String(coveredCount))} source file${coveredCount === 1 ? "" : "s"} with tests` +
        (untestedCount > 0 ? `, ${t.warn(String(untestedCount))} untested` : ` ${t.check()}`),
    );
    if (verbose && untestedCount > 0) {
      for (const f of testMapping.untestedFiles.slice(0, 5)) {
        p.log.info(t.muted(`  untested: ${f}`));
      }
    }
  }

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, layerEdges, gitActivity, instabilities, communities, exportCoverage, deadFiles, configConstraints, crossCuttingFiles, layerConsistency, chokepoints, conventions: conventions ?? undefined, testMapping: testMapping ?? undefined };

  // Analysis report box
  {
    const reportLines: string[] = [];
    reportLines.push(`  ${t.soft("Files analyzed")}  ${t.soft(String(fileCount))}`);
    reportLines.push(`  ${t.soft("Import edges")}    ${t.soft(String(graph.edges.length))}`);
    reportLines.push(`  ${t.soft("External pkgs")}   ${t.soft(String(graph.externalImportCounts.size))}`);
    if (analysisHubFiles.length > 0) {
      const mostConnected = analysisHubFiles[0].path;
      reportLines.push(`  ${t.soft("Hub files")}       ${t.soft(`${analysisHubFiles.length} (most connected: ${mostConnected})`)}`);
    }
    if (analysisLayers.length > 0) {
      reportLines.push(`  ${t.soft("Architecture")}    ${t.soft(analysisLayers.map((l) => l.name).join(" \u2192 "))}`);
    }
    reportLines.push(`  ${t.soft("Circular deps")}   ${analysisCircularDeps.length === 0 ? t.soft("none") : t.soft(`${analysisCircularDeps.length} chain${analysisCircularDeps.length === 1 ? "" : "s"}`)}`);
    if (gitActivity) {
      reportLines.push(`  ${t.soft("Hot files (90d)")} ${t.soft(String(gitActivity.hotFiles.length))}`);
    }
    p.note(reportLines.join("\n"), "Analysis Report");

    // Show cycle chains inline below the box (max 2)
    if (analysisCircularDeps.length > 0) {
      for (const c of analysisCircularDeps.slice(0, 2)) {
        const shortChain = c.chain.map((f) => f.split("/").pop() ?? f);
        p.log.warn(t.text(`Cycle: ${shortChain.join(" \u2192 ")}`));
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
        t.text(
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
      t.text("Using saved config from ") + t.brand(".clarte.json") + " " +
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
        t.muted("Saved config to .clarte.json for future runs."),
      );
    }
  }

  // Step 3: Code snapshot (if requested)
  let snapshot = null;
  if (answers.generateSnapshot) {
    const snapshotShimmer = startShimmer("Scanning source files for code snapshot...");
    const snapshotProgress: ProgressCallback = (msg) => snapshotShimmer.message(msg);
    snapshot = await generateSnapshot(detected, answers.snapshotPaths, graph, maxTokens, verbose ? verboseLog : snapshotProgress, gitActivity);
    snapshotShimmer.stop();
    const count = snapshot.entries.length;
    const budgetNote = snapshot.budgetExcluded
      ? ` (${snapshot.budgetExcluded} excluded by token budget)`
      : "";
    p.log.step(
      count > 0
        ? t.text(`Found ${count} type${count === 1 ? "" : "s"}/signature${count === 1 ? "" : "s"}.${budgetNote}`)
        : t.text("No extractable types found (snapshot will be skipped)."),
    );

    if (count === 0) {
      snapshot = null;
    }
  }

  // Step 4: Generate files
  const genShimmer = startShimmer(
    dryRun ? "Preparing context files..." : "Generating context files...",
  );
  const shouldGenerateSkills = generateSkills || answers.ides.includes("claude");
  const files = await generateFiles(detected, answers, snapshot, force, dryRun, analysis, shouldGenerateSkills, verbose ? verboseLog : undefined);
  genShimmer.stop();
  p.log.step(
    t.text(
      dryRun
        ? `Would generate ${files.length} file${files.length === 1 ? "" : "s"}.`
        : `Generated ${files.length} file${files.length === 1 ? "" : "s"}.`,
    ),
  );

  if (files.length === 0) {
    p.outro(t.text("Nothing to write. Done!"));
    return;
  }

  // Step 5: Summary + token estimate
  printSummary(files, detected, snapshot, analysis);

  // Elapsed time
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  if (dryRun) {
    p.outro(
      t.text("DRY RUN complete. ") +
        t.muted(`no files were written. Remove --dry-run to generate. (${elapsed}s)`),
    );
    return;
  }

  // Step 6: Done!
  p.outro(
    t.brand(`Done in ${elapsed}s! `) +
      t.muted(
        "Your context files are ready. They are living documents: keep them up to date as your project evolves.",
      ),
  );
}

/**
 * --diff mode: generate focused context for changed files and their neighbors.
 */
async function runDiffMode(rootDir: string, ref?: string, verbose = false): Promise<void> {
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(t.muted(msg));
  };

  // Get changed files from git
  let changedFiles: string[];
  try {
    const cmd = ref
      ? `git diff --name-only ${ref}...HEAD`
      : "git diff --name-only HEAD";
    let output = execSync(cmd, { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();

    // Also include staged + unstaged changes if no ref
    if (!ref) {
      const staged = execSync("git diff --name-only --cached", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
      const unstaged = execSync("git diff --name-only", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
      output = [output, staged, unstaged].filter(Boolean).join("\n");
    }

    changedFiles = [...new Set(output.split("\n").filter(Boolean))];
  } catch {
    p.log.error(t.text("Failed to get changed files from git. Is this a git repo?"));
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    p.log.info(t.text("No changed files detected."));
    return;
  }

  p.log.step(t.text(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`));

  // Detect context and build import graph
  const detected = await detectContext(rootDir, verboseLog);
  const graph = await buildImportGraph(rootDir, detected.language, verboseLog);

  // Expand to 1-hop neighbors in the import graph
  const changedSet = new Set(changedFiles);
  const neighborSet = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.from)) neighborSet.add(edge.to);
    if (changedSet.has(edge.to)) neighborSet.add(edge.from);
  }

  // Remove changed files from neighbors (they're already included)
  for (const f of changedSet) neighborSet.delete(f);

  // Find test files that may cover changed files
  const testFiles = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.to) && isTestFile(edge.from)) {
      testFiles.add(edge.from);
    }
  }

  const allRelevant = [...changedSet, ...neighborSet, ...testFiles];

  p.log.step(
    t.text(`Scope: ${changedFiles.length} changed, ${neighborSet.size} neighbor${neighborSet.size === 1 ? "" : "s"}, ${testFiles.size} test file${testFiles.size === 1 ? "" : "s"}`),
  );

  // Build focused output
  const sections: string[] = [];
  sections.push("# Diff Context");
  sections.push("");
  sections.push(`> Focused context for ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}${ref ? ` vs \`${ref}\`` : ""}.`);
  sections.push("");

  // Changed files
  sections.push("## Changed Files");
  sections.push("");
  for (const f of changedFiles) {
    const importedBy = graph.inDegree.get(f) ?? 0;
    const note = importedBy > 0 ? ` (imported by ${importedBy} file${importedBy === 1 ? "" : "s"})` : "";
    sections.push(`- \`${f}\`${note}`);
  }
  sections.push("");

  // Neighbor files (1-hop)
  if (neighborSet.size > 0) {
    sections.push("## Affected Neighbors");
    sections.push("");
    sections.push("> These files import or are imported by changed files. Review for ripple effects.");
    sections.push("");
    for (const f of [...neighborSet].sort()) {
      const importedBy = graph.inDegree.get(f) ?? 0;
      const note = importedBy > 0 ? ` (imported by ${importedBy})` : "";
      sections.push(`- \`${f}\`${note}`);
    }
    sections.push("");
  }

  // Test files
  if (testFiles.size > 0) {
    sections.push("## Related Tests");
    sections.push("");
    for (const f of [...testFiles].sort()) {
      sections.push(`- \`${f}\``);
    }
    sections.push("");
  }

  // Key types/signatures from changed files
  const relevantHub = graph.centrality;
  const hubInScope = allRelevant
    .filter(f => (relevantHub.get(f) ?? 0) > 0.1)
    .sort((a, b) => (relevantHub.get(b) ?? 0) - (relevantHub.get(a) ?? 0));

  if (hubInScope.length > 0) {
    sections.push("## Key Files in Scope");
    sections.push("");
    sections.push("| File | Centrality | Imported By |");
    sections.push("|------|-----------|-------------|");
    for (const f of hubInScope.slice(0, 10)) {
      const centrality = (relevantHub.get(f) ?? 0).toFixed(3);
      const importedBy = graph.inDegree.get(f) ?? 0;
      sections.push(`| \`${f}\` | ${centrality} | ${importedBy} |`);
    }
    sections.push("");
  }

  const output = sections.join("\n");
  console.log("");
  console.log(output);
}

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    /\/__tests__\//.test(filePath) ||
    /\/test_[^/]+\.py$/.test(filePath) ||
    /\/tests\//.test(filePath);
}

main().catch((err) => {
  console.error(t.error("Fatal error:"), err);
  process.exit(1);
});
