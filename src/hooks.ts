import path from "node:path";
import fs from "node:fs/promises";
import { fileExists, readFileOr, writeFileSafe } from "./utils.js";

const PRE_COMMIT_CONTENT = `#!/bin/sh
npx clarte --check || {
  npx clarte --refresh-snapshot
  git add CLAUDE.md .cursor/rules/ 2>/dev/null
}
`;
const PRE_COMMIT_MARKER = "clarte";

/**
 * Install a git pre-commit hook that auto-refreshes the context on stale.
 * Detects Husky and Lefthook and prints integration instructions instead
 * of writing directly when those tools are present.
 */
export async function initPreCommitHook(rootDir: string): Promise<void> {
  const gitDir = path.join(rootDir, ".git");
  const gitHooksDir = path.join(gitDir, "hooks");

  // Check if this is a git repo
  if (!(await fileExists(gitDir))) {
    console.error("Not a git repository. Run 'git init' first.");
    process.exit(1);
  }

  // Check for Husky
  const huskyDir = path.join(rootDir, ".husky");
  if (await fileExists(huskyDir)) {
    console.log("Husky detected. Add to your .husky/pre-commit file:");
    console.log("");
    console.log('  npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }');
    return;
  }

  // Check for Lefthook
  const lefthookFiles = ["lefthook.yml", ".lefthook.yml"];
  for (const lf of lefthookFiles) {
    if (await fileExists(path.join(rootDir, lf))) {
      console.log("Lefthook detected. Add to your lefthook.yml:");
      console.log("");
      console.log("  pre-commit:");
      console.log("    commands:");
      console.log("      clarte-refresh:");
      console.log('        run: npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }');
      return;
    }
  }

  // No hook manager detected: write directly to .git/hooks/pre-commit
  const hookPath = path.join(gitHooksDir, "pre-commit");
  const existing = await readFileOr(hookPath);

  if (existing) {
    // Check for duplicates
    if (existing.includes(PRE_COMMIT_MARKER)) {
      console.log("Pre-commit hook already contains clarte. No changes made.");
      return;
    }
    // Append to existing hook
    const snippet = 'npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }';
    const appended = existing.trimEnd() + "\n" + snippet + "\n";
    await writeFileSafe(hookPath, appended);
  } else {
    await writeFileSafe(hookPath, PRE_COMMIT_CONTENT);
  }

  // Make executable
  await fs.chmod(hookPath, 0o755);
  console.log(`Installed pre-commit hook at .git/hooks/pre-commit`);
}
