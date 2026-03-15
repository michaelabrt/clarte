import { readFileSync } from "node:fs";

/** A single tool call extracted from a session turn */
export interface ToolCall {
  name: string;
  input?: Record<string, unknown>;
}

/** A parsed conversation turn (one assistant response cycle) */
export interface Turn {
  /** Turn index (0-based) */
  index: number;
  /** Tool calls made in this turn */
  tools: ToolCall[];
  /** Input tokens (prompt) */
  inputTokens: number;
  /** Output tokens (completion) */
  outputTokens: number;
  /** Cache read tokens */
  cacheReadTokens: number;
  /** Cache creation tokens */
  cacheCreationTokens: number;
  /** ISO timestamp of first message in this turn */
  timestamp: string;
  /** Files targeted by Read/Edit/Write/Grep/Glob tools */
  filePaths: string[];
}

/** Raw JSONL entry from Claude Code session log */
interface SessionEntry {
  type: string;
  message?: {
    role?: string;
    content?: string | ContentBlock[];
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      cache_read_input_tokens?: number;
      cache_creation_input_tokens?: number;
    };
  };
  timestamp?: string;
  parentUuid?: string | null;
  isSidechain?: boolean;
}

interface ContentBlock {
  type: string;
  name?: string;
  input?: Record<string, unknown>;
  text?: string;
}

/** A parsed session with metadata and turns */
export interface ParsedSession {
  /** Session ID (from filename or first entry) */
  sessionId: string;
  /** All conversation turns */
  turns: Turn[];
  /** Session start timestamp */
  startedAt: string;
  /** Session end timestamp */
  endedAt: string;
  /** Working directory */
  cwd: string;
}

function extractFilePaths(tools: ToolCall[]): string[] {
  const paths: string[] = [];
  for (const tool of tools) {
    if (!tool.input) continue;
    const fp =
      (tool.input as Record<string, unknown>).file_path ??
      (tool.input as Record<string, unknown>).path ??
      (tool.input as Record<string, unknown>).pattern;
    if (typeof fp === "string" && fp.length > 0) paths.push(fp);
  }
  return paths;
}

/**
 * Parse a Claude Code JSONL session log into structured turns.
 *
 * A "turn" is one assistant response cycle: the agent thinks, optionally
 * calls tools, and the user/system returns results. We aggregate all
 * assistant messages between user messages into a single turn.
 */
export function parseSessionFile(filePath: string): ParsedSession {
  const raw = readFileSync(filePath, "utf-8");
  const lines = raw.trim().split("\n").filter(Boolean);

  const entries: SessionEntry[] = [];
  for (const line of lines) {
    try {
      entries.push(JSON.parse(line));
    } catch {
      // Skip malformed lines
    }
  }

  // Filter to conversation messages (skip queue-operation, etc.)
  const messages = entries.filter((e) => (e.type === "user" || e.type === "assistant") && e.message?.role);

  // Extract session metadata from first user message
  const firstUser = entries.find((e) => e.type === "user" && e.message?.role === "user");
  const sessionId = filePath.split("/").pop()?.replace(".jsonl", "") ?? "unknown";
  const cwd = ((firstUser as unknown as Record<string, unknown>)?.cwd as string) ?? "";

  // A "turn" is one agentic loop iteration: the assistant produces a
  // tool-calling message, then receives the tool result. Claude Code
  // emits multiple assistant entries per turn (thinking chunks, then
  // the tool call). We detect turn boundaries by looking for assistant
  // messages that contain a tool_use block - each one is a turn.
  // Text-only assistant messages at the end (no tool call) also count
  // as a turn (the final summary/answer).

  const turns: Turn[] = [];

  let currentTools: ToolCall[] = [];
  let currentInputTokens = 0;
  let currentOutputTokens = 0;
  let currentCacheRead = 0;
  let currentCacheCreation = 0;
  let turnTimestamp = "";
  let hasContent = false;

  function flushTurn() {
    if (!hasContent) return;
    turns.push({
      index: turns.length,
      tools: currentTools,
      inputTokens: currentInputTokens,
      outputTokens: currentOutputTokens,
      cacheReadTokens: currentCacheRead,
      cacheCreationTokens: currentCacheCreation,
      timestamp: turnTimestamp,
      filePaths: extractFilePaths(currentTools),
    });
    currentTools = [];
    currentInputTokens = 0;
    currentOutputTokens = 0;
    currentCacheRead = 0;
    currentCacheCreation = 0;
    turnTimestamp = "";
    hasContent = false;
  }

  for (const msg of messages) {
    if (msg.message?.role !== "assistant") continue;

    const usage = msg.message.usage;
    const content = msg.message.content;
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === "tool_use" && block.name) {
          toolCalls.push({ name: block.name, input: block.input });
        }
      }
    }

    if (toolCalls.length > 0) {
      // This assistant message has tool calls - it's a new turn boundary.
      // Flush any accumulated thinking from previous messages, then
      // start a fresh turn with this tool call.
      flushTurn();

      if (!turnTimestamp) turnTimestamp = msg.timestamp ?? "";
      if (usage) {
        currentInputTokens += usage.input_tokens ?? 0;
        currentOutputTokens += usage.output_tokens ?? 0;
        currentCacheRead += usage.cache_read_input_tokens ?? 0;
        currentCacheCreation += usage.cache_creation_input_tokens ?? 0;
      }
      currentTools.push(...toolCalls);
      hasContent = true;

      // Immediately flush - one tool-call message = one turn
      flushTurn();
    } else {
      // Thinking/continuation message or final text answer
      if (!turnTimestamp) turnTimestamp = msg.timestamp ?? "";
      if (usage) {
        currentInputTokens += usage.input_tokens ?? 0;
        currentOutputTokens += usage.output_tokens ?? 0;
        currentCacheRead += usage.cache_read_input_tokens ?? 0;
        currentCacheCreation += usage.cache_creation_input_tokens ?? 0;
      }
      if (usage && (usage.output_tokens ?? 0) > 50) {
        // Substantial text output (not just a thinking stub)
        hasContent = true;
      }
    }
  }

  // Flush any trailing text-only turn
  flushTurn();

  const timestamps = messages.map((m) => m.timestamp).filter((t): t is string => typeof t === "string");

  return {
    sessionId,
    turns,
    startedAt: timestamps[0] ?? "",
    endedAt: timestamps[timestamps.length - 1] ?? "",
    cwd,
  };
}
