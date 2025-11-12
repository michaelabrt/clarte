import path from "node:path";
import fs from "node:fs/promises";
import { fileExists, readFileOr, writeFileSafe } from "./utils.js";

const HOOK_COMMAND = "npx clarte print";
const HOOK_MARKER = "clarte";

/** Legacy format (pre-2026) */
interface LegacyHookEntry {
  type: string;
  command: string;
}

/** New format with matchers */
interface MatcherHookEntry {
  matcher?: string;
  hooks: LegacyHookEntry[];
}

type HookEntry = LegacyHookEntry | MatcherHookEntry;

interface ClaudeSettings {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
}

function isMatcherEntry(h: HookEntry): h is MatcherHookEntry {
  return "hooks" in h && Array.isArray((h as MatcherHookEntry).hooks);
}

/** Check whether any hook entry contains a command matching the marker */
function hasHookCommand(entries: HookEntry[], marker: string): boolean {
  return entries.some((h) => {
    if (isMatcherEntry(h)) {
      return h.hooks.some((inner) => inner.command?.includes(marker));
    }
    return (h as LegacyHookEntry).command?.includes(marker);
  });
}

/** Remove hook entries containing a command matching the marker */
function filterHookCommands(entries: HookEntry[], marker: string): HookEntry[] {
  return entries.filter((h) => {
    if (isMatcherEntry(h)) {
      return !h.hooks.some((inner) => inner.command?.includes(marker));
    }
    return !(h as LegacyHookEntry).command?.includes(marker);
  });
}

function getSettingsPath(): string {
  const homeDir = process.env.HOME ?? process.env.USERPROFILE ?? "";
  return path.join(homeDir, ".claude", "settings.json");
}

/**
 * Install clarte hooks into ~/.claude/settings.json.
 * Adds SessionStart and PreCompact hooks that run `clarte print`.
 * Preserves existing hooks (appends, does not replace).
 */
export async function installHooks(): Promise<void> {
  const settingsPath = getSettingsPath();
  const content = await readFileOr(settingsPath);

  let settings: ClaudeSettings = {};
  if (content) {
    try {
      settings = JSON.parse(content);
    } catch {
      console.error(`Could not parse ${settingsPath}. Fix the JSON and try again.`);
      process.exit(1);
    }
  }

  if (!settings.hooks) {
    settings.hooks = {};
  }

  const hookTypes = ["SessionStart", "PreCompact"];
  let addedCount = 0;

  for (const hookType of hookTypes) {
    if (!settings.hooks[hookType]) {
      settings.hooks[hookType] = [];
    }

    const existing = settings.hooks[hookType];
    const alreadyInstalled = hasHookCommand(existing, HOOK_MARKER);

    if (!alreadyInstalled) {
      existing.push({
        hooks: [{ type: "command", command: HOOK_COMMAND }],
      });
      addedCount++;
    }
  }

  await writeFileSafe(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  if (addedCount === 0) {
    console.log("Clarte hooks are already installed.");
  } else {
    console.log(`Installed ${addedCount} hook${addedCount === 1 ? "" : "s"} in ${settingsPath}`);
    console.log("");
    console.log("  SessionStart: runs 'clarte print' when a new session starts");
    console.log("  PreCompact:   runs 'clarte print' before context compaction");
    console.log("");
    console.log("Run 'clarte hooks uninstall' to remove.");
  }
}

/**
 * Remove clarte-related hooks from ~/.claude/settings.json.
 * Only removes entries whose command includes "clarte".
 */
export async function uninstallHooks(): Promise<void> {
  const settingsPath = getSettingsPath();
  const content = await readFileOr(settingsPath);

  if (!content) {
    console.log("No settings file found. Nothing to uninstall.");
    return;
  }

  let settings: ClaudeSettings;
  try {
    settings = JSON.parse(content);
  } catch {
    console.error(`Could not parse ${settingsPath}. Fix the JSON and try again.`);
    process.exit(1);
  }

  if (!settings.hooks) {
    console.log("No hooks configured. Nothing to uninstall.");
    return;
  }

  let removedCount = 0;

  for (const [hookType, entries] of Object.entries(settings.hooks)) {
    const filtered = filterHookCommands(entries, HOOK_MARKER);
    removedCount += entries.length - filtered.length;
    if (filtered.length === 0) {
      delete settings.hooks[hookType];
    } else {
      settings.hooks[hookType] = filtered;
    }
  }

  // Clean up empty hooks object
  if (Object.keys(settings.hooks).length === 0) {
    delete settings.hooks;
  }

  await writeFileSafe(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  if (removedCount === 0) {
    console.log("No clarte hooks found. Nothing to uninstall.");
  } else {
    console.log(`Removed ${removedCount} clarte hook${removedCount === 1 ? "" : "s"} from ${settingsPath}.`);
  }
}

const PRE_COMMIT_CHECK_CONTENT = "#!/bin/sh\nnpx clarte --check\n";
const PRE_COMMIT_AUTO_REFRESH_CONTENT = `#!/bin/sh
npx clarte --check || {
  npx clarte --refresh-snapshot
  git add CLAUDE.md .cursor/rules/ 2>/dev/null
}
`;
const PRE_COMMIT_MARKER = "clarte";

/**
 * Install a git pre-commit hook that runs `clarte --check`.
 * When autoRefresh is true, the hook auto-regenerates on stale and stages the result.
 * Detects Husky and Lefthook and prints integration instructions instead
 * of writing directly when those tools are present.
 */
export async function initPreCommitHook(rootDir: string, autoRefresh = false): Promise<void> {
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
    if (autoRefresh) {
      console.log("Husky detected. Add to your .husky/pre-commit file:");
      console.log("");
      console.log('  npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }');
    } else {
      console.log("Husky detected. Add clarte to your pre-commit hook:");
      console.log("");
      console.log('  npx husky add .husky/pre-commit "npx clarte --check"');
      console.log("");
      console.log("Or add to your existing .husky/pre-commit file:");
      console.log("  npx clarte --check");
    }
    return;
  }

  // Check for Lefthook
  const lefthookFiles = ["lefthook.yml", ".lefthook.yml"];
  for (const lf of lefthookFiles) {
    if (await fileExists(path.join(rootDir, lf))) {
      if (autoRefresh) {
        console.log("Lefthook detected. Add to your lefthook.yml:");
        console.log("");
        console.log("  pre-commit:");
        console.log("    commands:");
        console.log("      clarte-refresh:");
        console.log('        run: npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }');
      } else {
        console.log("Lefthook detected. Add to your lefthook.yml:");
        console.log("");
        console.log("  pre-commit:");
        console.log("    commands:");
        console.log("      clarte-check:");
        console.log("        run: npx clarte --check");
      }
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
    if (autoRefresh) {
      const snippet = 'npx clarte --check || { npx clarte --refresh-snapshot && git add CLAUDE.md .cursor/rules/ 2>/dev/null; }';
      const appended = existing.trimEnd() + "\n" + snippet + "\n";
      await writeFileSafe(hookPath, appended);
    } else {
      const appended = existing.trimEnd() + "\nnpx clarte --check\n";
      await writeFileSafe(hookPath, appended);
    }
  } else {
    const content = autoRefresh ? PRE_COMMIT_AUTO_REFRESH_CONTENT : PRE_COMMIT_CHECK_CONTENT;
    await writeFileSafe(hookPath, content);
  }

  // Make executable
  await fs.chmod(hookPath, 0o755);
  console.log(`Installed pre-commit hook at .git/hooks/pre-commit`);
}
