import path from "node:path";
import * as p from "@clack/prompts";
import type {
  CodeSnapshot,
  ContextAnalysis,
  DetectedContext,
  GeneratedFile,
  IDETarget,
  ProgressCallback,
  UserAnswers,
} from "./types.js";
import { fileExists, readJsonFile, writeFileSafe } from "./utils.js";
import {
  buildMainContext,
  getMainContextFilename,
} from "./templates/main-context.js";
import {
  buildCursorRules,
  renderCursorRule,
} from "./templates/cursor-rules.js";
import {
  buildClaudeSkills,
  renderClaudeSkill,
} from "./templates/claude-skills.js";
import { buildAiderContext } from "./templates/aider-context.js";
import { detectContext } from "./detect.js";
import { generateSnapshot } from "./snapshot.js";

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
  analysis?: ContextAnalysis,
  generateSkills: boolean = false,
  onVerbose?: ProgressCallback,
): Promise<GeneratedFile[]> {
  // Deduplicate files by path (e.g. claude + cursor both produce CLAUDE.md)
  const fileMap = new Map<string, GeneratedFile>();

  async function addFile(filePath: string, content: string) {
    if (fileMap.has(filePath)) return;
    const absPath = path.join(ctx.rootDir, filePath);
    fileMap.set(filePath, {
      path: filePath,
      content,
      existed: await fileExists(absPath),
    });
    onVerbose?.(`Prepared ${filePath} (${content.length} bytes)`);
  }

  // Generate files for each selected IDE
  for (const ide of answers.ides) {
    // 1. Main context file
    const mainFilename = getMainContextFilename(ide);
    const mainContent =
      ide === "aider"
        ? buildAiderContext(ctx, answers, snapshot, analysis)
        : buildMainContext(ctx, answers, snapshot, analysis);
    await addFile(mainFilename, mainContent);

    // 2. Cursor-specific scoped rules
    if (ide === "cursor") {
      const rules = buildCursorRules(ctx, answers, analysis);
      for (const rule of rules) {
        const rulePath = `.cursor/rules/${rule.filename}`;
        const ruleContent = renderCursorRule(rule);
        await addFile(rulePath, ruleContent);
      }
    }

    // 3. Claude Code skills
    if (generateSkills && ide === "claude") {
      const pkgJson = await readJsonFile(path.join(ctx.rootDir, "package.json"));
      const scripts = (pkgJson?.scripts as Record<string, string>) ?? undefined;
      const skills = buildClaudeSkills(ctx, answers, analysis, scripts);
      for (const skill of skills) {
        const skillPath = `.claude/skills/${skill.name}/SKILL.md`;
        const skillContent = renderClaudeSkill(skill);
        await addFile(skillPath, skillContent);
      }
    }

    // 4. For OpenCode, also generate CLAUDE.md as fallback if main file is AGENTS.md
    if (ide === "opencode") {
      const claudePath = path.join(ctx.rootDir, "CLAUDE.md");
      const claudeExists = await fileExists(claudePath);
      if (!claudeExists && !fileMap.has("CLAUDE.md")) {
        await addFile("CLAUDE.md", `# ${path.basename(ctx.rootDir)}\n\n> See AGENTS.md for full project context.\n`);
      }
    }
  }

  // Monorepo per-package context files
  if (
    answers.generatePerPackage &&
    ctx.monorepo &&
    ctx.monorepo.packages.length > 0
  ) {
    for (const pkg of ctx.monorepo.packages) {
      const pkgRootDir = path.join(ctx.rootDir, pkg.path);

      // Detect context for this specific package
      const pkgCtx = await detectContext(pkgRootDir);

      // Generate snapshot scoped to this package
      let pkgSnapshot: CodeSnapshot | null = null;
      if (answers.generateSnapshot) {
        pkgSnapshot = await generateSnapshot(pkgCtx, []);
        if (pkgSnapshot.entries.length === 0) pkgSnapshot = null;
      }

      // Build scoped answers for this package
      const pkgAnswers: UserAnswers = {
        ...answers,
        projectPurpose: `${pkg.name}, part of the ${path.basename(ctx.rootDir)} monorepo. ${answers.projectPurpose}`,
        generatePerPackage: false, // don't recurse
      };

      for (const ide of answers.ides) {
        const pkgMainFilename =
          ide === "aider" ? ".aider.conf.yml" : getMainContextFilename(ide);

        const pkgContent =
          ide === "aider"
            ? buildAiderContext(pkgCtx, pkgAnswers, pkgSnapshot)
            : buildMainContext(pkgCtx, pkgAnswers, pkgSnapshot);

        const pkgFilePath = path.join(pkg.path, pkgMainFilename);
        await addFile(pkgFilePath, pkgContent);
      }
    }
  }

  const files = Array.from(fileMap.values());

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
    onVerbose?.(`Wrote ${file.path}`);
  }

  return files;
}
