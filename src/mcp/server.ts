import fs from "node:fs";
import path from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { CLARTE_DIR } from "../config/config.js";
import { loadPersistedGraph } from "../graph/persist.js";
import { loadCallGraph, buildCallerIndex, buildFileCallIndex } from "../graph/build-call-graph.js";
import type { PersistedGraph, EdgeRecord } from "../types/persisted-graph.js";
import type { PersistedCallGraph, CallerIndex, FileCallIndex } from "../types/call-graph.js";
import { VERSION } from "../cli/args.js";
import { handleFunction, handleSearch, handleImpact } from "./tools.js";

const GRAPH_PATH = path.join(CLARTE_DIR, "graph.json");
const CALL_GRAPH_PATH = path.join(CLARTE_DIR, "call-graph.json");

const MCP_INSTRUCTIONS =
  "clarte provides code graph tools for this project. See CLAUDE.md for usage instructions.\n" +
  "Tools: clarte_context, clarte_function, clarte_search, clarte_impact.";

export interface EdgeEntry {
  from: string;
  to: string;
  importedNames: string[];
}

export interface ServerState {
  graph: PersistedGraph | null;
  callGraph: PersistedCallGraph | null;
  callerIndex: CallerIndex;
  fileCallIndex: FileCallIndex;
  edgesByTarget: Map<string, EdgeEntry[]>;
  graphMtime: number;
  callGraphMtime: number;
}

function buildEdgesByTarget(edges: EdgeRecord[]): Map<string, EdgeEntry[]> {
  const edgesByTarget = new Map<string, EdgeEntry[]>();
  for (const edge of edges) {
    if (!edgesByTarget.has(edge.to)) edgesByTarget.set(edge.to, []);
    edgesByTarget.get(edge.to)!.push({ from: edge.from, to: edge.to, importedNames: edge.importedNames ?? [] });
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
        process.stderr.write(`[clarte] hot-reload failed: ${err instanceof Error ? err.message : String(err)}\n`);
      });
    }
  });
  fs.watchFile(callGraphAbsPath, { interval: 2000 }, (curr, prev) => {
    if (curr.mtimeMs !== prev.mtimeMs) {
      reloadAll().catch((err) => {
        process.stderr.write(`[clarte] hot-reload failed: ${err instanceof Error ? err.message : String(err)}\n`);
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
    name: "clarte_function",
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
    name: "clarte_search",
    description:
      "Fuzzy search across file paths and exported symbol names in the project graph. " +
      "Returns ranked matches with file paths. Call this when you know a concept or " +
      "symbol name but not where it lives. Do NOT use for content search (use Grep " +
      "for that); this searches names and paths only.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Symbol name or file path fragment to search for",
        },
      },
      required: ["query"],
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

    if (!state.graph) {
      return {
        content: [{ type: "text" as const, text: "graph not loaded: run clarte generate first" }],
        isError: true,
      };
    }

    switch (name) {
      case "clarte_function":
        return handleFunction(safeArgs, state);
      case "clarte_search":
        return handleSearch(safeArgs, state);
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
