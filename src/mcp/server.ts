import { execSync } from "node:child_process";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { loadPersistedGraph, checkStaleness } from "./persist.js";
import { handleInspect, handleImpact } from "./tools.js";

const TOOLS = [
  {
    name: "clarte_inspect",
    description:
      "Graph-derived context for a source file: role, instability, integration tests, co-change partners, chokepoint status, betweenness, community. Returns insights impossible for grep/read to compute.",
    inputSchema: {
      type: "object" as const,
      properties: {
        file: {
          type: "string",
          description: "Relative path to the source file",
        },
      },
      required: ["file"],
    },
  },
  {
    name: "clarte_impact",
    description:
      "After changing files, returns graph-exclusive effects grep cannot find: transitive integration tests, hidden co-change partners, risk assessment, community-crossing analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        files: {
          type: "array",
          items: { type: "string" },
          description: "Relative paths to changed files (1-10)",
          minItems: 1,
          maxItems: 10,
        },
      },
      required: ["files"],
    },
  },
];

/**
 * Start the MCP server on stdio.
 * Loads the persisted analysis graph and serves tool queries.
 */
export async function startMcpServer(rootDir: string): Promise<void> {
  const server = new Server({ name: "clarte", version: "1.0.0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    const graph = await loadPersistedGraph(rootDir);
    if (!graph) {
      return {
        content: [
          {
            type: "text" as const,
            text: "no analysis graph found. Run npx clarte to generate.",
          },
        ],
      };
    }

    // Check staleness
    let stalePrefix = "";
    let currentHead: string | undefined;
    try {
      currentHead = execSync("git rev-parse HEAD", {
        encoding: "utf-8",
        cwd: rootDir,
      }).trim();
    } catch {
      // git not available
    }
    const staleness = checkStaleness(graph, currentHead);
    if (staleness.isStale && staleness.reason) {
      stalePrefix = `\u26A0 ${staleness.reason}\n`;
    }

    let result: string;

    switch (name) {
      case "clarte_inspect": {
        const file = (args as { file: string }).file;
        result = handleInspect(graph, file);
        break;
      }
      case "clarte_impact": {
        const files = (args as { files: string[] }).files;
        result = handleImpact(graph, files);
        break;
      }
      default:
        result = `unknown tool: ${name}`;
    }

    return {
      content: [{ type: "text" as const, text: stalePrefix + result }],
    };
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
