import { describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { parseSessionLog, normalizeToRelative } from "../analysis/learn-parse.js";
import { ClarteError } from "../errors.js";

async function writeTempJsonl(lines: string[]): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learn-parse-"));
  const file = path.join(dir, "session.jsonl");
  await fs.writeFile(file, lines.join("\n") + "\n");
  return file;
}

function assistantRecord(
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>,
  extra: Record<string, unknown> = {},
): string {
  return JSON.stringify({
    type: "assistant",
    sessionId: "test-session-id",
    slug: "test-slug",
    version: "2.1.68",
    cwd: "/home/user/project",
    timestamp: "2026-03-05T10:00:00Z",
    message: {
      content: toolUses.map((t) => ({
        type: "tool_use",
        id: t.id,
        name: t.name,
        input: t.input,
      })),
      stop_reason: "tool_use",
    },
    ...extra,
  });
}

function userResultRecord(toolUseId: string, toolUseResult: unknown = {}, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: "test-session-id",
    version: "2.1.68",
    cwd: "/home/user/project",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content: "ok",
        },
      ],
    },
    toolUseResult,
    ...extra,
  });
}

function userErrorResultRecord(toolUseId: string, content = "Error: not found"): string {
  return JSON.stringify({
    type: "user",
    sessionId: "test-session-id",
    version: "2.1.68",
    cwd: "/home/user/project",
    message: {
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          content,
          is_error: true,
        },
      ],
    },
  });
}

