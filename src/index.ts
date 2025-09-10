import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
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
  const args = process.argv.slice(2);
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");
  const refresh = args.includes("--refresh-snapshot");
  const reconfigure = args.includes("--reconfigure");
  const check = args.includes("--check");
  const generateSkills = args.includes("--generate-skills");
  const maxTokensArg = args.find((a) => a.startsWith("--max-tokens="));
  const maxTokens = maxTokensArg ? parseInt(maxTokensArg.split("=")[1], 10) : undefined;
  const targetDir = args.find((a) => !a.startsWith("-")) ?? process.cwd();
  const rootDir = path.resolve(targetDir);

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
      console.log(`context-pilot: snapshot is stale${staleMsg}. Run npx context-pilot --refresh-snapshot`);
      process.exit(1);
    }
    process.exit(0);
  }

  console.log("");
  p.intro(pc.bold(" context-pilot "));

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
  spinner.start("Building import graph...");
  const graph = await buildImportGraph(rootDir, detected.language, spinnerProgress);
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

  // Discovery log
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
    if (detected.sourceFileCount > 0) {
      lines.push(`  Files:      ${detected.sourceFileCount} (${formatBytes(detected.totalSourceBytes)})`);
    }
    if (lines.length > 0) {
      p.note(lines.join("\n"), "Detected Stack");
    }
  }

  // Step 1.7: Structural analysis
  spinner.start("Analyzing project structure...");
  const hubFiles = getHubFiles(graph);
  const circularDeps = findCircularDeps(graph);
  const layers = detectArchitecturalLayers(graph);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const exportCoverage = computeExportCoverage(graph);
  const gitActivity = detected.isGitRepo ? analyzeGitActivity(rootDir, spinnerProgress) : null;

  const analysis: ContextAnalysis = { hubFiles, circularDeps, layers, gitActivity, instabilities, communities, exportCoverage };

  const analysisParts: string[] = [];
  if (hubFiles.length > 0) analysisParts.push(`${hubFiles.length} hub files`);
  if (layers.length > 0) analysisParts.push(`${layers.length} layers`);
  if (circularDeps.length > 0) analysisParts.push(`${circularDeps.length} circular dep${circularDeps.length === 1 ? "" : "s"}`);
  if (communities.length > 0) analysisParts.push(`${communities.length} module cluster${communities.length === 1 ? "" : "s"}`);
  if (gitActivity) analysisParts.push(`${gitActivity.hotFiles.length} active files`);
  spinner.stop(
    analysisParts.length > 0
      ? `Analysis: ${analysisParts.join(", ")}.`
      : "Analysis complete.",
  );

  // Step 1.7: Check for saved config + staleness
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
      `Using saved config from ${pc.cyan(".context-pilot.json")} ` +
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
        pc.dim("Saved config to .context-pilot.json for future runs."),
      );
    }
  }

  // Step 3: Code snapshot (if requested)
  let snapshot = null;
  if (answers.generateSnapshot) {
    spinner.start("Scanning source files for code snapshot...");
    snapshot = await generateSnapshot(detected, answers.snapshotPaths, graph, maxTokens, spinnerProgress, gitActivity);
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
  const files = await generateFiles(detected, answers, snapshot, force, dryRun, analysis, shouldGenerateSkills);
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

  if (dryRun) {
    p.outro(
      pc.yellow("DRY RUN complete — ") +
        pc.dim("no files were written. Remove --dry-run to generate."),
    );
    return;
  }

  // Step 6: Done!
  p.outro(
    pc.green("Done! ") +
      pc.dim(
        "Your context files are ready. They are living documents — keep them up to date as your project evolves.",
      ),
  );
}

function getToolCommand(ide: string): string | null {
  switch (ide) {
    case "claude":
      return "claude";
    case "cursor":
      return "cursor .";
    case "opencode":
      return "opencode";
    case "windsurf":
      return "windsurf .";
    case "aider":
      return "aider";
    default:
      return null;
  }
}

function getToolName(ide: string): string {
  switch (ide) {
    case "claude":
      return "Claude Code";
    case "cursor":
      return "Cursor";
    case "opencode":
      return "OpenCode";
    case "copilot":
      return "GitHub Copilot";
    case "windsurf":
      return "Windsurf";
    case "cline":
      return "Cline";
    case "continue":
      return "Continue.dev";
    case "aider":
      return "Aider";
    default:
      return ide;
  }
}

main().catch((err) => {
  console.error(pc.red("Fatal error:"), err);
  process.exit(1);
});
