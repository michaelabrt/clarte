import { formatContext, formatFunction, formatSearch, formatImpact } from "./format.js";
import type { ServerState } from "./server.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

export function handleContext(args: Record<string, unknown>, state: ServerState): ToolResult {
  const filePath = args.path;
  if (typeof filePath !== "string" || !filePath) {
    return err("path parameter is required");
  }
  if (!state.graph) {
    return err("graph not loaded: run clarte generate first");
  }
  const text = formatContext(filePath, state.graph, state.edgesByTarget);
  return ok(text);
}

export function handleFunction(args: Record<string, unknown>, state: ServerState): ToolResult {
  const name = args.name;
  if (typeof name !== "string" || !name) {
    return err("name parameter is required");
  }
  if (!state.callGraph) {
    return ok("call graph not available (run clarte generate to build it)");
  }
  const filePath = typeof args.path === "string" ? args.path : undefined;
  const text = formatFunction(name, filePath, state.callerIndex, state.fileCallIndex);
  return ok(text);
}

export function handleSearch(args: Record<string, unknown>, state: ServerState): ToolResult {
  const query = args.query;
  if (typeof query !== "string" || !query) {
    return err("query parameter is required");
  }
  if (!state.graph) {
    return err("graph not loaded: run clarte generate first");
  }
  const text = formatSearch(query, state.graph, state.edgesByTarget, state.fileCallIndex);
  return ok(text);
}

export function handleImpact(args: Record<string, unknown>, state: ServerState): ToolResult {
  const filePath = args.path;
  if (typeof filePath !== "string" || !filePath) {
    return err("path parameter is required");
  }
  if (!state.graph) {
    return err("graph not loaded: run clarte generate first");
  }
  const depth = typeof args.depth === "number" ? args.depth : undefined;
  const text = formatImpact(filePath, state.graph, state.edgesByTarget, depth);
  return ok(text);
}
