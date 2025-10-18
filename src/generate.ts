import path from "node:path";
import * as p from "@clack/prompts";
import { theme as t } from "./theme.js";
import type {
  CodeSnapshot,
  ContextAnalysis,
  DetectedContext,
  GeneratedFile,
  IDETarget,
  ProgressCallback,
  UserAnswers,
} from "./types.js";
import { fileExists, readFileOr, readJsonFile, writeFileSafe } from "./utils.js";
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
  budget?: number,
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
        ? await buildAiderContext(ctx, answers, snapshot, analysis)
        : await buildMainContext(ctx, answers, snapshot, analysis, budget);
    await addFile(mainFilename, mainContent);

    // 2. Cursor-specific scoped rules
    if (ide === "cursor") {
      const rules = await buildCursorRules(ctx, answers, analysis);
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
      const skills = await buildClaudeSkills(ctx, answers, analysis, scripts);
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
            ? await buildAiderContext(pkgCtx, pkgAnswers, pkgSnapshot)
            : await buildMainContext(pkgCtx, pkgAnswers, pkgSnapshot);

        const pkgFilePath = path.join(pkg.path, pkgMainFilename);
        await addFile(pkgFilePath, pkgContent);
      }
    }
  }

  const files = Array.from(fileMap.values());

  // Preserve user sections from existing files before overwriting
  let preservedCount = 0;
  for (const file of files) {
    if (!file.existed) continue;
    // Only preserve in markdown-based context files (not YAML, not skills)
    if (!file.path.endsWith(".md") && !file.path.startsWith(".windsurfrules") && !file.path.startsWith(".clinerules") && !file.path.startsWith(".continuerules")) continue;

    const absPath = path.join(ctx.rootDir, file.path);
    const existingContent = await readFileOr(absPath);
    if (!existingContent) continue;

    const userSections = extractUserSections(existingContent);
    if (userSections.length > 0) {
      file.content = mergeUserSections(file.content, userSections);
      preservedCount += userSections.length;
      onVerbose?.(`Preserved ${userSections.length} user section(s) in ${file.path}`);
    }
  }

  if (preservedCount > 0) {
    p.log.info(
      t.text(`Preserved ${t.textBold(String(preservedCount))} custom section${preservedCount === 1 ? "" : "s"} (clarte:user markers)`),
    );
  }

  // Dry run: return files without writing anything
  if (dryRun) {
    return files;
  }

  // Check for existing files and ask before overwriting
  const existingFiles = files.filter((f) => f.existed);
  if (existingFiles.length > 0 && !force) {
    p.log.warn(
      t.warn("The following files already exist:") + "\n" +
        existingFiles.map((f) => t.text(`  - ${f.path}`)).join("\n"),
    );

    const overwrite = await p.confirm({
      message: t.text("Overwrite existing files?"),
      active: t.soft("Yes"),
      inactive: t.soft("No"),
    });

    if (p.isCancel(overwrite) || !overwrite) {
      // Only write new files
      const newFiles = files.filter((f) => !f.existed);
      if (newFiles.length === 0) {
        p.log.info(t.text("No new files to write. Exiting."));
        return [];
      }
      p.log.info(t.text(`Writing ${newFiles.length} new file(s), skipping existing.`));
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

// ── User section preservation ────────────────────────────────────────────────

const USER_START = "<!-- clarte:user-start -->";
const USER_END = "<!-- clarte:user-end -->";

interface UserSection {
  /** Full content including markers */
  content: string;
  /** The nearest preceding ## header (anchor for repositioning) */
  anchor: string | null;
}

/**
 * Extract user-preserved sections from existing file content.
 * Each section is delimited by <!-- clarte:user-start --> and <!-- clarte:user-end -->.
 */
export function extractUserSections(content: string): UserSection[] {
  const sections: UserSection[] = [];
  let searchFrom = 0;

  while (searchFrom < content.length) {
    const startIdx = content.indexOf(USER_START, searchFrom);
    if (startIdx < 0) break;

    const endIdx = content.indexOf(USER_END, startIdx + USER_START.length);
    if (endIdx < 0) break; // Unclosed marker — skip

    const fullBlock = content.slice(startIdx, endIdx + USER_END.length);

    // Find nearest preceding ## header as position anchor
    const before = content.slice(0, startIdx);
    const headers = before.match(/^## .+$/gm);
    const anchor = headers ? headers[headers.length - 1] : null;

    sections.push({ content: fullBlock, anchor });
    searchFrom = endIdx + USER_END.length;
  }

  return sections;
}

/**
 * Merge preserved user sections into newly generated content.
 * Each section is re-inserted after its anchor header (nearest preceding ## header
 * from the original file). If the anchor is not found, the section is appended at the end.
 */
export function mergeUserSections(newContent: string, userSections: UserSection[]): string {
  if (userSections.length === 0) return newContent;

  let result = newContent;

  for (const section of userSections) {
    // Skip if this exact user block is somehow already in the new content
    if (result.includes(section.content)) continue;

    if (section.anchor) {
      // Find the anchor header in the new content
      const anchorIdx = result.indexOf(section.anchor);
      if (anchorIdx >= 0) {
        // Find the start of the next ## header after the anchor
        const afterAnchor = anchorIdx + section.anchor.length;
        const nextHeaderIdx = result.indexOf("\n## ", afterAnchor);

        if (nextHeaderIdx >= 0) {
          // Insert before the next header
          const before = result.slice(0, nextHeaderIdx);
          const after = result.slice(nextHeaderIdx);
          result = before.trimEnd() + "\n\n" + section.content + "\n" + after;
        } else {
          // No next header — insert before the final newline
          result = result.trimEnd() + "\n\n" + section.content + "\n";
        }
        continue;
      }
    }

    // No anchor found: append at end
    result = result.trimEnd() + "\n\n" + section.content + "\n";
  }

  return result;
}
