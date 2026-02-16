import fs from "node:fs";
import path from "node:path";
import { runMcpServer } from "../mcp/server.js";
import { CLARTE_DIR } from "../config/config.js";

/**
 * Run the clarte MCP server.
 * Loads .clarte/graph.json and .clarte/call-graph.json into memory,
 * watches both for hot-reload, and serves via JSON-RPC over stdio.
 */
export async function runServeMode(rootDir: string): Promise<void> {
  const callGraphPath = path.join(rootDir, CLARTE_DIR, "call-graph.json");
  if (!fs.existsSync(callGraphPath)) {
    process.stderr.write(
      "[clarte] call-graph.json not found - clarte_calls will be unavailable. Run `clarte generate --mcp` to build it.\n",
    );
  }
  await runMcpServer(rootDir);
}
