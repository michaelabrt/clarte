import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { CLARTE_DIR } from "../config/config.js";
import { errorMessage } from "../utils.js";
import { loadPersistedGraph } from "../graph/persist.js";
import { loadCallGraph, buildCallerIndex, buildFileCallIndex } from "../graph/build-call-graph.js";
import type { EdgeRecord } from "../types/persisted-graph.js";
import { VERSION } from "../cli/args.js";
import { handleScope, handleFunction, handleImpact, handleRoute } from "./tools.js";
import type { EdgeEntry, ServerState } from "./types.js";

export type { EdgeEntry, ServerState };

const GRAPH_PATH = path.join(CLARTE_DIR, "graph.json");
const CALL_GRAPH_PATH = path.join(CLARTE_DIR, "call-graph.json");

const MCP_INSTRUCTIONS =
  "clarte provides code graph tools for this project. See CLAUDE.md for usage instructions.\n" +
  "Tools: clarte_route, clarte_scope, clarte_calls, clarte_impact.";

function buildEdgesByTarget(edges: EdgeRecord[]): Map<string, EdgeEntry[]> {
  const edgesByTarget = new Map<string, EdgeEntry[]>();
  for (const edge of edges) {
    if (!edgesByTarget.has(edge.to)) edgesByTarget.set(edge.to, []);
    edgesByTarget.get(edge.to)?.push({ from: edge.from, to: edge.to, importedNames: edge.importedNames ?? [] });
  }
  return edgesByTarget;
}

function getMtime(filePath: string): number {
  try {
    return fs.statSync(filePath).mtimeMs;
  } catch {
    return 0;
  }
}

export async function loadServerState(rootDir: string): Promise<ServerState> {
  const graph = await loadPersistedGraph(rootDir);
  const callGraph = await loadCallGraph(rootDir);

  const edges = graph?.edges ?? [];
  const edgesByTarget = buildEdgesByTarget(edges);
  const callerIndex = callGraph ? buildCallerIndex(callGraph.sites) : new Map();
  const fileCallIndex = callGraph ? buildFileCallIndex(callGraph.sites) : new Map();

  return {
    rootDir,
    graph,
    callGraph,
    callerIndex,
    fileCallIndex,
    edgesByTarget,
    graphMtime: getMtime(path.join(rootDir, GRAPH_PATH)),
    callGraphMtime: getMtime(path.join(rootDir, CALL_GRAPH_PATH)),
  };
}

function watchGraphFiles(rootDir: string, state: ServerState): void {
  const graphAbsPath = path.join(rootDir, GRAPH_PATH);
  const callGraphAbsPath = path.join(rootDir, CALL_GRAPH_PATH);

  async function reloadAll(): Promise<void> {
    const newGraph = await loadPersistedGraph(rootDir);
    const newCallGraph = await loadCallGraph(rootDir);

    const edges = newGraph?.edges ?? [];
    const edgesByTarget = buildEdgesByTarget(edges);
    const callerIndex = newCallGraph ? buildCallerIndex(newCallGraph.sites) : new Map();
    const fileCallIndex = newCallGraph ? buildFileCallIndex(newCallGraph.sites) : new Map();

    state.graph = newGraph;
    state.callGraph = newCallGraph;
    state.edgesByTarget = edgesByTarget;
    state.callerIndex = callerIndex;
    state.fileCallIndex = fileCallIndex;
    // Update only the mtime of the files we just reloaded
    state.graphMtime = getMtime(graphAbsPath);
    state.callGraphMtime = getMtime(callGraphAbsPath);
  }

  fs.watchFile(graphAbsPath, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      reloadAll().catch((err) => {
        process.stderr.write(`[clarte] hot-reload failed: ${errorMessage(err)}\n`);
      });
    }
  });
  fs.watchFile(callGraphAbsPath, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      reloadAll().catch((err) => {
        process.stderr.write(`[clarte] hot-reload failed: ${errorMessage(err)}\n`);
      });
    }
  });

  process.on("exit", () => {
    fs.unwatchFile(graphAbsPath);
    fs.unwatchFile(callGraphAbsPath);
  });
}

const TOOLS: Tool[] = [
  {
    name: "clarte_route",
    description:
      "Call this as your FIRST action before reading or searching any files. Returns the single " +
      "file most likely to need editing, based on past commit history. Go directly to that file " +
      "and start editing - do not Grep, Glob or Read other files first.",
    inputSchema: {
      type: "object",
      properties: {
        task: {
          type: "string",
          description: "Natural language task description (e.g. fix SQLite enum array bug)",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "clarte_scope",
    description:
      "Returns co-change partners and test file for a source file. Call this AFTER " +
      "finding a file you intend to edit, to see what else typically changes alongside " +
      "it and where the tests are. Do NOT call twice for the same file in one session.",
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative file path (e.g. src/utils.ts)" },
      },
      required: ["path"],
    },
  },
  {
    name: "clarte_calls",
    description:
      "Returns all call sites of a function (who calls it) and all functions it calls " +
      "(what it invokes), with file paths and line numbers. Call this BEFORE renaming, " +
      "removing, or changing the signature of any function. Do NOT call for trivial " +
      "one-line functions.",
    inputSchema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Function or method name (e.g. buildImportGraph)" },
        path: {
          type: "string",
          description: "File path to disambiguate if name is not unique (optional)",
        },
      },
      required: ["name"],
    },
  },
  {
    name: "clarte_impact",
    description:
      "Returns every file that transitively depends on this file - the full blast radius " +
      "of an API change - ranked by distance. Call this BEFORE removing an export, " +
      "changing a public type signature, or refactoring a widely-imported utility. " +
      "Do NOT call for leaf files with zero importers.",
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "Relative file path to assess impact for",
        },
        depth: {
          type: "number",
          description: "Max traversal depth (default: unlimited)",
        },
      },
      required: ["path"],
    },
  },
];

export async function createMcpServer(rootDir: string): Promise<{ server: Server; state: ServerState }> {
  const state = await loadServerState(rootDir);
  watchGraphFiles(rootDir, state);

  const server = new Server(
    { name: "clarte", version: VERSION },
    {
      capabilities: { tools: {} },
      instructions: MCP_INSTRUCTIONS,
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const safeArgs = (args ?? {}) as Record<string, unknown>;

    // clarte_route works without a graph (git history is sufficient)
    if (name === "clarte_route") {
      return handleRoute(safeArgs, state);
    }

    if (!state.graph) {
      return {
        content: [{ type: "text" as const, text: "graph not loaded: run clarte generate first" }],
        isError: true,
      };
    }

    switch (name) {
      case "clarte_scope":
        return handleScope(safeArgs, state);
      case "clarte_calls":
        return handleFunction(safeArgs, state);
      case "clarte_impact":
        return handleImpact(safeArgs, state);
      default:
        return {
          content: [{ type: "text" as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  });

  return { server, state };
}

export async function runMcpServer(rootDir: string): Promise<void> {
  const { server } = await createMcpServer(rootDir);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
