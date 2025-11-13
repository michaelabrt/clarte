import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t, initTheme, patchPicocolors, unpatchPicocolors, resetTerminalColors } from "./theme.js";
import { fileExists, writeFileSafe } from "./utils.js";
import { detectContext, detectIDEs, detectProjectDescription, enrichFrameworksWithUsage } from "./detect.js";
import { runPrompts } from "./prompts.js";
import { generateSnapshot } from "./snapshot.js";
import { generateFiles } from "./generate.js";
import type { SectionFilterOptions } from "./templates/main-context.js";
import { printSummary } from "./summary.js";
import {
  loadConfig,
  saveConfig,
  configToAnswers,
  computeSnapshotHash,
} from "./config.js";
import { refreshSnapshot } from "./refresh.js";
import { validateContextPaths } from "./check.js";
import { initPreCommitHook } from "./hooks.js";
import { runDiffMode } from "./diff.js";
import { runWatchMode } from "./watch.js";
import {
  buildGraphWithCache,
  computeAnalysisCacheKey,
  loadAnalysisCache,
  saveAnalysisCache,
  type AnalysisCacheData,
} from "./cache.js";
import {
  buildImportGraph,
  mergeGraph,
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
import { analyzeMonorepoGraph, computePackageCentrality } from "./monorepo-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { predictChangeImpact } from "./change-impact.js";
import { formatBytes } from "./utils.js";
import { startShimmer } from "./animations.js";
import type { ContextAnalysis, PackageHubFile, ProgressCallback } from "./types.js";
import { serializeAnalysis } from "./serialize.js";
import { buildDirectives } from "./templates/directives.js";
import {
  extractSnapshot,
  loadPreviousSnapshot,
  saveSnapshot,
  computeDelta,
  isDeltaEmpty,
  renderDeltaSection,
} from "./delta.js";

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
  console.log(`    ${t.accent("--diff[=REF] [FILES]")}    ${t.text("Generate focused context for changed files (vs HEAD or REF)")}`);
  console.log(`    ${t.accent("--diff-file=PATH")}        ${t.text("Write diff context to file instead of stdout")}`);
  console.log(`    ${t.accent("--reconfigure")}           ${t.text("Re-prompt even if .clarte.json exists")}`);
  console.log(`    ${t.accent("--refresh-snapshot")}      ${t.text("Re-scan source files, update code snapshot only")}`);
  console.log(`    ${t.accent("--check")}                 ${t.text("Exit 0 if snapshot is fresh, 1 if stale (hash-based)")}`);
  console.log(`    ${t.accent("--check=timestamp")}       ${t.text("Exit 0/1 based on age only (no Node.js needed in shell hooks)")}`);
  console.log(`    ${t.accent("--ci")}                    ${t.text("Machine-readable output (use with --check for CI pipelines)")}`);
  console.log(`    ${t.accent("--max-tokens=N")}          ${t.text("Set the token budget for the code snapshot")}`);
  console.log(`    ${t.accent("--format=json")}           ${t.text("Output full analysis as structured JSON to stdout")}`);
  console.log(`    ${t.accent("--budget=N")}              ${t.text("Set token budget for the context file (prioritized sections)")}`);
  console.log(`    ${t.accent("--full")}                  ${t.text("Disable token budget (include all sections)")}`);
  console.log(`    ${t.accent("--include=a,b")}           ${t.text("Always include these sections (comma-separated IDs)")}`);
  console.log(`    ${t.accent("--exclude=a,b")}           ${t.text("Exclude these sections entirely")}`);
  console.log(`    ${t.accent("--generate-skills")}       ${t.text("Generate Claude Code skill files")}`);
  console.log(`    ${t.accent("--init-hook")}             ${t.text("Install git pre-commit hook for auto-refresh on commit")}`);
  console.log(`    ${t.accent("--watch")}                 ${t.text("Watch for file changes and re-analyze continuously")}`);
  console.log(`    ${t.accent("-v, --verbose")}           ${t.text("Show detailed progress output")}`);
  console.log("");
  console.log(`  ${t.textBold("Examples:")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME}`)}                   ${t.muted("# analyze current directory")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} ./my-project`)}      ${t.muted("# analyze a specific project")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff`)}             ${t.muted("# focused context for uncommitted changes")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff=main`)}        ${t.muted("# focused context vs main branch")}`);
  console.log(`    ${t.muted("$")} ${t.text(`npx ${NAME} --diff src/foo.ts`)}  ${t.muted("# diff context for a specific file")}`);
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
    resetTerminalColors();
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
  // Collect positional args after --diff as file filters
  const diffFilterFiles: string[] = [];
  if (diffMode) {
    const diffIdx = args.indexOf(diffArg!);
    for (let i = diffIdx + 1; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith("-")) break;
      diffFilterFiles.push(a);
    }
  }
  const checkArg = args.find((a) => a === "--check" || a.startsWith("--check="));
  const check = !!checkArg;
  const checkTimestamp = checkArg === "--check=timestamp";
  const ciMode = args.includes("--ci");
  const verbose = args.includes("--verbose") || args.includes("-v");
  const watchMode = args.includes("--watch");
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
  const fullMode = args.includes("--full");
  const includeArg = args.find((a) => a.startsWith("--include="));
  const excludeArg = args.find((a) => a.startsWith("--exclude="));
  const sectionFilter: SectionFilterOptions | undefined = (includeArg || excludeArg)
    ? {
        include: includeArg ? new Set(includeArg.split("=")[1].split(",")) : undefined,
        exclude: excludeArg ? new Set(excludeArg.split("=")[1].split(",")) : undefined,
      }
    : undefined;
  const effectiveBudget = fullMode ? 0 : budget;
  const initHook = args.includes("--init-hook");
  const diffFileArg = args.find((a) => a.startsWith("--diff-file="));
  const diffFile = diffFileArg?.split("=")[1];
  const diffFilterSet = new Set(diffFilterFiles);
  const targetDir = args.find((a) => !a.startsWith("-") && !diffFilterSet.has(a)) ?? process.cwd();
  const rootDir = path.resolve(targetDir);

  // --init-hook: install git pre-commit hook
  if (initHook) {
    await initPreCommitHook(rootDir);
    process.exit(0);
  }

  // Early validation: ensure this looks like a project directory
  const PROJECT_MARKERS = ["package.json", "go.mod", "Cargo.toml", "pyproject.toml", "requirements.txt"];
  const hasProjectMarker = (await Promise.all(
    PROJECT_MARKERS.map(f => fileExists(path.join(rootDir, f)))
  )).some(Boolean);

  if (!hasProjectMarker) {
    initTheme("dark");
    patchPicocolors();
    console.log("");
    console.log(t.error(`No project found at ${rootDir}`));
    console.log(t.text(`Run ${t.accent("npx clarte")} from a project directory, or pass a path:`));
    console.log(t.muted("  npx clarte ./my-project"));
    resetTerminalColors();
    process.exit(1);
  }

  // --watch: continuous analysis mode
  if (watchMode) {
    await runWatchMode(rootDir, verbose);
    return; // runWatchMode never returns, but just in case
  }

  // Verbose logger: persists messages on screen (not swallowed by spinner)
  const noopProgress: ProgressCallback = () => {};
  const verboseLog: ProgressCallback = jsonMode
    ? noopProgress
    : (msg) => { if (verbose) p.log.info(t.muted(msg)); };

  // --check: fast path for shell integration (silent, exit code only)
  // With --ci: machine-readable output, exit codes: 0=fresh, 1=stale, 2=error
  if (check) {
    try {
      const config = await loadConfig(rootDir);

      if (checkTimestamp) {
        // Timestamp-only check: no file globbing or hashing
        if (!config?.snapshotGeneratedAt) {
          if (ciMode) console.log("fresh");
          process.exit(0); // No config or no timestamp: nothing to check
        }
        const staleDays = config.staleDays ?? 7;
        const daysSince = Math.floor(
          (Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24),
        );
        if (daysSince > staleDays) {
          if (ciMode) {
            console.log(`stale: snapshot is ${daysSince}d old`);
          } else {
            console.log(`clarte: snapshot is ${daysSince}d old. Run: npx clarte --refresh-snapshot`);
          }
          process.exit(1);
        }
        // Path validation (also runs for timestamp checks)
        if (config) {
          const pathResult = await validateContextPaths(rootDir, config);
          if (pathResult && pathResult.broken.length > 0) {
            if (ciMode) {
              console.log(`stale: ${pathResult.broken.length} broken file reference(s)`);
            } else {
              console.log(`clarte: ${pathResult.broken.length} broken file reference(s) in ${pathResult.file}: ${pathResult.broken.join(", ")}`);
            }
            process.exit(1);
          }
        }
        if (ciMode) console.log("fresh");
        process.exit(0);
      }

      // Hash-based check (original behavior)
      if (!config?.snapshotHash) {
        if (ciMode) console.log("fresh");
        process.exit(0); // No config or no hash: nothing to check
      }
      const lang = config.language ?? "other";
      const currentHash = await computeSnapshotHash(rootDir, lang);
      if (currentHash !== config.snapshotHash) {
        const daysSince = config.snapshotGeneratedAt
          ? Math.floor((Date.now() - config.snapshotGeneratedAt) / (1000 * 60 * 60 * 24))
          : 0;
        const staleMsg = daysSince > 0 ? ` (last generated ${daysSince}d ago)` : "";
        if (ciMode) {
          console.log(`stale: hash mismatch${staleMsg}`);
        } else {
          console.log(`clarte: snapshot is stale${staleMsg}. Run npx clarte --refresh-snapshot`);
        }
        process.exit(1);
      }

      // Path validation: check for broken file references in context file
      const pathResult = await validateContextPaths(rootDir, config);
      if (pathResult && pathResult.broken.length > 0) {
        if (ciMode) {
          console.log(`stale: ${pathResult.broken.length} broken file reference(s)`);
        } else {
          console.log(`clarte: ${pathResult.broken.length} broken file reference(s) in ${pathResult.file}: ${pathResult.broken.join(", ")}`);
        }
        process.exit(1);
      }
      if (ciMode) console.log("fresh");
      process.exit(0);
    } catch (err: unknown) {
      if (ciMode) {
        console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
        process.exit(2);
      }
      throw err;
    }
  }

  // Determine color scheme: env var > saved config > interactive prompt
  let colorScheme: "dark" | "light" = "dark";
  if (jsonMode) {
    // JSON mode: skip theme selection, use default
    initTheme("dark");
    patchPicocolors();
  } else {
    const envTheme = process.env.CLARTE_THEME;
    if (envTheme === "dark" || envTheme === "light") {
      colorScheme = envTheme;
    } else {
      const earlyConfig = await loadConfig(rootDir);
      if (earlyConfig?.colorScheme) {
        colorScheme = earlyConfig.colorScheme;
      }
      // No saved config and no env var: default to dark
    }
    initTheme(colorScheme);
    patchPicocolors();
  }

  if (!jsonMode) {
    console.log("");
    p.intro(t.textBold("Clart") + t.brandBold("\u00e9"));
    p.log.info(t.muted("pre-built codebase context for AI agents"));
  }

  // --refresh-snapshot: fast path, update snapshot in existing context file
  if (refresh) {
    await refreshSnapshot(rootDir);
    p.outro(t.success("Snapshot refreshed!"));
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  // --diff: focused context for changed files
  if (diffMode) {
    p.log.info(t.muted("diff-aware context"));
    await runDiffMode(rootDir, diffRef, verbose, diffFile, diffFilterFiles);
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

  // Load saved config early (needed for custom layers during analysis)
  const savedConfig = await loadConfig(rootDir);

  // Step 1.5: Build import graph (including secondary languages)
  shimmer = jsonMode ? noopShimmer : startShimmer(`Building import graph (${detected.sourceFileCount} files)...`);
  const graph = await buildGraphWithCache(rootDir, detected.language, verbose ? verboseLog : (msg) => shimmer.message(msg));

  // Merge secondary language graphs if present
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      shimmer.message(`Building ${secLang} import graph...`);
      const secGraph = await buildImportGraph(rootDir, secLang, verbose ? verboseLog : undefined);
      mergeGraph(graph, secGraph);
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
      lines.push(`  ${"Monorepo"}   ${t.text(`${detected.monorepo.type} (${detected.monorepo.packages.length} package${detected.monorepo.packages.length === 1 ? "" : "s"})`)}`);
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

  // Check analysis cache for graph-derived results
  const analysisCacheKey = computeAnalysisCacheKey(graph, savedConfig?.layers);
  const analysisCache = await loadAnalysisCache(rootDir);
  const useAnalysisCache = analysisCache !== null && analysisCache.cacheKey === analysisCacheKey;

  // Key files (HITS analysis)
  const hubFiles = useAnalysisCache ? analysisCache.hubFiles : getHubFiles(graph);
  if (!jsonMode) {
    const topHubName = hubFiles[0]?.path ?? "";
    p.log.step(
      hubFiles.length > 0
        ? `${t.brand("Key files")}      found ${t.textBold(String(hubFiles.length))} key files` +
          (topHubName ? t.muted(` (top: ${topHubName})`) : "")
        : `${t.brand("Key files")}      ${t.muted("no key files detected")}`,
    );
    if (verbose && hubFiles.length > 0) {
      for (const h of hubFiles.slice(0, 5)) {
        p.log.info(t.muted(`  ${h.path} (auth: ${h.authority.toFixed(3)}, hub: ${h.hubScore.toFixed(3)}, role: ${h.role})`));
      }
    }
    var analysisHubFiles = hubFiles;
  }

  // Circular dependency detection (Tarjan SCC)
  const circularDeps = useAnalysisCache ? analysisCache.circularDeps : findCircularDeps(graph);
  if (!jsonMode) {
    p.log.step(
      circularDeps.length === 0
        ? `${t.brand("Circular deps")}  no cycles found ${t.check()}`
        : `${t.brand("Circular deps")}  ${t.textBold(String(circularDeps.length))} cycle${circularDeps.length === 1 ? "" : "s"} found ${t.warn("\u26A0")}`,
    );
    if (verbose && circularDeps.length > 0) {
      for (const c of circularDeps.slice(0, 3)) {
        p.log.info(t.muted(`  ${c.chain.join(" → ")}`));
      }
    }
    var analysisCircularDeps = circularDeps;
  }

  // Architecture layers
  const { layers, layerEdges } = useAnalysisCache
    ? { layers: analysisCache.layers, layerEdges: analysisCache.layerEdges }
    : detectArchitecturalLayers(graph, savedConfig?.layers);
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
  const instabilities = useAnalysisCache ? analysisCache.instabilities : computeInstability(graph);
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

  // Module clusters (community detection)
  const communities = useAnalysisCache ? analysisCache.communities : detectCommunities(graph);
  if (!jsonMode) {
    p.log.step(
      communities.length > 0
        ? `${t.brand("Clusters")}       ${t.textBold(String(communities.length))} module cluster${communities.length === 1 ? "" : "s"}`
        : `${t.brand("Clusters")}       ${t.muted("single cohesive module")}`,
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
  const deadFiles = useAnalysisCache ? analysisCache.deadFiles : findDeadFiles(graph);
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
  const crossCuttingFiles = useAnalysisCache ? analysisCache.crossCuttingFiles : findCrossCuttingFiles(graph, layers);
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
  const layerConsistency = useAnalysisCache
    ? analysisCache.layerConsistency
    : layers.length >= 2
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
  const chokepoints = useAnalysisCache ? analysisCache.chokepoints : findChokepoints(graph);
  if (!jsonMode && chokepoints.length > 0) {
    p.log.step(
      `${t.brand("Chokepoints")}    ${t.textBold(String(chokepoints.length))} structural chokepoint${chokepoints.length === 1 ? "" : "s"}`,
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
      p.log.step(`${t.brand("Conventions")}    inferred ${parts.join(", ")} patterns`);
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
  const graphTopology = useAnalysisCache ? analysisCache.graphTopology : computeGraphTopology(graph);
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
  const tightCouplings = useAnalysisCache ? analysisCache.tightCouplings : findTightCouplings(graph);

  // Monorepo graph analysis
  const monorepoAnalysis = detected.monorepo
    ? await analyzeMonorepoGraph(rootDir, graph, detected.monorepo)
    : undefined;
  if (monorepoAnalysis && detected.monorepo) {
    // Compute per-package hub files (top 3 by authority)
    const packageHubFiles = new Map<string, PackageHubFile[]>();
    for (const pkg of detected.monorepo.packages) {
      const { authority } = computePackageCentrality(graph, pkg.path);
      const topFiles = [...authority.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
        .filter(([, score]) => score > 0)
        .map(([filePath, score]) => ({ path: filePath, authority: score }));
      if (topFiles.length > 0) {
        packageHubFiles.set(pkg.name, topFiles);
      }
    }
    monorepoAnalysis.packageHubFiles = packageHubFiles;
  }
  if (!jsonMode && monorepoAnalysis) {
    const edgeCount = monorepoAnalysis.crossPackageEdges.length;
    const violationCount = monorepoAnalysis.encapsulationViolations.length;
    if (edgeCount > 0) {
      p.log.step(
        `${t.brand("Packages")}       ${t.textBold(String(edgeCount))} cross-package edge${edgeCount === 1 ? "" : "s"}` +
          (violationCount > 0 ? `, ${t.warn(String(violationCount))} encapsulation violation${violationCount === 1 ? "" : "s"}` : ` ${t.check()}`),
      );
      if (verbose && violationCount > 0) {
        for (const v of monorepoAnalysis.encapsulationViolations.slice(0, 5)) {
          p.log.info(t.muted(`  ${v.from} -> ${v.to} (${v.fromPackage} -> ${v.toPackage})`));
        }
      }
    }
  }

  // Compute change impact predictions for top hub files (by authority)
  let changeImpact: Map<string, Array<{ file: string; score: number }>> | undefined;
  if (hubFiles.length > 0) {
    const topHubs = hubFiles
      .slice()
      .sort((a, b) => b.authority - a.authority)
      .slice(0, 5);
    const impactMap = new Map<string, Array<{ file: string; score: number }>>();
    for (const hub of topHubs) {
      const predictions = predictChangeImpact(hub.path, graph, gitActivity);
      if (predictions.length > 0) {
        impactMap.set(hub.path, predictions);
      }
    }
    if (impactMap.size > 0) changeImpact = impactMap;
  }

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, layerEdges, gitActivity, instabilities, communities, deadFiles, configConstraints, crossCuttingFiles, layerConsistency, chokepoints, conventions: conventions ?? undefined, testMapping: testMapping ?? undefined, graphTopology, structuralMismatches: structuralMismatches?.length ? structuralMismatches : undefined, tightCouplings: tightCouplings.length ? tightCouplings : undefined, monorepoAnalysis, changeImpact };

  // Save analysis cache for graph-derived results
  if (!useAnalysisCache) {
    try {
      await saveAnalysisCache(rootDir, {
        version: 1,
        cacheKey: analysisCacheKey,
        hubFiles,
        circularDeps,
        layers,
        layerEdges,
        instabilities,
        communities,
        deadFiles,
        crossCuttingFiles: crossCuttingFiles ?? [],
        layerConsistency,
        chokepoints,
        tightCouplings,
        graphTopology,
      });
    } catch {
      // Cache save failed; non-critical
    }
  }

  // Architecture delta tracking
  const currentAnalysisSnapshot = extractSnapshot(analysis);
  const prevSnapshot = await loadPreviousSnapshot(rootDir);
  let deltaSection: string | null = null;
  if (prevSnapshot) {
    const delta = computeDelta(prevSnapshot, currentAnalysisSnapshot);
    if (!isDeltaEmpty(delta)) {
      deltaSection = renderDeltaSection(delta);
      if (!jsonMode && deltaSection) {
        p.log.step(`${t.brand("Delta")}          architecture changes detected since last run`);
        if (verbose) {
          for (const line of deltaSection.split("\n").filter((l) => l.startsWith("- "))) {
            p.log.info(t.muted(`  ${line.slice(2)}`));
          }
        }
      }
    }
  }
  await saveSnapshot(rootDir, currentAnalysisSnapshot);

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

  // Step 1.8: Check for staleness
  if (savedConfig?.snapshotHash) {
    const currentHash = await computeSnapshotHash(rootDir, detected.language);
    if (currentHash !== savedConfig.snapshotHash && savedConfig.snapshotGeneratedAt) {
      const daysSince = Math.floor(
        (Date.now() - savedConfig.snapshotGeneratedAt) / (1000 * 60 * 60 * 24),
      );
      p.log.warn(
        t.text(
          `Code snapshot may be stale (source files changed${daysSince > 0 ? `, last generated ${daysSince}d ago` : ""}). ` +
            `Run ${t.bold("clarte")} to regenerate.`,
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
  } else if (reconfigure) {
    // Step 2: Interactive prompts (with defaults from saved config)
    answers = await runPrompts(detected, savedConfig, true);

    // Save config for future runs
    if (!dryRun) {
      const hash = await computeSnapshotHash(rootDir, detected.language);
      await saveConfig(rootDir, answers, hash, detected.language);
      p.log.info(
        t.muted("Saved config to .clarte.json for future runs."),
      );
    }
  } else {
    // Zero-config: build answers from auto-detected values
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
        t.text(`Auto-detected IDEs: ${t.accent(detectedIDEs.join(", "))}`) + " " +
          t.muted("(run with --reconfigure to change)"),
      );
    }

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
  const files = await generateFiles(detected, answers, snapshot, force, dryRun, analysis, shouldGenerateSkills, verbose ? verboseLog : undefined, effectiveBudget, sectionFilter);
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
  printSummary(files, snapshot, analysis, !savedConfig);

  // Step 5.5: First-run hook prompt
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

  // Elapsed time
  const elapsed = ((performance.now() - startTime) / 1000).toFixed(1);

  if (dryRun) {
    p.outro(
      t.text("DRY RUN complete. ") +
        t.muted(`no files were written. Remove --dry-run to generate. (${elapsed}s)`),
    );
    unpatchPicocolors();
    resetTerminalColors();
    return;
  }

  // Step 6: Done!
  p.outro(
    t.success(`Done in ${elapsed}s!`) +
      "\n\n" +
      t.muted(
        "Your context files are ready. They are living documents: keep them up to date as your project evolves.",
      ),
  );
  unpatchPicocolors();
}

main().catch((err) => {
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

  process.exit(1);
});
