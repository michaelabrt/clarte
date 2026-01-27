import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { spawn, type ChildProcess } from "node:child_process";

const projectRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "..");
const distEntry = path.join(projectRoot, "dist/index.js");

/**
 * The MCP SDK uses newline-delimited JSON (one JSON object per line).
 */
function encodeMessage(payload: unknown): string {
  return JSON.stringify(payload) + "\n";
}

/**
 * Read one newline-delimited JSON message from a buffer accumulator.
 * Returns the parsed object and the number of bytes consumed,
 * or null if the buffer does not yet contain a complete line.
 */
function tryParseLine(buf: Buffer): { parsed: unknown; consumed: number } | null {
  const newlineIdx = buf.indexOf("\n");
  if (newlineIdx === -1) return null;

  const line = buf.slice(0, newlineIdx).toString("utf-8").trimEnd();
  const parsed = JSON.parse(line);
  return { parsed, consumed: newlineIdx + 1 };
}

/**
 * Send a JSON-RPC request to the server and resolve with the next response line.
 */
function sendRequest(
  proc: ChildProcess,
  accumulator: { buf: Buffer; resolvers: Array<(msg: unknown) => void> },
  payload: unknown,
): Promise<unknown> {
  return new Promise((resolve) => {
    accumulator.resolvers.push(resolve);
    proc.stdin!.write(encodeMessage(payload));
  });
}

if (!existsSync(distEntry)) {
  describe.skip("MCP server protocol", () => {
    it.skip("dist not built", () => {});
  });
} else {
  describe("MCP server protocol", () => {
    let proc: ChildProcess;
    let accumulator: { buf: Buffer; resolvers: Array<(msg: unknown) => void> };
    let nextId = 1;

    beforeAll(async () => {
      accumulator = { buf: Buffer.alloc(0), resolvers: [] };

      proc = spawn("node", [distEntry, "serve"], {
        cwd: projectRoot,
        stdio: ["pipe", "pipe", "pipe"],
      });

      proc.stdout!.on("data", (chunk: Buffer) => {
        accumulator.buf = Buffer.concat([accumulator.buf, chunk]);
        // Drain all complete lines
        let result = tryParseLine(accumulator.buf);
        while (result !== null) {
          accumulator.buf = accumulator.buf.slice(result.consumed);
          const resolver = accumulator.resolvers.shift();
          if (resolver) resolver(result.parsed);
          result = tryParseLine(accumulator.buf);
        }
      });

      // Wait for the server to be ready by sending initialize and waiting for response
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("MCP server did not start in time")), 10_000);
        const initMsg = {
          jsonrpc: "2.0",
          id: nextId++,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "test-client", version: "1.0" },
          },
        };
        accumulator.resolvers.push(() => {
          clearTimeout(timeout);
          // Send the required initialized notification to complete the handshake
          proc.stdin!.write(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" }));
          resolve();
        });
        proc.stdin!.write(encodeMessage(initMsg));
      });
    });

    afterAll(() => {
      proc?.kill();
    });

    it("initialize response has protocolVersion, tools capability and serverInfo.name === clarte", async () => {
      const msg = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "initialize",
        params: {
          protocolVersion: "2024-11-05",
          capabilities: {},
          clientInfo: { name: "test-client", version: "1.0" },
        },
      };
      const response = (await sendRequest(proc, accumulator, msg)) as {
        result: { protocolVersion: string; capabilities: { tools?: unknown }; serverInfo: { name: string } };
      };

      expect(response.result.protocolVersion).toBeTruthy();
      expect(response.result.capabilities.tools).toBeDefined();
      expect(response.result.serverInfo.name).toBe("clarte");
    });

    it("tools/list returns the 3 expected tool names", async () => {
      const msg = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/list",
        params: {},
      };
      const response = (await sendRequest(proc, accumulator, msg)) as {
        result: { tools: Array<{ name: string }> };
      };

      const names = response.result.tools.map((t) => t.name).sort();
      expect(names).toContain("clarte_scope");
      expect(names).toContain("clarte_function");
      expect(names).toContain("clarte_impact");
      expect(names).toHaveLength(3);
    });

    it("clarte_scope for a known file returns content with FILE:", async () => {
      const msg = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: {
          name: "clarte_scope",
          arguments: { path: "src/mcp/server.ts" },
        },
      };
      const response = (await sendRequest(proc, accumulator, msg)) as {
        result: { content: Array<{ type: string; text: string }>; isError?: boolean };
      };

      expect(response.result.isError).toBeFalsy();
      expect(response.result.content[0].type).toBe("text");
      expect(response.result.content[0].text).toContain("FILE:");
    });

    it("tools/call with unknown tool name returns isError: true", async () => {
      const msg = {
        jsonrpc: "2.0",
        id: nextId++,
        method: "tools/call",
        params: {
          name: "clarte_does_not_exist",
          arguments: {},
        },
      };
      const response = (await sendRequest(proc, accumulator, msg)) as {
        result: { isError?: boolean };
      };

      expect(response.result.isError).toBe(true);
    });
  });
}
