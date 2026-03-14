import { describe, it, expect } from "vitest";

import { configureClaudeHooks } from "../hooks/generate-hooks.js";
import { readJsonFile, writeFileSafe } from "../utils.js";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

interface HookEntry {
  type: string;
  command: string;
}

interface MatchedHookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: Record<string, MatchedHookGroup[]>;
  [key: string]: unknown;
}

function makeTempRoot(): string {
  const dir = path.join(tmpdir(), `clarte-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  return dir;
}

describe("configureClaudeHooks", () => {
  it("registers a PostToolUse entry for the edit tracker", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    const postHooks = settings?.hooks?.PostToolUse;
    if (!postHooks || !Array.isArray(postHooks)) throw new Error("expected PostToolUse hooks array");

    const editTrackerEntry = postHooks.find((group) =>
      group.hooks?.some((h) => h.command?.includes("on-edit-tracker.mjs")),
    );
    expect(editTrackerEntry).toBeDefined();
  });

  it("registers all expected hook events", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    const registeredEvents = Object.keys(settings?.hooks ?? {});

    expect(registeredEvents).toContain("SessionStart");
    expect(registeredEvents).toContain("PreToolUse");
    expect(registeredEvents).toContain("PostToolUse");
    expect(registeredEvents).toContain("SubagentStart");
    expect(registeredEvents).toContain("UserPromptSubmit");
  });

  it("registers the correct number of hooks per event", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    // SessionStart: on-session-start.mjs (1 hook)
    expect(settings.hooks?.SessionStart).toHaveLength(1);
    // PreToolUse: on-fail-fast.mjs + on-pre-flight-limit.mjs (2 hooks)
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
    // PostToolUse: on-edit-tracker.mjs (1 hook)
    expect(settings.hooks?.PostToolUse).toHaveLength(1);
    // SubagentStart: on-pre-flight-start.mjs with matcher (1 hook)
    expect(settings.hooks?.SubagentStart).toHaveLength(1);
    // UserPromptSubmit: on-prompt.mjs (1 hook)
    expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it("sets matcher on SubagentStart hook for clarte-pre-flight", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    const subagentHooks = settings.hooks?.SubagentStart;
    if (!subagentHooks) throw new Error("expected SubagentStart hooks");
    expect(subagentHooks).toHaveLength(1);
    expect(subagentHooks[0].matcher).toBe("clarte-pre-flight");
  });

  it("does not remove existing non-clarte hooks", async () => {
    const rootDir = makeTempRoot();
    const settingsPath = path.join(rootDir, ".claude/settings.json");

    const initial: ClaudeSettings = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "node my-custom-hook.mjs" }] }],
        PreToolUse: [{ hooks: [{ type: "command", command: "node user-lint-hook.mjs" }] }],
      },
    };
    await writeFileSafe(settingsPath, JSON.stringify(initial, null, 2) + "\n");

    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(settingsPath)) as ClaudeSettings;
    const userPostHook = settings?.hooks?.PostToolUse?.find((group) =>
      group.hooks?.some((h) => h.command === "node my-custom-hook.mjs"),
    );
    expect(userPostHook).toBeDefined();

    const userPreHook = settings?.hooks?.PreToolUse?.find((group) =>
      group.hooks?.some((h) => h.command === "node user-lint-hook.mjs"),
    );
    expect(userPreHook).toBeDefined();
  });

  it("is idempotent - calling twice does not duplicate hooks", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;

    // Each event should have only the clarte hooks, not doubled
    expect(settings.hooks?.SessionStart).toHaveLength(1);
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
    expect(settings.hooks?.PostToolUse).toHaveLength(1);
    expect(settings.hooks?.SubagentStart).toHaveLength(1);
    expect(settings.hooks?.UserPromptSubmit).toHaveLength(1);
  });

  it("preserves non-hooks settings keys", async () => {
    const rootDir = makeTempRoot();
    const settingsPath = path.join(rootDir, ".claude/settings.json");

    const initial = {
      permissions: { allow: ["Bash(git *)"] },
      hooks: {},
    };
    await writeFileSafe(settingsPath, JSON.stringify(initial, null, 2) + "\n");

    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(settingsPath)) as Record<string, unknown>;
    expect(settings.permissions).toEqual({ allow: ["Bash(git *)"] });
  });

  it("creates settings.json from scratch when none exists", async () => {
    const rootDir = makeTempRoot();
    // No settings.json written - configureClaudeHooks should create it
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    expect(settings).toBeDefined();
    expect(settings.hooks).toBeDefined();
    expect(Object.keys(settings.hooks ?? {}).length).toBeGreaterThan(0);
  });

  it("all hook commands reference .clarte/hooks/ directory", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    for (const [_event, groups] of Object.entries(settings.hooks ?? {})) {
      for (const group of groups as MatchedHookGroup[]) {
        for (const hook of group.hooks) {
          expect(hook.command).toContain(".clarte/hooks/");
          expect(hook.type).toBe("command");
        }
      }
    }
  });

  it("handles malformed existing settings.json gracefully", async () => {
    const rootDir = makeTempRoot();
    const settingsPath = path.join(rootDir, ".claude/settings.json");

    // Write invalid JSON
    await writeFileSafe(settingsPath, "{ not valid json !!!");

    // Should not throw, treats malformed as empty
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as ClaudeSettings;
    expect(settings.hooks).toBeDefined();
    expect(settings.hooks?.SessionStart).toHaveLength(1);
  });

  it("replaces stale clarte hooks from a previous version", async () => {
    const rootDir = makeTempRoot();
    const settingsPath = path.join(rootDir, ".claude/settings.json");

    // Simulate old clarte hooks with different filenames
    const initial: ClaudeSettings = {
      hooks: {
        PreToolUse: [{ hooks: [{ type: "command", command: "node .clarte/hooks/old-hook.mjs" }] }],
      },
    };
    await writeFileSafe(settingsPath, JSON.stringify(initial, null, 2) + "\n");

    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(settingsPath)) as ClaudeSettings;
    // Old hook should be removed (it's a clarte hook), replaced by current hooks
    const hasOldHook = settings.hooks?.PreToolUse?.some((g) =>
      g.hooks?.some((h) => h.command.includes("old-hook.mjs")),
    );
    expect(hasOldHook).toBe(false);
    // Current PreToolUse hooks should be present
    expect(settings.hooks?.PreToolUse).toHaveLength(2);
  });
});
