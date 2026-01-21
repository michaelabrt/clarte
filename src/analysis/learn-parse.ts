import fs from "node:fs/promises";
import path from "node:path";
import { ClarteError } from "../errors.js";
import type { ParsedSession, ToolEvent } from "../types/learn.js";

const MAX_FILE_SIZE = 100 * 1024 * 1024; // 100 MB

interface ToolUseBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string;
  is_error?: boolean;
}

interface SessionRecord {
  type: string;
  sessionId?: string;
  slug?: string;
  version?: string;
  cwd?: string;
  timestamp?: string;
  message?: {
    content?: unknown[] | string;
    stop_reason?: string | null;
  };
  toolUseResult?: unknown;
}

export function normalizeToRelative(absPath: string, rootDir: string): string | undefined {
  const normalized = absPath.replace(/\\/g, "/");
  const normalizedRoot = rootDir.replace(/\\/g, "/").replace(/\/$/, "");
  if (normalized.startsWith(normalizedRoot + "/")) {
    return normalized.slice(normalizedRoot.length + 1);
  }
  return undefined;
}

function extractToolEvents(record: SessionRecord, rootDir: string): ToolEvent[] {
  const content = record.message?.content;
  if (!Array.isArray(content)) return [];

  const events: ToolEvent[] = [];
  for (const block of content) {
    if (typeof block !== "object" || block === null) continue;
    const b = block as Record<string, unknown>;
    if (b.type !== "tool_use") continue;

    const toolBlock = block as ToolUseBlock;
    const input = toolBlock.input ?? {};
    const event: ToolEvent = {
      tool: toolBlock.name,
      succeeded: true, // default, overridden by result correlation
      timestamp: record.timestamp ?? "",
      toolUseId: toolBlock.id,
    };

    // Extract file path based on tool type
    const filePath = input.file_path as string | undefined;
    if (filePath) {
      event.filePath = filePath;
      event.relativePath = normalizeToRelative(filePath, rootDir);
    }

    // Extract pattern for search tools
    if (input.pattern !== undefined) {
      event.pattern = String(input.pattern);
    }

    // Extract command for Bash
    if (input.command !== undefined) {
      event.command = String(input.command);
    }

    events.push(event);
  }
  return events;
}

function isToolResult(block: unknown): block is ToolResultBlock {
  if (typeof block !== "object" || block === null) return false;
  return (block as Record<string, unknown>).type === "tool_result";
}

function determineSuccess(toolName: string, result: ToolResultBlock, toolUseResult: unknown): boolean {
  // Layer 1: explicit error
  if (result.is_error) return false;

  if (toolUseResult !== undefined && toolUseResult !== null) {
    const tur = toolUseResult as Record<string, unknown>;

    // Layer 2: Grep with no files
    if (toolName === "Grep" && tur.numFiles === 0) return false;

    // Layer 3: Glob with empty filenames
    if (toolName === "Glob" && Array.isArray(tur.filenames) && tur.filenames.length === 0) return false;

    // Layer 4: Edit with null result
    if (toolName === "Edit" && toolUseResult === null) return false;

    return true;
  }

  // Layer 5: fallback - check content string for error indicators
  const contentStr = typeof result.content === "string" ? result.content : "";
  if (contentStr.startsWith("<tool_use_error>")) return false;
  if (/\bNo matches\b/.test(contentStr)) return false;
  if (/\bNo files found\b/.test(contentStr)) return false;
  if (/\bError\b/.test(contentStr)) return false;
  if (/\bnot found\b/.test(contentStr)) return false;

  // Layer 6: assume success
  return true;
}

