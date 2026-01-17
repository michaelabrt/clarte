import path from "node:path";
import { readJsonFile, writeFileSafe } from "../utils.js";
import type { PersistedGraph } from "../types/persisted-graph.js";
import { buildContextMap } from "./context-map.js";
import { CLARTE_DIR } from "../config/config.js";

const HOOKS_DIR = `${CLARTE_DIR}/hooks`;
const CONTEXT_MAP_FILE = "context-map.json";
const SETTINGS_PATH = ".claude/settings.json";

const PARSE_STDIN = `let input;
try { input = JSON.parse(readFileSync("/dev/stdin", "utf-8")); } catch { process.exit(0); }`;

const SESSION_START_SCRIPT = `#!/usr/bin/env node
import { readFileSync, appendFileSync } from "node:fs";

${PARSE_STDIN}
const model = (input.model || "").toLowerCase();
if (model.includes("haiku") && process.env.CLAUDE_ENV_FILE) {
  appendFileSync(process.env.CLAUDE_ENV_FILE, "export CLARTE_HOOKS_DISABLED=1\\n");
}
`;

const READ_SCRIPT = `#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { resolve, relative } from "node:path";

if (process.env.CLARTE_HOOKS_DISABLED) process.exit(0);

${PARSE_STDIN}
const filePath = input.tool_input?.file_path;
if (!filePath) process.exit(0);

const root = process.cwd();
const rel = relative(root, resolve(filePath));
const mapPath = resolve(root, ".clarte/hooks/context-map.json");

let map;
try { map = JSON.parse(readFileSync(mapPath, "utf-8")); } catch { process.exit(0); }

const ctx = map[rel] || map[rel.replace(/\\\\/g, "/")];
if (!ctx) process.exit(0);

const output = JSON.stringify({ additionalContext: ctx });
process.stdout.write(output);
`;

interface HookDef {
  event: string;
  file: string;
  matcher?: string;
  script: string;
}

const HOOK_DEFS: HookDef[] = [
  { event: "SessionStart", file: "on-session-start.mjs", script: SESSION_START_SCRIPT },
  { event: "PreToolUse", file: "on-read.mjs", matcher: "Read", script: READ_SCRIPT },
];

/**
 * Generate hook files: context-map.json, on-read.mjs and on-session-start.mjs.
 */
export async function generateHookFiles(rootDir: string, graph: PersistedGraph): Promise<void> {
  const contextMap = buildContextMap(graph);

  const hooksDir = path.join(rootDir, HOOKS_DIR);
  await writeFileSafe(path.join(hooksDir, CONTEXT_MAP_FILE), JSON.stringify(contextMap, null, 2));
  for (const def of HOOK_DEFS) {
    await writeFileSafe(path.join(hooksDir, def.file), def.script);
  }
}

interface HookEntry {
  type: string;
  command: string;
}

interface MatchedHookGroup {
  matcher?: string;
  hooks: HookEntry[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: MatchedHookGroup[];
    SessionStart?: MatchedHookGroup[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

function upsertHookEntry(entries: MatchedHookGroup[], newEntry: MatchedHookGroup): void {
  const existingIdx = entries.findIndex((entry) => entry.hooks?.some((h) => h.command?.includes(`${HOOKS_DIR}/`)));
  if (existingIdx >= 0) {
    entries[existingIdx] = newEntry;
  } else {
    entries.push(newEntry);
  }
}

/**
 * Configure Claude Code hook settings in .claude/settings.json.
 * Merges SessionStart and PreToolUse hooks without clobbering user-defined hooks.
 */
export async function configureClaudeHooks(rootDir: string): Promise<void> {
  const settingsPath = path.join(rootDir, SETTINGS_PATH);
  const raw = (await readJsonFile(settingsPath)) as ClaudeSettings | null;
  const settings: ClaudeSettings = raw ?? {};

  if (!settings.hooks) {
    settings.hooks = {};
  }

  for (const def of HOOK_DEFS) {
    const group = (settings.hooks[def.event] ??= []) as MatchedHookGroup[];
    const entry: MatchedHookGroup = {
      ...(def.matcher ? { matcher: def.matcher } : {}),
      hooks: [{ type: "command", command: `node ${HOOKS_DIR}/${def.file}` }],
    };
    upsertHookEntry(group, entry);
  }

  await writeFileSafe(settingsPath, JSON.stringify(settings, null, 2) + "\n");
}
