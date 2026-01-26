import { runMcpServer } from "../mcp/server.js";

/**
 * Run the clarte MCP server.
 * Loads .clarte/graph.json and .clarte/call-graph.json into memory,
 * watches both for hot-reload, and serves via JSON-RPC over stdio.
 */
export async function runServeMode(rootDir: string): Promise<void> {
  await runMcpServer(rootDir);
}