function extractResultFiles(toolName: string, toolUseResult: unknown, rootDir: string): string[] | undefined {
  if (toolUseResult === undefined || toolUseResult === null) return undefined;
  const tur = toolUseResult as Record<string, unknown>;

  if (toolName === "Glob") {
    const filenames = tur.filenames;
    if (!Array.isArray(filenames)) return undefined;
    const result: string[] = [];
    for (const f of filenames) {
      if (typeof f !== "string") continue;
      const rel = normalizeToRelative(f, rootDir);
      if (rel) result.push(rel);
    }
    return result;
  }

  if (toolName === "Grep") {
    const filenames = tur.filenames;
    if (Array.isArray(filenames)) {
      return filenames.filter((f): f is string => typeof f === "string");
    }
    // content mode: parse file paths from content string
    const content = tur.content;
    if (typeof content === "string") {
      const files = new Set<string>();
      for (const line of content.split("\n")) {
        const colonIdx = line.indexOf(":");
        if (colonIdx === -1) continue;
        const candidate = line.slice(0, colonIdx);
        // Must look like a file path (contains / or \) and not start with a digit
        if ((candidate.includes("/") || candidate.includes("\\")) && !/^\d/.test(candidate)) {
          files.add(candidate);
        }
      }
      return files.size > 0 ? [...files] : undefined;
    }
  }

  return undefined;
}

export async function parseSessionLog(filePath: string): Promise<ParsedSession> {
  // Size guard
  const stat = await fs.stat(filePath);
  if (stat.size > MAX_FILE_SIZE) {
    throw new ClarteError("Session log too large (>100 MB). Use a single session file.");
  }

  const raw = await fs.readFile(filePath, "utf-8");
  const lines = raw.split("\n");

  const records: SessionRecord[] = [];
  let skippedLines = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as SessionRecord);
    } catch {
      skippedLines++;
    }
  }

  // Infer rootDir from first record with cwd
  let rootDir = "";
  for (const r of records) {
    if (r.cwd) {
      rootDir = r.cwd;
      break;
    }
  }

  // Fallback: longest common prefix of all absolute file paths
  if (!rootDir) {
    const allPaths: string[] = [];
    for (const r of records) {
      if (!Array.isArray(r.message?.content)) continue;
      for (const block of r.message.content as unknown[]) {
        if (typeof block !== "object" || block === null) continue;
        const b = block as Record<string, unknown>;
        if (b.type === "tool_use") {
          const input = b.input as Record<string, unknown> | undefined;
          const fp = input?.file_path;
          if (typeof fp === "string" && path.isAbsolute(fp)) {
            allPaths.push(fp);
          }
        }
      }
    }
    if (allPaths.length > 0) {
      rootDir = longestCommonPrefix(allPaths.map((p) => path.dirname(p)));
    }
  }

  // Extract session metadata
  let sessionId = "";
  let slug: string | undefined;
  let cliVersion = "";

  for (const r of records) {
    if (r.sessionId && !sessionId) sessionId = r.sessionId;
    if (r.slug && !slug) slug = r.slug;
    if (r.version && !cliVersion) cliVersion = r.version;
  }

  // First pass: extract all tool events from assistant records
  const events: ToolEvent[] = [];
  const toolEventMap = new Map<string, ToolEvent>();

  for (const r of records) {
    if (r.type !== "assistant") continue;
    const extracted = extractToolEvents(r, rootDir);
    for (const e of extracted) {
      events.push(e);
      toolEventMap.set(e.toolUseId, e);
    }
  }

  // Second pass: correlate results from user records
  for (const r of records) {
    if (r.type !== "user") continue;
    const content = r.message?.content;
    if (!Array.isArray(content)) continue;

    for (const block of content) {
      if (!isToolResult(block)) continue;
      const event = toolEventMap.get(block.tool_use_id);
      if (!event) continue;

      const toolUseResult = r.toolUseResult;
      event.succeeded = determineSuccess(event.tool, block, toolUseResult);

      // Extract result files for search tools
      const resultFiles = extractResultFiles(event.tool, toolUseResult, rootDir);
      if (resultFiles) {
        event.resultFiles = resultFiles;
      }
    }
  }

  // Count turns
  let turnCount = 0;
  for (const r of records) {
    if (r.type === "assistant" && r.message?.stop_reason != null) {
      turnCount++;
    }
  }

  return {
    sessionId,
    slug,
    cliVersion,
    rootDir,
    events,
    turnCount,
    skippedLines,
  };
}

function longestCommonPrefix(paths: string[]): string {
  if (paths.length === 0) return "";
  let prefix = paths[0];
  for (let i = 1; i < paths.length; i++) {
    while (!paths[i].startsWith(prefix)) {
      const lastSlash = prefix.lastIndexOf("/");
      if (lastSlash === -1) return "";
      prefix = prefix.slice(0, lastSlash);
    }
  }
  return prefix;
}
