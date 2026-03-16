/**
 * Clarte MCP server (RFC §4.1).
 *
 * Exposes graph intelligence tools to AI agents via the Model Context Protocol.
 * Started as a subprocess by Claude Code (or other MCP clients).
 *
 * Tools:
 *   clarte_callers - "Who calls this function?"
 *   clarte_impact  - "What breaks if I change this?"
 *   clarte_find    - "Where is the code that does X?"
 *
 * F.5: Opens the SQLite database in read-only mode (SQLITE_OPEN_READONLY).
 * WAL mode allows concurrent reads while the main clarte process writes.
 * No DDL or write PRAGMAs are executed.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";
import path from "node:path";
import { createReadonlyDatabase } from "../storage/db-adapter.js";
import { executeCallers } from "./tools/callers.js";
import { executeImpact } from "./tools/impact.js";
import { executeFind } from "./tools/find.js";
import type { DatabaseAdapter } from "../storage/db-adapter.js";

// ── Database lifecycle ───────────────────────────────────────────────────────

let db: DatabaseAdapter | null = null;

/**
 * Open the graph database for the current project in read-only mode.
 * F.5: No initSchema call - the DB must already exist and be initialized
 * by a prior `clarte init` or `clarte refresh` run.
 */
async function openDb(): Promise<DatabaseAdapter> {
  if (db) return db;

  const rootDir = process.env.CLARTE_ROOT ?? process.cwd();
  const dbPath = path.join(rootDir, ".clarte", "graph.db");

  db = await createReadonlyDatabase(dbPath);
  return db;
}

// ── Server setup ─────────────────────────────────────────────────────────────

const server = new McpServer({
  name: "clarte",
  version: "1.0.0",
});

// ── Tool: clarte_callers ─────────────────────────────────────────────────────

server.registerTool(
  "clarte_callers",
  {
    description:
      "Find all callers of a symbol. Returns a caller chain up to 5 levels deep with depth tags (DIRECT, TRANSITIVE, DISTANT). Use when you need to understand who depends on a function before modifying it.",
    inputSchema: {
      symbol: z.string().describe("The symbol name to look up (e.g. 'validateSession')"),
      file: z.string().describe("The file path containing the symbol (e.g. 'src/auth/session.ts')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ symbol, file }) => {
    const database = await openDb();
    const result = executeCallers(database, { symbol, file });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── Tool: clarte_impact ──────────────────────────────────────────────────────

server.registerTool(
  "clarte_impact",
  {
    description:
      "Analyze the blast radius of changing a file. Returns three categories: WILL BREAK (direct runtime dependents), LIKELY AFFECTED (2-hop dependents), and TEST (test files to run). Use before making changes to understand downstream effects.",
    inputSchema: {
      file: z.string().describe("The file path to analyze impact for (e.g. 'src/auth/session.ts')"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ file }) => {
    const database = await openDb();
    const result = executeImpact(database, { file });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── Tool: clarte_find ────────────────────────────────────────────────────────

server.registerTool(
  "clarte_find",
  {
    description:
      "Search the codebase by natural language query. Combines lexical (BM25F) and semantic search to find files and symbols matching a description. Use when you need to locate code that handles a specific concern (e.g. 'handle expired authentication sessions').",
    inputSchema: {
      query: z.string().describe("Natural language description of what you are looking for"),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ query }) => {
    const database = await openDb();
    const result = await executeFind(database, { query });
    return {
      content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }],
    };
  },
);

// ── Server start ─────────────────────────────────────────────────────────────

/**
 * Start the MCP server on stdio transport.
 * Called when this module is run as the main entry point.
 */
export async function startServer(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Auto-start when run directly
const isMain = process.argv[1] && (process.argv[1].endsWith("/server.ts") || process.argv[1].endsWith("/server.js"));

if (isMain) {
  startServer().catch((err) => {
    process.stderr.write(`[clarte:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });
}

// Cleanup on exit
process.on("exit", () => {
  try {
    db?.close();
  } catch {
    // ignore
  }
});
