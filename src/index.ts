import path from "node:path";
import { execSync } from "node:child_process";
import * as p from "@clack/prompts";
import { theme as t, initTheme } from "./theme.js";
import { fileExists, writeFileSafe } from "./utils.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect.js";
import { runPrompts } from "./prompts.js";
import { generateSnapshot } from "./snapshot.js";
import { generateFiles } from "./generate.js";
import { printSummary } from "./summary.js";
import {
  loadConfig,
  saveConfig,
  saveColorScheme,
  configToAnswers,
  computeSnapshotHash,
} from "./config.js";
import { refreshSnapshot } from "./refresh.js";
import { runBriefMode } from "./brief.js";
import {
  buildImportGraph,
  getHubFiles,
  findCircularDeps,
  detectArchitecturalLayers,
  computeInstability,
  INSTABILITY_THRESHOLD,
  detectCommunities,
  findDeadFiles,
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
  computeGraphTopology,
  findStructuralTemporalMismatches,
  findTightCouplings,
} from "./graph.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { formatBytes } from "./utils.js";
import { startShimmer } from "./animations.js";
import type { ContextAnalysis, ProgressCallback } from "./types.js";
import { serializeAnalysis } from "./serialize.js";
import { buildDirectives } from "./templates/directives.js";

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
  console.log(t.brandBold(" Clart") + t.textBold("\u00e9 "));
  console.log(t.muted("  " + DESCRIPTION));
  console.log("");
  console.log(`  ${t.textBold("Usage:")}  ${t.text(`npx ${NAME} [directory] [options]`)}`);
  console.log("");
  console.log(`  ${t.textBold("Commands:")}`);
  console.log(`    ${t.accent("brief")}                   ${t.text("Compact summary for session hooks (stdout, no ANSI)")}`);
  console.log("");
  console.log(`  ${t.textBold("Options:")}`);
  console.log(`    ${t.accent("-h, --help")}              ${t.text("Show this help message")}`);
  console.log(`    ${t.accent("-V, --version")}           ${t.text("Show version number")}`);
  console.log(`    ${t.accent("--force")}                 ${t.text("Overwrite existing files without asking")}`);
  console.log(`    ${t.accent("--dry-run")}               ${t.text("Preview what would be generated")}`);
  console.log(`    ${t.accent("--diff[=REF]")}            ${t.text("Generate focused context for changed files (vs HEAD or REF)")}`);
  console.log(`    ${t.accent("--reconfigure")}           ${t.text("Re-prompt even if .clarte.json exists")}`);
  console.log(`    ${t.accent("--refresh-snapshot")}      ${t.text("Re-scan source files, update code snapshot only")}`);
  console.log(`    ${t.accent("--check")}                 ${t.text("Exit 0 if snapshot is fresh, 1 if stale (hash-based)")}`);
  console.log(`    ${t.accent("--check=timestamp")}       ${t.text("Exit 0/1 based on age only (no Node.js needed in shell hooks)")}`);
  console.log(`    ${t.accent("--max-tokens=N")}          ${t.text("Set the token budget for the code snapshot")}`);
  console.log(`    ${t.accent("--format=json")}           ${t.text("Output full analysis as structured JSON to stdout")}`);
  console.log(`    ${t.accent("--budget=N")}              ${t.text("Set token budget for the context file (prioritized sections)")}`);
  console.log(`    ${t.accent("--generate-skills")}       ${t.text("Generate Claude Code skill files")}`);
  console.log(`    ${t.accent("-v, --verbose")}           ${t.text("Show detailed progress output")}`);
  console.log("");
  console.log(`  ${t.textBold("Examples:")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME}`)}                   ${t.muted("# analyze current directory")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} ./my-project`)}      ${t.muted("# analyze a specific project")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff`)}             ${t.muted("# focused context for uncommitted changes")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff=main`)}        ${t.muted("# focused context vs main branch")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --dry-run`)}          ${t.muted("# preview without writing files")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --refresh-snapshot`)} ${t.muted("# update code snapshot only")}`);
  console.log("");
}

