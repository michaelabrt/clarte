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
import { statSync } from "node:fs";
import { availableParallelism } from "node:os";
import { createReadonlyDatabase } from "../storage/db-adapter";
import { executeCallers } from "./tools/callers";
import { executeImpact } from "./tools/impact";
import { executeFind } from "./tools/find";
import { executeSafe } from "./tools/safe";
import type { DatabaseAdapter } from "../storage/db-adapter";

// ── Connection pool (Dean & Stonebraker) ─────────────────────────────────────

/**
 * [Dean & Stonebraker] Read-only connection pool scaled to CPU core count (RFC §4.1).
 * Each connection is an independent SQLite handle in read-only mode.
 * WAL allows concurrent readers; the pool prepares for async transports (SSE/WS)
 * while functioning as a round-robin singleton under serial STDIO.
 */
class ReadPool {
  private connections: DatabaseAdapter[] = [];
  private nextIdx = 0;
  readonly dbPath: string;
  mtimeMs: number;

  private constructor(dbPath: string, mtimeMs: number) {
    this.dbPath = dbPath;
    this.mtimeMs = mtimeMs;
  }

  get size(): number {
    return this.connections.length;
  }

  static async create(dbPath: string): Promise<ReadPool> {
    const mtimeMs = statSync(dbPath).mtimeMs;
    const pool = new ReadPool(dbPath, mtimeMs);
    // Cap at 4: SQLite WAL readers share a single file lock; beyond 4,
    // page cache thrashing outweighs concurrency gains.
    const size = Math.min(availableParallelism(), 4);
    for (let i = 0; i < size; i++) {
      pool.connections.push(await createReadonlyDatabase(dbPath));
    }
    return pool;
  }

  /** Round-robin acquire. Callers do not need to release. */
  acquire(): DatabaseAdapter {
    const conn = this.connections[this.nextIdx % this.connections.length];
    this.nextIdx++;
    return conn;
  }

  close(): void {
    for (const conn of this.connections) conn.close();
    this.connections = [];
  }
}

// ── Database lifecycle ───────────────────────────────────────────────────────

let pool: ReadPool | null = null;

/**
 * Acquire a read-only connection from the pool.
 * Pool is lazily initialized on first call, sized to min(cpuCount, 4).
 * Recreated when the DB file's mtime changes (after clarte init/refresh).
 */
async function openDb(): Promise<DatabaseAdapter> {
  const rootDir = process.env.CLARTE_ROOT ?? process.cwd();
  const dbPath = path.join(rootDir, ".clarte", "graph.db");

  if (pool) {
    let stale = false;
    try {
      stale = statSync(dbPath).mtimeMs !== pool.mtimeMs;
    } catch {
      stale = true;
    }
    if (stale) {
      pool.close();
      pool = null;
    }
  }

  if (!pool) {
    pool = await ReadPool.create(dbPath);
  }
  return pool.acquire();
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
      max_results: z
        .number()
        .optional()
        .describe("Cap per category (default: unlimited). Use to prevent token overflow in large repos."),
      summary: z
        .boolean()
        .optional()
        .describe("When true, returns file paths and counts only (no rationale detail). Default: false."),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ file, max_results, summary }) => {
    const database = await openDb();
    const result = executeImpact(database, { file, maxResults: max_results, summary });
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

// ── Tool: clarte_safe ──────────────────────────────────────────────────────

server.registerTool(
  "clarte_safe",
  {
    description:
      "Verify whether a proposed change is safe. Given a symbol, its file, and the type of change (signature/body/delete), returns a verified impact proof classifying each dependent as BREAKS, COMPATIBLE, or UNKNOWN with evidence citations (line numbers, edge types, confidence scores). Use before modifying a function to know exactly what will break.",
    inputSchema: {
      symbol: z.string().describe("The symbol name to analyze (e.g. 'validateSession')"),
      file: z.string().describe("The file containing the symbol (e.g. 'src/auth/session.ts')"),
      change: z
        .enum(["signature", "body", "delete"])
        .describe(
          "Type of change: 'signature' (parameters/return type), 'body' (internal logic), or 'delete' (remove entirely)",
        ),
    },
    annotations: { readOnlyHint: true },
  },
  async ({ symbol, file, change }) => {
    const database = await openDb();
    const result = executeSafe(database, { symbol, file, change });
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

// Auto-start when run directly (handles both source and tsup-renamed output)
const scriptName = process.argv[1] ? path.basename(process.argv[1]) : "";
const isMain = /^(mcp-)?server\.[jt]s$/.test(scriptName);

if (isMain) {
  startServer().catch((err) => {
    process.stderr.write(`[clarte:mcp] Fatal: ${err}\n`);
    process.exit(1);
  });
}

// Cleanup on exit
process.on("exit", () => {
  try {
    pool?.close();
  } catch {
    // ignore
  }
});
