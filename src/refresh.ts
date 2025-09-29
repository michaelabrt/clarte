import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t } from "./theme.js";
import { detectContext } from "./detect.js";
import { generateSnapshot } from "./snapshot.js";
import { buildImportGraph } from "./graph.js";
import { loadConfig, saveConfig, configToAnswers, computeSnapshotHash } from "./config.js";
import { fileExists, readFileOr, writeFileSafe } from "./utils.js";
import type { ProgressCallback } from "./types.js";

/** Known context files in priority order */
const CONTEXT_FILES = [
  "CLAUDE.md",
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
async function findContextFile(
  rootDir: string,
): Promise<{ path: string; isAider: boolean } | null> {
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
  const spinner = p.spinner();

  // 1. Find context file
  const found = await findContextFile(rootDir);
  if (!found) {
    p.log.error(
      t.text("No context file found. Run ") +
        t.accent("clarte") +
        t.text(" first to generate one."),
    );
    process.exit(1);
  }

  const absPath = path.join(rootDir, found.path);
  const content = await readFileOr(absPath);
  if (!content) {
    p.log.error(t.text(`Could not read ${found.path}`));
    process.exit(1);
  }

  // 2. Verify snapshot markers exist
  if (found.isAider) {
    if (!AIDER_START.test(content) || !AIDER_END.test(content)) {
      p.log.error(
        t.text(`No code snapshot markers found in ${found.path}. Re-generate the file with code snapshot enabled.`),
      );
      process.exit(1);
    }
  } else {
    if (!MD_START.test(content) || !MD_END.test(content)) {
      p.log.error(
        t.text(`No code snapshot markers found in ${found.path}. Re-generate the file with code snapshot enabled.`),
      );
      process.exit(1);
    }
  }

  p.log.info(t.text("Refreshing snapshot in ") + t.accent(found.path));

  // 3. Detect context and generate new snapshot
  spinner.start("Scanning source files...");
  const progress: ProgressCallback = (msg) => spinner.message(msg);
  const detected = await detectContext(rootDir, progress);

  // Build import graph for better snapshot quality
  const graph = await buildImportGraph(rootDir, detected.language, progress);

  // Load snapshot paths from config if available
  const config = await loadConfig(rootDir);
  const snapshotPaths = config?.snapshotPaths ?? [];

  const snapshot = await generateSnapshot(detected, snapshotPaths, graph, undefined, progress);
  spinner.stop(
    snapshot.entries.length > 0
      ? `Found ${snapshot.entries.length} type${snapshot.entries.length === 1 ? "" : "s"}/signature${snapshot.entries.length === 1 ? "" : "s"}.`
      : "No extractable types found.",
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
      p.log.error(t.text("Failed to parse snapshot markers."));
      process.exit(1);
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
      p.log.error(t.text("Failed to parse snapshot markers."));
      process.exit(1);
    }

    const startIdx = content.indexOf(startMatch[0]);
    const endIdx = content.indexOf(endMatch[0]) + endMatch[0].length;

    let newBlock =
      "<!-- CODE SNAPSHOT (auto-generated, update when types/stores/services change) -->";
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
