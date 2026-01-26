import path from "node:path";
import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import { readFileOr, writeFileSafe } from "../utils.js";
import { parseSource, initForLanguage } from "../parsers/init.js";
import { CLARTE_DIR } from "../config/config.js";
import type { ImportGraph, Language } from "../types.js";
import type { CallSite, PersistedCallGraph } from "../types/call-graph.js";

const CALL_GRAPH_PATH = `${CLARTE_DIR}/call-graph.json`;

const BUILTIN_GLOBALS = new Set([
  "console",
  "Object",
  "Array",
  "Math",
  "JSON",
  "Promise",
  "setTimeout",
  "setInterval",
  "clearTimeout",
  "clearInterval",
  "process",
  "Buffer",
  "require",
  "Symbol",
  "Error",
  "Map",
  "Set",
  "WeakMap",
  "WeakSet",
  "Date",
  "RegExp",
  "Number",
  "String",
  "Boolean",
  "parseInt",
  "parseFloat",
  "isNaN",
  "isFinite",
]);

const TS_JS_EXTENSIONS = new Set(["ts", "tsx", "js", "mjs", "jsx", "cjs"]);

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}

function extractCalleeName(node: Node): string | null {
  switch (node.type) {
    case "identifier":
      return node.text;
    case "property_identifier":
      return node.text;
    case "member_expression": {
      const prop = node.childForFieldName("property");
      return prop?.text ?? null;
    }
    default:
      return null;
  }
}

function getEnclosingFunctionName(node: Node): string {
  let current: Node | null = node.parent;
  while (current) {
    switch (current.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        return current.childForFieldName("name")?.text ?? "";
      }
      case "method_definition": {
        return current.childForFieldName("name")?.text ?? "";
      }
      case "arrow_function":
      case "function":
      case "generator_function": {
        const parent = current.parent;
        if (parent?.type === "variable_declarator") {
          return parent.childForFieldName("name")?.text ?? "";
        }
        if (parent?.type === "assignment_expression") {
          const left = parent.childForFieldName("left");
          return left?.type === "identifier" ? (left.text ?? "") : "";
        }
        return "";
      }
    }
    current = current.parent;
  }
  return "";
}

function extractCallSitesFromFile(
  content: string,
  filePath: string,
  language: Language,
  edgesByFile: Map<string, { to: string; importedNames: string[] }[]>,
): CallSite[] {
  const root = parseSource(content, language, filePath);
  const sites: CallSite[] = [];

  function processCallNode(node: Node, getCallee: () => Node | undefined): void {
    const calleeNode = getCallee();
    if (!calleeNode) return;

    const name = extractCalleeName(calleeNode);
    if (!name || name.length <= 1) return;
    if (BUILTIN_GLOBALS.has(name.split(".")[0] ?? name)) return;

    const calleeFile = resolveCallee(name, filePath, edgesByFile);
    if (!calleeFile) return;

    sites.push({
      caller: filePath,
      callerFn: getEnclosingFunctionName(node),
      callee: name,
      calleeFile,
      line: node.startPosition.row + 1,
    });
  }

  for (const call of root.descendantsOfType("call_expression")) {
    processCallNode(call, () => call.childForFieldName("function") ?? undefined);
  }

  for (const newExpr of root.descendantsOfType("new_expression")) {
    processCallNode(newExpr, () => newExpr.childForFieldName("constructor") ?? undefined);
  }

  return sites;
}

function resolveCallee(
  name: string,
  callerFile: string,
  edgesByFile: Map<string, { to: string; importedNames: string[] }[]>,
): string | null {
  const edges = edgesByFile.get(callerFile);
  if (!edges) return null;
  for (const edge of edges) {
    if (edge.importedNames.includes(name)) return edge.to;
  }
  return null;
}

/**
 * Build a call graph from a project's import graph.
 * Uses a separate tree-sitter pass independent from buildImportGraph
 * to preserve import graph cache integrity.
 */
