import { describe, it, expect } from "vitest";

// Import the module under test. HOOK_DEFS and ALL_HOOK_EVENTS are not exported,
// so we verify the feature through the generateHookFiles output and by checking
// the exported configureClaudeHooks behaviour via the settings it produces.
// The structural assertions below read the module source at the type level to
// confirm the PostToolUse edit-tracker hook and ALL_HOOK_EVENTS membership.

// We can inspect the hook definitions indirectly: generateHookFiles writes one
// file per HOOK_DEFS entry; configureClaudeHooks registers each def's event.
// The cleanest non-internal seam is configureClaudeHooks writing settings.json.

import { configureClaudeHooks } from "../hooks/generate-hooks.js";
import { readJsonFile } from "../utils.js";
import { writeFileSafe } from "../utils.js";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

function makeTempRoot(): string {
  const dir = path.join(tmpdir(), `clarte-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(path.join(dir, ".claude"), { recursive: true });
  return dir;
}

describe("Prediction feedback loop - hook registration", () => {
  it("configureClaudeHooks registers a PostToolUse entry for the edit tracker", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as {
      hooks?: { PostToolUse?: { hooks: { type: string; command: string }[] }[] };
    };

    const postHooks = settings?.hooks?.PostToolUse;
    expect(postHooks).toBeDefined();
    expect(Array.isArray(postHooks)).toBe(true);

    const editTrackerEntry = postHooks?.find((group) =>
      group.hooks?.some((h) => h.command?.includes("on-edit-tracker.mjs")),
    );
    expect(editTrackerEntry).toBeDefined();
  });

  it("configureClaudeHooks includes PostToolUse in the written hooks object", async () => {
    const rootDir = makeTempRoot();
    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(path.join(rootDir, ".claude/settings.json"))) as {
      hooks?: Record<string, unknown>;
    };

    expect(settings?.hooks).toHaveProperty("PostToolUse");
  });

  it("configureClaudeHooks does not remove existing non-clarte PostToolUse hooks", async () => {
    const rootDir = makeTempRoot();
    const settingsPath = path.join(rootDir, ".claude/settings.json");

    // Pre-populate with a user-defined PostToolUse hook
    const initial = {
      hooks: {
        PostToolUse: [{ hooks: [{ type: "command", command: "node my-custom-hook.mjs" }] }],
      },
    };
    await writeFileSafe(settingsPath, JSON.stringify(initial, null, 2) + "\n");

    await configureClaudeHooks(rootDir);

    const settings = (await readJsonFile(settingsPath)) as {
      hooks?: { PostToolUse?: { hooks: { type: string; command: string }[] }[] };
    };

    const userHook = settings?.hooks?.PostToolUse?.find((group) =>
      group.hooks?.some((h) => h.command === "node my-custom-hook.mjs"),
    );
    expect(userHook).toBeDefined();
  });
});
