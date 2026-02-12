import path from "node:path";
import * as p from "@clack/prompts";
import { ClarteError, ExitCode } from "../errors.js";
import { theme as t } from "../theme.js";
import { startShimmer } from "../cli/animations.js";
import { detectContext } from "../detect/detect.js";
import { generateSnapshot } from "../snapshot/snapshot.js";
import { buildImportGraph, mergeGraph } from "../graph/build.js";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash } from "../config/config.js";
import { fileExists, readFileOr, writeFileSafe } from "../utils.js";

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

/** Aider YAML comment markers */
const AIDER_START = /^# --- Code Snapshot/m;
const AIDER_END = /^# --- \/Code Snapshot ---$/m;

/**
 * Find the first existing context file in the project root.
 * Also checks for .aider.conf.yml.
 */
async function findContextFile(rootDir: string): Promise<{ path: string; isAider: boolean } | null> {
  // Check aider first since it has a unique format
  const aiderPath = path.join(rootDir, ".aider.conf.yml");
  if (await fileExists(aiderPath)) {
    const content = await readFileOr(aiderPath);
    if (content && AIDER_START.test(content)) {
      return { path: ".aider.conf.yml", isAider: true };
    }
  }

  // Check markdown context files
  for (const file of CONTEXT_FILES) {
    const absPath = path.join(rootDir, file);
    if (await fileExists(absPath)) {
      return { path: file, isAider: false };
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

  const absPath = path.join(rootDir, found.path);
  const content = await readFileOr(absPath);
  if (!content) {
    throw new ClarteError(`Could not read ${found.path}`, ExitCode.MISSING);
  }

  // 2. Verify snapshot markers exist
  const budgetOmitted = content.includes("Sections omitted") && content.includes("code-snapshot");
  if (found.isAider) {
    if (!AIDER_START.test(content) || !AIDER_END.test(content)) {
      throw new ClarteError(
        budgetOmitted
          ? `Snapshot was omitted from ${found.path} to fit token budget. Run clarte --full to include it.`
          : `No code snapshot markers found in ${found.path}. Run clarte to regenerate.`,
        ExitCode.MISSING,
      );
    }
  } else {
    if (!MD_START.test(content) || !MD_END.test(content)) {
      throw new ClarteError(
        budgetOmitted
          ? `Snapshot was omitted from ${found.path} to fit token budget. Run clarte --full to include it.`
          : `No code snapshot markers found in ${found.path}. Run clarte to regenerate.`,
        ExitCode.MISSING,
      );
    }
  }

  p.log.info(t.text("Refreshing snapshot in ") + t.accent(found.path));

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

  // 4. Replace the snapshot section
  let updated: string;

  if (found.isAider) {
    // Replace YAML comment block
    const startMatch = content.match(AIDER_START);
    const endMatch = content.match(AIDER_END);
    if (!startMatch || !endMatch) {
      throw new ClarteError("Failed to parse snapshot markers.", ExitCode.PARSE_ERROR);
    }

    const startIdx = content.indexOf(startMatch[0]);
    const endIdx = content.indexOf(endMatch[0]) + endMatch[0].length;

    let newBlock = "# --- Code Snapshot (for reference) ---";
    if (snapshot.markdown) {
      for (const line of snapshot.markdown.split("\n")) {
        newBlock += `\n# ${line}`;
      }
    }
    newBlock += "\n# --- /Code Snapshot ---";

    updated = content.slice(0, startIdx) + newBlock + content.slice(endIdx);
  } else {
    // Replace markdown block
    const startMatch = content.match(MD_START);
    const endMatch = content.match(MD_END);
    if (!startMatch || !endMatch) {
      throw new ClarteError("Failed to parse snapshot markers.", ExitCode.PARSE_ERROR);
    }

    const startIdx = content.indexOf(startMatch[0]);
    const endIdx = content.indexOf(endMatch[0]) + endMatch[0].length;

    let newBlock = "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
    if (snapshot.markdown) {
      newBlock += "\n\n" + snapshot.markdown + "\n";
    }
    newBlock += "\n<!-- /CODE SNAPSHOT -->";

    updated = content.slice(0, startIdx) + newBlock + content.slice(endIdx);
  }

  // 5. Write back
  await writeFileSafe(absPath, updated);

  // 6. Update config with new snapshot hash + timestamp
  if (config) {
    const answers = configToAnswers(config);
    const newHash = await computeSnapshotHash(rootDir, config.language ?? detected.language);
    await saveConfig(rootDir, answers, newHash, config.language ?? detected.language);
  }

  p.log.success(t.text("Updated snapshot in ") + t.accent(found.path));
}
