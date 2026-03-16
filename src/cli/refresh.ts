import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError, ExitCode } from "../core/errors.js";
import { theme as t } from "../core/theme.js";
import { startShimmer } from "../cli/animations.js";
import { detectContext } from "../core/detect/detect.js";
import { generateSnapshot } from "../core/snapshot/snapshot.js";
import { buildImportGraph, mergeGraph, recomputeScoresAfterMerge } from "../core/graph/build.js";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash } from "../core/config/config.js";
import { fileExists, readFileOr, writeFileSafe } from "../core/utils.js";

/** Known context files in priority order */
const CONTEXT_FILES = [
  ".claude/rules/clarte.md",
  ".cursor/rules/clarte.md",
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".windsurfrules",
  ".clinerules",
  ".continuerules",
  "CONTEXT.md",
];

/** Markdown snapshot markers */
const MD_START = /<!-- CODE SNAPSHOT[^>]*-->/;
const MD_END = /<!-- \/CODE SNAPSHOT -->/;

/**
 * Find the first existing context file in the project root.
 */
async function findContextFile(rootDir: string): Promise<string | null> {
  for (const file of CONTEXT_FILES) {
    const absPath = path.join(rootDir, file);
    if (await fileExists(absPath)) {
      return file;
    }
  }

  return null;
}

/**
 * Refresh the code snapshot section in an existing context file.
 * Auto-detects which file to update.
 */
export async function refreshSnapshot(rootDir: string): Promise<void> {
  // 1. Find context file
  const found = await findContextFile(rootDir);
  if (!found) {
    throw new ClarteError("No context file found. Run clarte first to generate one.", ExitCode.MISSING);
  }

  const absPath = path.join(rootDir, found);
  const content = await readFileOr(absPath);
  if (!content) {
    throw new ClarteError(`Could not read ${found}`, ExitCode.MISSING);
  }

  // 2. Verify snapshot markers exist
  const budgetOmitted = content.includes("Sections omitted") && content.includes("code-snapshot");
  if (!MD_START.test(content) || !MD_END.test(content)) {
    throw new ClarteError(
      budgetOmitted
        ? `Snapshot was omitted from ${found} to fit token budget. Run clarte --full to include it.`
        : `No code snapshot markers found in ${found}. Run clarte to regenerate.`,
      ExitCode.MISSING,
    );
  }

  p.log.info(t.text("Refreshing snapshot in ") + t.accent(found));

  // 3. Detect context and generate new snapshot
  const shimmer = startShimmer("Scanning source files...");
  const detected = await detectContext(rootDir, (msg) => shimmer.message(msg));

  // Build import graph for better snapshot quality
  const graph = await buildImportGraph(rootDir, detected.language, (msg) => shimmer.message(msg));
  if (detected.secondaryLanguages) {
    for (const secLang of detected.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, (msg) => shimmer.message(msg));
      mergeGraph(graph, secGraph);
    }
    recomputeScoresAfterMerge(graph);
  }

  // Load snapshot paths from config if available
  const config = await loadConfig(rootDir);
  const snapshotPaths = config?.snapshotPaths ?? [];

  const snapshot = await generateSnapshot(detected, snapshotPaths, graph, undefined, (msg) => shimmer.message(msg));
  shimmer.stop();
  p.log.step(
    snapshot.entries.length > 0
      ? t.text(
          `Found ${t.textBold(String(snapshot.entries.length))} type${snapshot.entries.length === 1 ? "" : "s"}/signature${snapshot.entries.length === 1 ? "" : "s"}.`,
        )
      : t.text("No extractable types found."),
  );

  if (snapshot.entries.length === 0) {
    p.log.warn(t.text("No types found. Snapshot section will be empty."));
  }

  // 4. Replace the snapshot section (use exec for index-aware matching)
  const startMatch = MD_START.exec(content);
  const endMatch = MD_END.exec(content);
  if (!startMatch || !endMatch) {
    throw new ClarteError("Failed to parse snapshot markers.", ExitCode.PARSE_ERROR);
  }

  const startIdx = startMatch.index;
  const endIdx = endMatch.index + endMatch[0].length;

  let newBlock = "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
  if (snapshot.markdown) {
    newBlock += "\n\n" + snapshot.markdown + "\n";
  }
  newBlock += "\n<!-- /CODE SNAPSHOT -->";

  const updated = content.slice(0, startIdx) + newBlock + content.slice(endIdx);

  // 5. Write back
  await writeFileSafe(absPath, updated);

  // 6. Update config with new snapshot hash + timestamp
  if (config) {
    const answers = configToAnswers(config);
    const newHash = await computeSnapshotHash(rootDir, config.language ?? detected.language);
    await saveConfig(rootDir, answers, newHash, config.language ?? detected.language);
  }

  p.log.success(t.text("Updated snapshot in ") + t.accent(found));
}
