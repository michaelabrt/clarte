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

/**
 * Generate all context files based on detection, user answers, and snapshot.
 * Returns the list of files that were written.
 */
export async function generateFiles(
  ctx: DetectedContext,
  answers: UserAnswers,
  snapshot: CodeSnapshot | null,
  force: boolean = false,
): Promise<GeneratedFile[]> {
  const files: GeneratedFile[] = [];

  // 1. Main context file (CLAUDE.md / AGENTS.md / CONTEXT.md)
  const mainFilename = getMainContextFilename(answers.ide);
  const mainContent = buildMainContext(ctx, answers, snapshot);
  const mainPath = path.join(ctx.rootDir, mainFilename);

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
      // Generate a slim CLAUDE.md that points to AGENTS.md
      files.push({
        path: "CLAUDE.md",
        content: `# ${path.basename(ctx.rootDir)}\n\n> See AGENTS.md for full project context.\n`,
        existed: false,
      });
    }
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
