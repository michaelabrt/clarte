import path from "node:path";
import * as p from "@clack/prompts";
import type {
  CodeSnapshot,
  DetectedContext,
  GeneratedFile,
  UserAnswers,
} from "./types.js";
import { fileExists, writeFileSafe, readFileOr } from "./utils.js";
import {
  buildMainContext,
  getMainContextFilename,
} from "./templates/main-context.js";
import {
  buildCursorRules,
  renderCursorRule,
} from "./templates/cursor-rules.js";
import { buildAiderContext } from "./templates/aider-context.js";

/**
 * Generate all context files based on detection, user answers, and snapshot.
 * Returns the list of files that were generated.
 * When dryRun is true, no files are written to disk.
 */
export async function generateFiles(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  force: boolean = false,
  dryRun: boolean = false,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];

  // 1. Main context file
  const mainFilename = getMainContextFilename(answers.ide);
  const mainPath = path.join(ctx.rootDir, mainFilename);

  // Aider uses YAML format, everything else uses markdown
  const mainContent =
    answers.ide === "aider"
      ? buildAiderContext(ctx, answers, snapshot)
      : buildMainContext(ctx, answers, snapshot);

  files.push({
    path: mainFilename,
    content: mainContent,
    existed: await fileExists(mainPath),
  });

  // 2. Cursor-specific scoped rules
  if (answers.ide === "cursor") {
    const rules = buildCursorRules(ctx, answers);
    for (const rule of rules) {
      const rulePath = `.cursor/rules/${rule.filename}`;
      const absPath = path.join(ctx.rootDir, rulePath);
      files.push({
        path: rulePath,
        content: renderCursorRule(rule),
        existed: await fileExists(absPath),
      });
    }
  }

  // 3. For OpenCode, also generate CLAUDE.md as fallback if main file is AGENTS.md
  if (answers.ide === "opencode") {
    const claudePath = path.join(ctx.rootDir, "CLAUDE.md");
    const claudeExists = await fileExists(claudePath);
    if (!claudeExists) {
      files.push({
        path: "CLAUDE.md",
        content: `# ${path.basename(ctx.rootDir)}\n\n> See AGENTS.md for full project context.\n`,
        existed: false,
      });
    }
  }

  // Dry run: return files without writing anything
  if (dryRun) {
    return files;
  }

  // Check for existing files and ask before overwriting
  const existingFiles = files.filter((f) => f.existed);
  if (existingFiles.length > 0 && !force) {
    p.log.warn(
      `The following files already exist:\n${existingFiles.map((f) => `  - ${f.path}`).join("\n")}`,
    );

    const overwrite = await p.confirm({
      message: "Overwrite existing files?",
    });

    if (p.isCancel(overwrite) || !overwrite) {
      // Only write new files
      const newFiles = files.filter((f) => !f.existed);
      if (newFiles.length === 0) {
        p.log.info("No new files to write. Exiting.");
        return [];
      }
      p.log.info(`Writing ${newFiles.length} new file(s), skipping existing.`);
      for (const file of newFiles) {
        await writeFileSafe(path.join(ctx.rootDir, file.path), file.content);
      }
      return newFiles;
    }
  }

  // Write all files
  for (const file of files) {
    await writeFileSafe(path.join(ctx.rootDir, file.path), file.content);
  }

  return files;
}
