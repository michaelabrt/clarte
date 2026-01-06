import { execFileSync } from "node:child_process";
import { detectContext, enrichFrameworksWithUsage } from "../detect/detect.js";
import { buildGraphWithCache } from "../graph/cache.js";
import { buildImportGraph, mergeGraph } from "../graph/build.js";
import { runAnalysis } from "../core/run-analysis.js";
import { loadConfig } from "../config/config.js";
import { analyzeForCI, type CIAnalysisResult } from "../analysis/ci.js";
import type { ProgressCallback } from "../types.js";

/**
 * Run CI analysis on changed files and output structured JSON.
 *
 * Changed files can be provided explicitly or computed from git diff.
 */
export async function runCiMode(
  rootDir: string,
  changedFiles: string[] | null,
  base: string | undefined,
  verbose: boolean,
): Promise<CIAnalysisResult> {
  const noopProgress: ProgressCallback = () => {};
  const verboseLog: ProgressCallback = verbose ? (msg) => process.stderr.write(`[ci] ${msg}\n`) : noopProgress;

  // Resolve changed files from git if not provided
  let files: string[];
  if (changedFiles && changedFiles.length > 0) {
    files = changedFiles;
  } else {
    const ref = base ?? "HEAD";
    try {
      const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", ref], {
        cwd: rootDir,
        encoding: "utf-8",
        timeout: 30_000,
      }).trim();
      files = output ? output.split("\n").filter(Boolean) : [];
    } catch {
      // Fallback: try uncommitted changes
      try {
        const output = execFileSync("git", ["diff", "--name-only", "--diff-filter=ACMR", "HEAD"], {
          cwd: rootDir,
          encoding: "utf-8",
          timeout: 30_000,
        }).trim();
        files = output ? output.split("\n").filter(Boolean) : [];
      } catch {
        files = [];
      }
    }
  }

  if (files.length === 0) {
    return {
      version: 2 as const,
      timestamp: new Date().toISOString(),
      filesAnalyzed: 0,
      missingCoChanges: [],
      chokepoints: [],
      crossCutting: [],
      flowBottlenecks: [],
      tightCouplings: [],
      hasFindings: false,
    };
  }

  verboseLog(`Analyzing ${files.length} changed files`);

  // Run the full analysis pipeline (reuses caching)
  const savedConfig = await loadConfig(rootDir);
  const detected = await detectContext(rootDir, verbose ? verboseLog : undefined);

  const graph = await buildGraphWithCache(rootDir, detected.language, verbose ? verboseLog : undefined);
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, verbose ? verboseLog : undefined);
      mergeGraph(graph, secGraph);
    }
  }
  detected.frameworks = enrichFrameworksWithUsage(detected.frameworks, graph.externalImportCounts);

  const { analysis } = await runAnalysis(
    rootDir,
    graph,
    detected,
    savedConfig,
    verbose,
    true, // jsonMode — suppress CLI output
    verboseLog,
    noopProgress,
  );

  // Filter to only files that exist in the graph (source files, not config/docs)
  const sourceFiles = files.filter((f) => graph.centrality.has(f) || graph.inDegree.has(f));
  const nonSourceFiles = files.filter((f) => !graph.centrality.has(f) && !graph.inDegree.has(f));

  if (verbose && nonSourceFiles.length > 0) {
    verboseLog(`Skipping ${nonSourceFiles.length} non-source files: ${nonSourceFiles.slice(0, 5).join(", ")}`);
  }

  return analyzeForCI(rootDir, sourceFiles, analysis, graph);
}