describe("parseSessionLog", () => {
  it("parses Read tool_use and normalizes filePath to relative", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/src/foo.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events).toHaveLength(1);
    expect(session.events[0].tool).toBe("Read");
    expect(session.events[0].filePath).toBe("/home/user/project/src/foo.ts");
    expect(session.events[0].relativePath).toBe("src/foo.ts");
  });

  it("parses Grep tool_use and extracts pattern", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Grep", input: { pattern: "handleError", path: "/home/user/project/src" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].tool).toBe("Grep");
    expect(session.events[0].pattern).toBe("handleError");
  });

  it("parses Write/Edit tool_use and extracts filePath", async () => {
    const file = await writeTempJsonl([
      assistantRecord([
        {
          id: "t1",
          name: "Edit",
          input: { file_path: "/home/user/project/src/bar.ts", old_string: "a", new_string: "b" },
        },
      ]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].tool).toBe("Edit");
    expect(session.events[0].relativePath).toBe("src/bar.ts");
  });

  it("parses Bash tool_use and extracts command", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Bash", input: { command: "npm test" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].tool).toBe("Bash");
    expect(session.events[0].command).toBe("npm test");
  });

  it("correlates tool_result success by matching tool_use_id", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/src/foo.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].succeeded).toBe(true);
  });

  it("detects is_error as failure", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/nonexistent.ts" } }]),
      userErrorResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].succeeded).toBe(false);
  });

  it("detects Grep with numFiles: 0 as no-match", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Grep", input: { pattern: "xyz" } }]),
      userResultRecord("t1", { numFiles: 0 }),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].succeeded).toBe(false);
  });

  it("fallback: missing toolUseResult but content contains 'No matches'", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Grep", input: { pattern: "xyz" } }]),
      JSON.stringify({
        type: "user",
        sessionId: "test-session-id",
        version: "2.1.68",
        cwd: "/home/user/project",
        message: {
          content: [{ type: "tool_result", tool_use_id: "t1", content: "No matches found" }],
        },
      }),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].succeeded).toBe(false);
  });

  it("extracts resultFiles from Grep filenames", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Grep", input: { pattern: "foo" } }]),
      userResultRecord("t1", { filenames: ["src/foo.ts", "src/bar.ts"], numFiles: 2 }),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].resultFiles).toEqual(["src/foo.ts", "src/bar.ts"]);
  });

  it("extracts resultFiles from Glob filenames (absolute paths normalized)", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Glob", input: { pattern: "**/*.ts" } }]),
      userResultRecord("t1", { filenames: ["/home/user/project/src/a.ts", "/home/user/project/src/b.ts"] }),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].resultFiles).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("skips progress, system, queue-operation, file-history-snapshot records", async () => {
    const file = await writeTempJsonl([
      JSON.stringify({ type: "progress", sessionId: "test" }),
      JSON.stringify({ type: "system", sessionId: "test" }),
      JSON.stringify({ type: "queue-operation", sessionId: "test" }),
      JSON.stringify({ type: "file-history-snapshot", sessionId: "test" }),
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/src/foo.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events).toHaveLength(1);
    expect(session.events[0].tool).toBe("Read");
  });

  it("skips malformed JSON lines and increments skippedLines", async () => {
    const file = await writeTempJsonl([
      "this is not json",
      "{broken json",
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/src/foo.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.skippedLines).toBe(2);
    expect(session.events).toHaveLength(1);
  });

  it("normalizes absolute paths to relative using cwd-inferred rootDir", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/src/deep/nested.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.rootDir).toBe("/home/user/project");
    expect(session.events[0].relativePath).toBe("src/deep/nested.ts");
  });

  it("returns undefined for paths outside rootDir", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/other/place/file.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events[0].relativePath).toBeUndefined();
  });

  it("counts turns correctly", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/a.ts" } }]),
      userResultRecord("t1"),
      JSON.stringify({
        type: "assistant",
        sessionId: "test-session-id",
        version: "2.1.68",
        cwd: "/home/user/project",
        timestamp: "2026-03-05T10:01:00Z",
        message: { content: [{ type: "text", text: "Done!" }], stop_reason: "end_turn" },
      }),
    ]);

    const session = await parseSessionLog(file);
    // 2 assistant records with non-null stop_reason
    expect(session.turnCount).toBe(2);
  });

  it("handles parallel tool calls (multiple tool_use in one record)", async () => {
    const file = await writeTempJsonl([
      assistantRecord([
        { id: "t1", name: "Read", input: { file_path: "/home/user/project/a.ts" } },
        { id: "t2", name: "Read", input: { file_path: "/home/user/project/b.ts" } },
      ]),
      userResultRecord("t1"),
      userResultRecord("t2"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.events).toHaveLength(2);
    expect(session.events[0].relativePath).toBe("a.ts");
    expect(session.events[1].relativePath).toBe("b.ts");
  });

  it("throws ClarteError for files > 100 MB", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "learn-parse-"));
    const file = path.join(dir, "huge.jsonl");
    await fs.writeFile(file, "{}");
    const originalStat = fs.stat;
    const mock = vi
      .spyOn(fs, "stat")
      .mockResolvedValue({ size: 200 * 1024 * 1024 } as Awaited<ReturnType<typeof originalStat>>);

    await expect(parseSessionLog(file)).rejects.toThrow(ClarteError);

    mock.mockRestore();
  });

  it("extracts sessionId, slug and cliVersion from records", async () => {
    const file = await writeTempJsonl([
      assistantRecord([{ id: "t1", name: "Read", input: { file_path: "/home/user/project/a.ts" } }]),
      userResultRecord("t1"),
    ]);

    const session = await parseSessionLog(file);
    expect(session.sessionId).toBe("test-session-id");
    expect(session.slug).toBe("test-slug");
    expect(session.cliVersion).toBe("2.1.68");
  });
});

describe("normalizeToRelative", () => {
  it("strips rootDir prefix", () => {
    expect(normalizeToRelative("/home/user/project/src/foo.ts", "/home/user/project")).toBe("src/foo.ts");
  });

  it("returns undefined for paths outside rootDir", () => {
    expect(normalizeToRelative("/other/path/foo.ts", "/home/user/project")).toBeUndefined();
  });

  it("handles trailing slashes on rootDir", () => {
    expect(normalizeToRelative("/home/user/project/src/foo.ts", "/home/user/project/")).toBe("src/foo.ts");
  });

  it("handles backslashes", () => {
    expect(normalizeToRelative("C:\\Users\\me\\project\\src\\foo.ts", "C:\\Users\\me\\project")).toBe("src/foo.ts");
  });
});