export async function buildCallGraph(
  rootDir: string,
  graph: ImportGraph,
  files: string[],
  language: Language,
): Promise<PersistedCallGraph> {
  await initForLanguage(language);

  const previous = await loadCallGraph(rootDir);

  // Group previous sites by caller file for fast lookup
  const prevSitesByFile = new Map<string, CallSite[]>();
  if (previous) {
    for (const site of previous.sites) {
      if (!prevSitesByFile.has(site.caller)) prevSitesByFile.set(site.caller, []);
      prevSitesByFile.get(site.caller)!.push(site);
    }
  }

  // Build edgesByFile from import graph for callee resolution
  const edgesByFile = new Map<string, { to: string; importedNames: string[] }[]>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!edgesByFile.has(edge.from)) edgesByFile.set(edge.from, []);
    edgesByFile.get(edge.from)!.push({ to: edge.to, importedNames: edge.importedNames });
  }

  const newFileHashes: Record<string, string> = {};
  const allSites: CallSite[] = [];

  const tsFiles = files.filter((f) => {
    const ext = f.split(".").pop()?.toLowerCase();
    return ext !== undefined && TS_JS_EXTENSIONS.has(ext);
  });

  for (const file of tsFiles) {
    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const hash = hashContent(content);
    newFileHashes[file] = hash;

    if (previous?.fileHashes[file] === hash) {
      const prevSites = prevSitesByFile.get(file) ?? [];
      // Only reuse sites whose calleeFile is still reachable via the current edges.
      // If imports changed (edges removed/added), stale resolved sites must be dropped.
      const currentTargets = new Set((edgesByFile.get(file) ?? []).map((e) => e.to));
      allSites.push(...prevSites.filter((s) => s.calleeFile !== null && currentTargets.has(s.calleeFile)));
      continue;
    }

    try {
      const sites = extractCallSitesFromFile(content, file, language, edgesByFile);
      allSites.push(...sites);
    } catch {
      // Skip files that fail to parse
    }
  }

  return {
    version: 1,
    timestamp: new Date().toISOString(),
    sites: allSites,
    fileHashes: newFileHashes,
  };
}

/**
 * Persist the call graph to .clarte/call-graph.json.
 */
export async function persistCallGraph(rootDir: string, callGraph: PersistedCallGraph): Promise<void> {
  const filePath = path.join(rootDir, CALL_GRAPH_PATH);
  await writeFileSafe(filePath, JSON.stringify(callGraph));
}

/**
 * Load a persisted call graph from .clarte/call-graph.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadCallGraph(rootDir: string): Promise<PersistedCallGraph | null> {
  const filePath = path.join(rootDir, CALL_GRAPH_PATH);
  const content = await readFileOr(filePath);
  if (!content) return null;

  try {
    const parsed = JSON.parse(content) as PersistedCallGraph;
    if (parsed.version !== 1) return null;
    if (!Array.isArray(parsed.sites)) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Build in-memory callerIndex from persisted call graph sites.
 * Key format: "${calleeFile}::${calleeName}"
 */
export function buildCallerIndex(sites: CallSite[]): Map<string, CallSite[]> {
  const index = new Map<string, CallSite[]>();
  for (const site of sites) {
    if (!site.calleeFile) continue;
    const key = `${site.calleeFile}::${site.callee}`;
    if (!index.has(key)) index.set(key, []);
    index.get(key)!.push(site);
  }
  return index;
}

/**
 * Build in-memory fileCallIndex from persisted call graph sites.
 * Key: caller file path, Value: all call sites from that file.
 */
export function buildFileCallIndex(sites: CallSite[]): Map<string, CallSite[]> {
  const index = new Map<string, CallSite[]>();
  for (const site of sites) {
    if (!index.has(site.caller)) index.set(site.caller, []);
    index.get(site.caller)!.push(site);
  }
  return index;
}