async function main() {
  const startTime = performance.now();
  const args = process.argv.slice(2);

  // Early-exit flags (before any project validation)
  if (args.includes("--help") || args.includes("-h")) {
    initTheme("dark");
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
  const diffArg = args.find((a) => a === "--diff" || a.startsWith("--diff="));
  const diffMode = !!diffArg;
  const diffRef = diffArg?.startsWith("--diff=") ? diffArg.split("=")[1] : undefined;
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
  const formatArg = args.find((a) => a.startsWith("--format="));
  const jsonMode = formatArg?.split("=")[1] === "json";
  const budgetArg = args.find((a) => a.startsWith("--budget="));
  const budget = budgetArg ? parseInt(budgetArg.split("=")[1], 10) : undefined;
  const briefMode = args[0] === "brief";
  const targetDir = args.find((a) => !a.startsWith("-") && a !== "brief" && a !== "-v") ?? process.cwd();
  const rootDir = path.resolve(targetDir);

  // brief: compact summary for session hooks (no ANSI, stdout only)
  // Must be before project marker check: brief is a silent no-op in non-project dirs.
  if (briefMode) {
    await runBriefMode(rootDir, maxTokens ?? budget ?? 3000, verbose);
    process.exit(0);
  }

  // Early validation: ensure this looks like a project directory
  const PROJECT_MARKERS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt"];
  const hasProjectMarker = (await Promise.all(
    PROJECT_MARKERS.map(f => fileExists(path.join(rootDir, f)))
  )).some(Boolean);

  if (!hasProjectMarker) {
    initTheme("dark");
    console.log("");
    console.log(t.error(`No project found at ${rootDir}`));
    console.log(t.text(`Run ${t.accent("npx clarte")} from a project directory, or pass a path:`));
    console.log(t.muted("  npx clarte ./my-project"));
    process.exit(1);
  }

  // Verbose logger: persists messages on screen (not swallowed by spinner)
  const noopProgress: ProgressCallback = () => {};
  const verboseLog: ProgressCallback = jsonMode
    ? noopProgress
    : (msg) => { if (verbose) p.log.info(t.muted(msg)); };

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

  // Determine color scheme: env var > saved config > interactive prompt
  let colorScheme: "dark" | "light" = "dark";
  if (jsonMode) {
    // JSON mode: skip theme selection, use default
    initTheme("dark");
  } else {
    const envTheme = process.env.CLARTE_THEME;
    if (envTheme === "dark" || envTheme === "light") {
      colorScheme = envTheme;
    } else {
      const earlyConfig = await loadConfig(rootDir);
      if (earlyConfig?.colorScheme) {
        colorScheme = earlyConfig.colorScheme;
      } else {
        // First run: ask with unpatched clack (default ANSI colors)
        const selected = await p.select({
          message: "Which terminal background are you using?",
          options: [
            { value: "dark" as const, label: "Dark background", hint: "default" },
            { value: "light" as const, label: "Light background" },
          ],
        });
        if (p.isCancel(selected)) {
          process.exit(0);
        }
        colorScheme = selected;
        // Persist for future runs (into existing config if present)
        await saveColorScheme(rootDir, colorScheme);
      }
    }
    initTheme(colorScheme);
  }

  if (!jsonMode) {
    console.log("");
    p.intro(t.brandBold(" Clart") + t.textBold("\u00e9 "));
    p.log.info(t.muted("code analysis for AI context"));
  }

  // --refresh-snapshot: fast path, update snapshot in existing context file
  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.text("Snapshot refreshed!"));
    return;
  }

  // --diff: focused context for changed files
  if (diffMode) {
    p.log.info(t.muted("diff-aware context"));
    await runDiffMode(rootDir, diffRef, verbose);
    return;
  }

  if (!jsonMode && dryRun) {
    p.log.warn(t.warn("DRY RUN: no files will be written"));
  }

  if (!jsonMode) p.log.info(t.text(`Analyzing ${t.accent(rootDir)}`));

  // Step 1: Auto-detect
  const noopShimmer = { message: (_: string) => {}, stop: () => {} };
  let shimmer = jsonMode ? noopShimmer : startShimmer("Detecting stack...");
  const detected = await detectContext(rootDir, verbose ? verboseLog : (msg) => shimmer.message(msg));
  shimmer.stop();
  if (!jsonMode) p.log.step(t.text("Detection complete."));

  // Step 1.5: Build import graph (including secondary languages)
  shimmer = jsonMode ? noopShimmer : startShimmer(`Building import graph (${detected.sourceFileCount} files)...`);
  const graph = await buildImportGraph(rootDir, detected.language, verbose ? verboseLog : (msg) => shimmer.message(msg));

  // Merge secondary language graphs if present
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      shimmer.message(`Building ${secLang} import graph...`);
      const secGraph = await buildImportGraph(rootDir, secLang, verbose ? verboseLog : undefined);
      // Merge edges and maps (no cross-language edges)
      graph.edges.push(...secGraph.edges);
      for (const [k, v] of secGraph.inDegree) {
        graph.inDegree.set(k, (graph.inDegree.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.centrality) {
        if (!graph.centrality.has(k)) graph.centrality.set(k, v);
      }
      for (const [k, v] of secGraph.externalImportCounts) {
        graph.externalImportCounts.set(k, (graph.externalImportCounts.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.authority) {
        if (!graph.authority.has(k)) graph.authority.set(k, v);
      }
      for (const [k, v] of secGraph.hubScores) {
        if (!graph.hubScores.has(k)) graph.hubScores.set(k, v);
      }
    }
  }

  const topHub = getHubFiles(graph, 1)[0];
  shimmer.stop();
  if (!jsonMode) {
    p.log.step(
      `${t.text("Import graph:")} ${t.textBold(String(graph.edges.length))} ${t.text("edges,")} ${t.textBold(String(graph.externalImportCounts.size))} ${t.text("packages.")}` +
        (topHub ? t.muted(` Top hub: ${topHub.path}`) : ""),
    );
  }

  // Step 1.6: Enrich framework detection with actual import usage
  detected.frameworks = enrichFrameworksWithUsage(
    detected.frameworks,
    graph.externalImportCounts,
  );

  // Discovery log (enhanced stack box)
  if (!jsonMode) {
    const lines: string[] = [];
    const lang = detected.hasTypeScript ? "TypeScript" : detected.language !== "other" ? detected.language.charAt(0).toUpperCase() + detected.language.slice(1) : "";
    if (lang) lines.push(`  ${"Language"}   ${t.textBold(lang)}`);
    if (detected.frameworks.length > 0) {
      lines.push(`  ${"Frameworks"} ${t.textBold(detected.frameworks.map((f) => f.name).join(", "))}`);
    }
    if (detected.linter !== "none") {
      lines.push(`  ${"Linter"}     ${t.textBold(detected.linter.charAt(0).toUpperCase() + detected.linter.slice(1))}`);
    }
    if (detected.packageManager !== "none") {
      lines.push(`  ${"Pkg mgr"}    ${t.textBold(detected.packageManager)}`);
    }
    if (detected.testFramework) {
      lines.push(`  ${"Testing"}    ${t.textBold(detected.testFramework)}`);
    }
    if (detected.ciProvider) {
      lines.push(`  ${"CI"}         ${t.textBold(detected.ciProvider)}`);
    }
    if (detected.monorepo) {
      lines.push(`  ${"Monorepo"}   ${t.textBold(`${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`)}`);
    }
    if (detected.sourceFileCount > 0) {
      lines.push(`  ${"Files"}      ${t.textBold(`${detected.sourceFileCount}`)} ${t.muted(`(${formatBytes(detected.totalSourceBytes)})`)}`);
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  // Step 1.7: Structural analysis (progressive reveal via shimmer)
  const fileCount = graph.centrality.size;

  // HITS analysis
  const hubFiles = getHubFiles(graph);
  if (!jsonMode) {
    const topHubName = hubFiles[0]?.path ?? "";
    p.log.step(
      hubFiles.length > 0
        ? `${t.brand("HITS")}           found ${t.textBold(String(hubFiles.length))} key files` +
          (topHubName ? t.muted(` (top: ${topHubName})`) : "")
        : `${t.brand("HITS")}           ${t.muted("no key files detected")}`,
    );
    if (verbose && hubFiles.length > 0) {
      for (const h of hubFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`));
      }
    }
    var analysisHubFiles = hubFiles;
  }

  // Tarjan SCC: cycle detection (single call with real data)
  const circularDeps = findCircularDeps(graph);
  if (!jsonMode) {
    p.log.step(
      circularDeps.length === 0
        ? `${t.brand("Tarjan SCC")}     no cycles found ${t.check()}`
        : `${t.brand("Tarjan SCC")}     ${t.textBold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found ${t.warn("\u26A0")}`,
    );
    if (verbose && circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 3)) {
        p.log.info(t.muted(`  ${c.chain.join(" → ")}`));
      }
    }
    var analysisCircularDeps = circularDeps;
  }

  // Architecture layers
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  if (!jsonMode) {
    p.log.step(
      layers.length > 0
        ? `${t.brand("Layers")}         ${layers.map((l) => l.name).join(" \u2192 ")}`
        : `${t.brand("Layers")}         ${t.muted("no clear layers detected")}`,
    );
    if (verbose && layers.length > 0) {
      for (const l of layers) {
        p.log.info(t.muted(`  ${l.name}: ${l.files.length} files, depends on: ${l.dependsOn.join(", ") || "none"}`));
      }
    }
    var analysisLayers = layers;
    var analysisLayerEdges = layerEdges;
  }

  // Instability metrics (no dedicated animation, fast computation)
  const instabilities = computeInstability(graph);
  if (!jsonMode) {
    const highInstability = instabilities.filter((f) => f.instability > INSTABILITY_THRESHOLD);
    p.log.step(
      highInstability.length > 0
        ? `${t.brand("Instability")}    ${t.textBold(String(highInstability.length))} high-risk file${highInstability.length === 1 ? "" : "s"} ${t.warn("\u26A0")}`
        : `${t.brand("Instability")}    ${t.muted("all files within healthy range")} ${t.check()}`,
    );
    if (verbose && highInstability.length > 0) {
      for (const f of highInstability.slice(0, 5)) {
        p.log.info(t.muted(`  ${f.path} (I=${f.instability.toFixed(2)}, fan-in=${f.fanIn}, fan-out=${f.fanOut})`));
      }
    }
    var analysisInstabilities = instabilities;
  }

  // Communities
  const communities = detectCommunities(graph);
  if (!jsonMode) {
    p.log.step(
      communities.length > 0
        ? `${t.brand("Communities")}    ${t.textBold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
        : `${t.brand("Communities")}    ${t.muted("single cohesive module")}`,
    );
    if (verbose && communities.length > 0) {
      for (const c of communities.slice(0, 5)) {
        p.log.info(t.muted(`  ${c.label} (${c.files.length} files)`));
      }
    }
    var analysisCommunities = communities;
  }

  // Git history
  const gitActivity = detected.isGitRepo ? await analyzeGitActivity(rootDir, verbose ? verboseLog : noopProgress) : null;
  if (!jsonMode) {
    if (gitActivity) {
      const coupledPairs = gitActivity.changeCoupling.length;
      p.log.step(
        `${t.brand("Git (90d)")}      ${t.textBold(String(gitActivity.hotFiles.length))} active file${gitActivity.hotFiles.length === 1 ? "" : "s"}, ${t.textBold(String(coupledPairs))} coupled pair${coupledPairs === 1 ? "" : "s"}`,
      );
      if (verbose) {
        for (const h of gitActivity.hotFiles.slice(0, 5)) {
          p.log.info(t.muted(`  ${h.path} (${h.commits} commits, last: ${h.lastChanged})`));
        }
      }
    } else {
      p.log.step(`${t.brand("Git")}            ${t.muted("not a git repo, skipped")}`);
    }
  }

  // Dead files (zero in-degree, excluding entry points and tests)
  const deadFiles = findDeadFiles(graph);
  if (!jsonMode && deadFiles.length > 0) {
    p.log.step(
      `${t.brand("Dead files")}     ${t.textBold(String(deadFiles.length))} file${deadFiles.length === 1 ? "" : "s"} not imported by anything ${t.warn("\u26A0")}`,
    );
    if (verbose) {
      for (const f of deadFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${f}`));
      }
    }
  }

  // Cross-cutting files (imported across multiple layers)
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  if (!jsonMode && crossCuttingFiles.length > 0) {
    p.log.step(
      `${t.brand("Cross-cutting")}  ${t.textBold(String(crossCuttingFiles.length))} file${crossCuttingFiles.length === 1 ? "" : "s"} span ${t.textBold("3+")} layers`,
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
  if (!jsonMode && layerConsistency) {
    const pct = (layerConsistency.consistency * 100).toFixed(0);
    const violationCount = layerConsistency.violations.length;
    p.log.step(
      violationCount === 0
        ? `${t.brand("Layer order")}    ${pct}% consistent ${t.check()}`
        : `${t.brand("Layer order")}    ${pct}% consistent, ${t.textBold(String(violationCount))} violation${violationCount === 1 ? "" : "s"} ${t.warn("\u26A0")}`,
    );
    if (verbose && violationCount > 0) {
      for (const v of layerConsistency.violations.slice(0, 3)) {
        p.log.info(t.muted(`  ${v.from} (${v.fromLayer}) imports ${v.to} (${v.toLayer})`));
      }
    }
  }

  // Chokepoints (articulation points)
  const chokepoints = findChokepoints(graph);
  if (!jsonMode && chokepoints.length > 0) {
    p.log.step(
      `${t.brand("Chokepoints")}   ${t.textBold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
    );
    if (verbose) {
      for (const cp of chokepoints.slice(0, 5)) {
        p.log.info(t.muted(`  ${cp.file} (separates ${cp.separates} components, ${cp.importedBy} importers)`));
      }
    }
  }

  // Config constraint extraction
  const configConstraints = await scanConfigConstraints(rootDir, detected);
  if (!jsonMode) {
    const hasConstraints = configConstraints.typescript || configConstraints.linter || configConstraints.formatter;
    if (hasConstraints) {
      const parts: string[] = [];
      if (configConstraints.typescript) parts.push("tsconfig");
      if (configConstraints.linter) parts.push(configConstraints.linter.tool.toLowerCase());
      if (configConstraints.formatter && !configConstraints.linter) parts.push(configConstraints.formatter.tool.toLowerCase());
      p.log.step(`${t.brand("Config")}         extracted constraints from ${parts.join(", ")}`);
    }
  }

  // Convention inference (fills gaps not covered by config constraints)
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  if (!jsonMode && conventions) {
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
  if (!jsonMode && testMapping) {
    const coveredCount = testMapping.sourceToTests.size;
    const untestedCount = testMapping.untestedFiles.length;
    p.log.step(
      `${t.brand("Test map")}       ${t.textBold(String(coveredCount))} source file${coveredCount === 1 ? "" : "s"} with tests` +
        (untestedCount > 0 ? `, ${t.warn(String(untestedCount))} untested` : ` ${t.check()}`),
    );
    if (verbose && untestedCount > 0) {
      for (const f of testMapping.untestedFiles.slice(0, 5)) {
        p.log.info(t.muted(`  untested: ${f}`));
      }
    }
  }

  // Graph topology (connected components, diameter)
  const graphTopology = computeGraphTopology(graph);
  if (!jsonMode) {
    if (graphTopology.isFragmented) {
      p.log.step(
        `${t.brand("Topology")}       ${t.textBold(String(graphTopology.componentCount))} connected component${graphTopology.componentCount === 1 ? "" : "s"} (fragmented) ${t.warn("\u26A0")}`,
      );
      if (verbose) {
        const sizes = graphTopology.componentSizes.slice(0, 5).join(", ");
        p.log.info(t.muted(`  Component sizes: ${sizes}${graphTopology.componentSizes.length > 5 ? ", ..." : ""}`));
        p.log.info(t.muted(`  Approximate diameter: ${graphTopology.approximateDiameter} hops`));
      }
    } else if (verbose) {
      p.log.step(
        `${t.brand("Topology")}       single connected graph, diameter ~${graphTopology.approximateDiameter} hops`,
      );
    }
  }

  // Structural-temporal mismatch detection
  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;

  // Tight coupling detection
  const tightCouplings = findTightCouplings(graph);

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, layerEdges, gitActivity, instabilities, communities, deadFiles, configConstraints, crossCuttingFiles, layerConsistency, chokepoints, conventions: conventions ?? undefined, testMapping: testMapping ?? undefined, graphTopology, structuralMismatches: structuralMismatches?.length ? structuralMismatches : undefined, tightCouplings: tightCouplings.length ? tightCouplings : undefined };

  // --format=json: output full analysis as structured JSON and exit
  if (jsonMode) {
    const savedCfg = await loadConfig(rootDir);
    let snapshot = null;
    if (savedCfg?.generateSnapshot !== false) {
      snapshot = await generateSnapshot(detected, savedCfg?.snapshotPaths ?? [], graph, maxTokens);
      if (snapshot.entries.length === 0) snapshot = null;
    }
    const directives = buildDirectives(analysis, detected);
    const output = serializeAnalysis(detected, analysis, snapshot, graph, directives);
    process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    process.exit(0);
  }

  // Analysis report box
  {
    const reportLines: string[] = [];
    reportLines.push(`  ${"Files analyzed"}  ${t.textBold(String(fileCount))}`);
    reportLines.push(`  ${"Import edges"}    ${t.textBold(String(graph.edges.length))}`);
    reportLines.push(`  ${"External pkgs"}   ${t.textBold(String(graph.externalImportCounts.size))}`);
    if (hubFiles.length > 0) {
      reportLines.push(`  ${"Hub files"}       ${t.textBold(String(hubFiles.length))}` + (hubFiles[0] ? ` ${t.text(`(most connected: ${hubFiles[0].path})`)}` : ""));
    }
    if (layers.length > 0) {
      reportLines.push(`  ${"Architecture"}    ${t.textBold(layers.map((l) => l.name).join(" → "))}`);
    }
    reportLines.push(`  ${"Circular deps"}   ${circularDeps.length === 0 ? t.textBold("none") : t.text(`${circularDeps.length} chain${circularDeps.length === 1 ? "" : "s"}`)}`);
    if (gitActivity) {
      reportLines.push(`  ${"Hot files (90d)"} ${t.textBold(String(gitActivity.hotFiles.length))}`);
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
      t.text(`Using saved config from ${t.accent(".clarte.json")}`) + " " +
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
    shimmer = startShimmer("Scanning source files for code snapshot...");
    snapshot = await generateSnapshot(detected, answers.snapshotPaths, graph, maxTokens, verbose ? verboseLog : (msg) => shimmer.message(msg), gitActivity);
    shimmer.stop();
    const count = snapshot.entries.length;
    const budgetNote = snapshot.budgetExcluded
      ? ` (${snapshot.budgetExcluded} excluded by token budget)`
      : "";
    p.log.step(
      count > 0
        ? `${t.text("Found")} ${t.textBold(String(count))} ${t.text(`type${count === 1 ? "" : "s"}/signature${count === 1 ? "" : "s"}.${budgetNote}`)}`
        : t.text("No extractable types found (snapshot will be skipped)."),
    );

    if (count === 0) {
      snapshot = null;
    }
  }

  // Step 4: Generate files
  shimmer = startShimmer(
    dryRun ? "Preparing context files..." : "Generating context files...",
  );
  const shouldGenerateSkills = generateSkills || answers.ides.includes("claude");
  const files = await generateFiles(detected, answers, snapshot, force, dryRun, analysis, shouldGenerateSkills, verbose ? verboseLog : undefined, budget);
  shimmer.stop();
  p.log.step(
    dryRun
      ? `${t.text("Would generate")} ${t.textBold(String(files.length))} ${t.text(`file${files.length === 1 ? "" : "s"}.`)}`
      : `${t.text("Generated")} ${t.textBold(String(files.length))} ${t.text(`file${files.length === 1 ? "" : "s"}.`)}`,
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
 * Writes to .clarte-diff.md instead of stdout.
 */
async function runDiffMode(rootDir: string, ref?: string, verbose = false): Promise<void> {
  const verboseLog: ProgressCallback = (msg) => {
    if (verbose) p.log.info(t.muted(msg));
  };

  // 1. Get changed files from git
  let changedFiles: string[];
  let diffStat: Map<string, { added: number; removed: number }> | null = null;
  try {
    const cmd = ref
      ? `git diff --name-only ${ref}...HEAD`
      : "git diff --name-only HEAD";
    let output = execSync(cmd, { cwd: rootDir, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }).trim();

    // Also include staged + unstaged changes if no ref
    if (!ref) {
      const staged = execSync("git diff --name-only --cached", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
      const unstaged = execSync("git diff --name-only", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
      output = [output, staged, unstaged].filter(Boolean).join("\n");
    }

    changedFiles = [...new Set(output.split("\n").filter(Boolean))];

    // Get line change counts
    try {
      const statCmd = ref
        ? `git diff --numstat ${ref}...HEAD`
        : "git diff --numstat HEAD";
      let statOutput = execSync(statCmd, { cwd: rootDir, encoding: "utf-8", timeout: 10000 }).trim();
      if (!ref) {
        const stagedStat = execSync("git diff --numstat --cached", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
        const unstagedStat = execSync("git diff --numstat", { cwd: rootDir, encoding: "utf-8", timeout: 5000 }).trim();
        statOutput = [statOutput, stagedStat, unstagedStat].filter(Boolean).join("\n");
      }
      diffStat = new Map();
      for (const line of statOutput.split("\n").filter(Boolean)) {
        const [addStr, rmStr, file] = line.split("\t");
        if (file && addStr !== "-") {
          const existing = diffStat.get(file);
          const added = parseInt(addStr, 10) || 0;
          const removed = parseInt(rmStr, 10) || 0;
          if (existing) {
            existing.added += added;
            existing.removed += removed;
          } else {
            diffStat.set(file, { added, removed });
          }
        }
      }
    } catch {
      // Line counts are optional; continue without them
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (ref && (msg.includes("unknown revision") || msg.includes("bad revision"))) {
      p.log.error(t.text(`Failed to resolve ref '${ref}'. Verify the branch or commit exists.`));
    } else {
      p.log.error(t.text("Failed to get changed files from git. Is this a git repo?"));
    }
    process.exit(1);
  }

  if (changedFiles.length === 0) {
    p.log.info(t.text("No changed files detected."));
    return;
  }

  p.log.step(t.text(`${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}`));

  // 2. Detect context and build import graph
  const shimmer = startShimmer("Building import graph...");
  const detected = await detectContext(rootDir, verboseLog);
  const graph = await buildImportGraph(rootDir, detected.language, verboseLog);

  // Merge secondary language graphs
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, verboseLog);
      graph.edges.push(...secGraph.edges);
      for (const [k, v] of secGraph.inDegree) {
        graph.inDegree.set(k, (graph.inDegree.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.centrality) {
        if (!graph.centrality.has(k)) graph.centrality.set(k, v);
      }
      for (const [k, v] of secGraph.externalImportCounts) {
        graph.externalImportCounts.set(k, (graph.externalImportCounts.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.authority) {
        if (!graph.authority.has(k)) graph.authority.set(k, v);
      }
      for (const [k, v] of secGraph.hubScores) {
        if (!graph.hubScores.has(k)) graph.hubScores.set(k, v);
      }
    }
  }

  shimmer.stop();

  // 3. Expand to 1-hop neighbors in the import graph
  const changedSet = new Set(changedFiles);
  const neighborSet = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.from)) neighborSet.add(edge.to);
    if (changedSet.has(edge.to)) neighborSet.add(edge.from);
  }
  for (const f of changedSet) neighborSet.delete(f);

  // 4. Find test files using test mapping
  const testMapping = buildTestMapping(graph, detected);
  const testFiles = new Set<string>();
  for (const f of changedSet) {
    const tests = testMapping?.sourceToTests.get(f);
    if (tests) {
      for (const tf of tests) testFiles.add(tf);
    }
  }
  // Also find tests via direct imports (fallback)
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (changedSet.has(edge.to) && isDiffTestFile(edge.from)) {
      testFiles.add(edge.from);
    }
  }

  // 5. Load snapshot entries for changed + neighbor files
  const snapshot = await generateSnapshot(detected, [], graph);
  const entryIndex = new Map<string, typeof snapshot.entries>();
  if (snapshot) {
    for (const entry of snapshot.entries) {
      const arr = entryIndex.get(entry.file) ?? [];
      arr.push(entry);
      entryIndex.set(entry.file, arr);
    }
  }

  const allRelevant = [...changedSet, ...neighborSet, ...testFiles];

  p.log.step(
    t.text(`Scope: ${changedFiles.length} changed, ${neighborSet.size} neighbor${neighborSet.size === 1 ? "" : "s"}, ${testFiles.size} test file${testFiles.size === 1 ? "" : "s"}`),
  );

  // 6. Build markdown output
  const sections: string[] = [];
  sections.push("# Diff Context");
  sections.push("");
  sections.push(`> Focused context for ${changedFiles.length} changed file${changedFiles.length === 1 ? "" : "s"}${ref ? ` vs \`${ref}\`` : ""}. Generated by Clart\u00e9.`);
  sections.push("");

  // Changed files table
  sections.push("## Changed Files");
  sections.push("");
  if (diffStat && diffStat.size > 0) {
    sections.push("| File | Imported By | Lines (+/-) |");
    sections.push("|------|-------------|-------------|");
    for (const f of changedFiles) {
      const importedBy = graph.inDegree.get(f) ?? 0;
      const stat = diffStat.get(f);
      const statStr = stat ? `+${stat.added} / -${stat.removed}` : "";
      sections.push(`| \`${f}\` | ${importedBy} | ${statStr} |`);
    }
  } else {
    sections.push("| File | Imported By |");
    sections.push("|------|-------------|");
    for (const f of changedFiles) {
      const importedBy = graph.inDegree.get(f) ?? 0;
      sections.push(`| \`${f}\` | ${importedBy} |`);
    }
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
    sections.push("> Run these tests after your changes.");
    sections.push("");
    for (const f of [...testFiles].sort()) {
      sections.push(`- \`${f}\``);
    }
    sections.push("");
  }

  // Key files in scope by centrality
  const hubInScope = allRelevant
    .filter(f => (graph.centrality.get(f) ?? 0) > 0.1)
    .sort((a, b) => (graph.centrality.get(b) ?? 0) - (graph.centrality.get(a) ?? 0));

  if (hubInScope.length > 0) {
    sections.push("## Key Files in Scope");
    sections.push("");
    sections.push("| File | Authority | Imported By |");
    sections.push("|------|-----------|-------------|");
    for (const f of hubInScope.slice(0, 10)) {
      const authority = (graph.centrality.get(f) ?? 0).toFixed(3);
      const importedBy = graph.inDegree.get(f) ?? 0;
      sections.push(`| \`${f}\` | ${authority} | ${importedBy} |`);
    }
    sections.push("");
  }

  // Snapshot entries for changed files
  const filesWithEntries = [...changedSet, ...neighborSet]
    .filter(f => entryIndex.has(f))
    .sort((a, b) => (graph.centrality.get(b) ?? 0) - (graph.centrality.get(a) ?? 0));

  if (filesWithEntries.length > 0) {
    sections.push("## Signatures in Scope");
    sections.push("");
    sections.push("Key type signatures and function declarations from changed and neighbor files.");
    sections.push("");
    sections.push("```ts");
    for (const f of filesWithEntries.slice(0, 20)) {
      const entries = entryIndex.get(f) ?? [];
      if (entries.length === 0) continue;
      sections.push(`// ${f}`);
      for (const e of entries.slice(0, 5)) {
        sections.push(e.signature);
        sections.push("");
      }
    }
    sections.push("```");
    sections.push("");
  }

  const content = sections.join("\n");

  // 7. Write to file
  const outPath = path.join(rootDir, ".clarte-diff.md");
  await writeFileSafe(outPath, content);

  const elapsed = ((performance.now() - performance.now()) / 1000).toFixed(1);
  p.log.step(t.text(`Written to ${t.accent(".clarte-diff.md")}`));

  p.outro(
    t.success("Diff context ready. ") +
      t.muted(`${allRelevant.length} files in scope.`),
  );
}

function isDiffTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) ||
    /\/__tests__\//.test(filePath) ||
    /\/test_[^/]+\.py$/.test(filePath) ||
    /\/tests\//.test(filePath);
}

main().catch((err) => {
  console.error(t.error("Fatal error:"), err);
  process.exit(1);
});
