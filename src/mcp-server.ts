#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { detectContext, enrichFrameworksWithUsage } from "./detect.js";
import {
  buildImportGraph,
  getHubFiles,
  findCircularDeps,
  detectArchitecturalLayers,
  computeInstability,
  detectCommunities,
  findDeadFiles,
  findCrossCuttingFiles,
  computeLayerConsistency,
  findChokepoints,
  computeGraphTopology,
  findStructuralTemporalMismatches,
  findTightCouplings,
} from "./graph.js";
import { buildGraphWithCache } from "./cache.js";
import { analyzeGitActivity } from "./git-analysis.js";
import { scanConfigConstraints } from "./config-scan.js";
import { inferConventions } from "./conventions.js";
import { buildTestMapping } from "./test-map.js";
import { loadConfig, configToAnswers } from "./config.js";
import { buildSections, applyBudget } from "./templates/main-context.js";
import type {
  ContextAnalysis,
  DetectedContext,
  HubFile,
  ImportGraph,
  ProgressCallback,
  CircularDependency,
  ArchitecturalLayer,
  LayerConsistency,
  ChangeCoupling,
} from "./types.js";

// ── Query function types ──────────────────────────────────────────────

export interface FileInfo {
  path: string;
  hubData: HubFile | null;
  layer: string | null;
  importedBy: string[];
  imports: string[];
  relatedTests: string[];
  changePartners: ChangeCoupling[];
  circularDeps: CircularDependency[];
}

// ── Query functions (pure, testable) ──────────────────────────────────

export function queryHubFiles(
  analysis: ContextAnalysis,
  limit?: number,
  minCentrality?: number,
): HubFile[] {
  let files = [...analysis.hubFiles];
  if (minCentrality !== undefined) {
    files = files.filter((f) => f.centrality >= minCentrality);
  }
  files.sort((a, b) => b.centrality - a.centrality);
  return files.slice(0, limit ?? 10);
}

export function queryFileInfo(
  filePath: string,
  analysis: ContextAnalysis,
  graph: ImportGraph,
): FileInfo | null {
  // Normalize path for matching
  const normalized = filePath.replace(/^\.\//, "");

  // Check if the file exists in the graph at all
  const inGraph =
    graph.edges.some((e) => e.from === normalized || e.to === normalized) ||
    graph.inDegree.has(normalized);
  const inAnalysis = analysis.hubFiles.some((h) => h.path === normalized);

  if (!inGraph && !inAnalysis) return null;

  const hubData = analysis.hubFiles.find((h) => h.path === normalized) ?? null;

  const layer =
    analysis.layers.find((l) => l.files.includes(normalized))?.name ?? null;

  const importedBy = graph.edges
    .filter((e) => e.to === normalized && !e.isExternal)
    .map((e) => e.from);

  const imports = graph.edges
    .filter((e) => e.from === normalized && !e.isExternal)
    .map((e) => e.to);

  const relatedTests =
    analysis.testMapping?.sourceToTests.get(normalized) ?? [];

  const changePartners = (analysis.gitActivity?.changeCoupling ?? []).filter(
    (c) => c.fileA === normalized || c.fileB === normalized,
  );

  const circularDeps = analysis.circularDeps.filter((c) =>
    c.chain.includes(normalized),
  );

  return {
    path: normalized,
    hubData,
    layer,
    importedBy,
    imports,
    relatedTests,
    changePartners,
    circularDeps,
  };
}

export function queryWhatImports(
  filePath: string,
  graph: ImportGraph,
): string[] {
  const normalized = filePath.replace(/^\.\//, "");
  return graph.edges
    .filter((e) => e.to === normalized && !e.isExternal)
    .map((e) => e.from);
}

export function queryWhatDoesImport(
  filePath: string,
  graph: ImportGraph,
): string[] {
  const normalized = filePath.replace(/^\.\//, "");
  return graph.edges
    .filter((e) => e.from === normalized && !e.isExternal)
    .map((e) => e.to);
}

export function queryCircularDeps(
  analysis: ContextAnalysis,
  involving?: string,
): CircularDependency[] {
  if (!involving) return analysis.circularDeps;
  const normalized = involving.replace(/^\.\//, "");
  return analysis.circularDeps.filter((c) => c.chain.includes(normalized));
}

export function queryLayers(
  analysis: ContextAnalysis,
): {
  layers: ArchitecturalLayer[];
  layerConsistency: LayerConsistency | undefined;
} {
  return {
    layers: analysis.layers,
    layerConsistency: analysis.layerConsistency,
  };
}

export function queryLayerFor(
  filePath: string,
  analysis: ContextAnalysis,
): { name: string; layer: ArchitecturalLayer } | null {
  const normalized = filePath.replace(/^\.\//, "");
  const layer = analysis.layers.find((l) => l.files.includes(normalized));
  if (!layer) return null;
  return { name: layer.name, layer };
}

export function queryRelatedTests(
  filePath: string,
  analysis: ContextAnalysis,
): string[] {
  const normalized = filePath.replace(/^\.\//, "");
  return analysis.testMapping?.sourceToTests.get(normalized) ?? [];
}

export function queryChangePartners(
  filePath: string,
  analysis: ContextAnalysis,
): ChangeCoupling[] {
  const normalized = filePath.replace(/^\.\//, "");
  return (analysis.gitActivity?.changeCoupling ?? []).filter(
    (c) => c.fileA === normalized || c.fileB === normalized,
  );
}

// ── Analysis pipeline ─────────────────────────────────────────────────

async function runAnalysis(rootDir: string): Promise<{
  analysis: ContextAnalysis;
  graph: ImportGraph;
  ctx: DetectedContext;
}> {
  const noopProgress: ProgressCallback = () => {};

  const config = await loadConfig(rootDir);
  const answers = config ? configToAnswers(config) : undefined;

  // Detect context
  const ctx = await detectContext(rootDir, noopProgress);

  // Build import graph (with cache)
  const graph = await buildGraphWithCache(rootDir, ctx.language, noopProgress);

  // Merge secondary language graphs
  if (ctx.secondaryLanguages) {
    for (const secLang of ctx.secondaryLanguages) {
      const secGraph = await buildImportGraph(rootDir, secLang, noopProgress);
      graph.edges.push(...secGraph.edges);
      for (const [k, v] of secGraph.inDegree) {
        graph.inDegree.set(k, (graph.inDegree.get(k) ?? 0) + v);
      }
      for (const [k, v] of secGraph.centrality) {
        if (!graph.centrality.has(k)) graph.centrality.set(k, v);
      }
      for (const [k, v] of secGraph.externalImportCounts) {
        graph.externalImportCounts.set(
          k,
          (graph.externalImportCounts.get(k) ?? 0) + v,
        );
      }
      for (const [k, v] of secGraph.authority) {
        if (!graph.authority.has(k)) graph.authority.set(k, v);
      }
      for (const [k, v] of secGraph.hubScores) {
        if (!graph.hubScores.has(k)) graph.hubScores.set(k, v);
      }
    }
  }

  // Enrich frameworks with usage counts
  ctx.frameworks = enrichFrameworksWithUsage(
    ctx.frameworks,
    graph.externalImportCounts,
  );

  // Run full analysis pipeline
  const hubFiles = getHubFiles(graph);
  const circularDeps = findCircularDeps(graph);
  const { layers, layerEdges } = detectArchitecturalLayers(
    graph,
    answers?.layers,
  );
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const gitActivity = ctx.isGitRepo
    ? analyzeGitActivity(rootDir, noopProgress)
    : null;
  const deadFiles = findDeadFiles(graph);
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers);
  const layerConsistency =
    layers.length >= 2
      ? computeLayerConsistency(graph, layers, layerEdges)
      : undefined;
  const chokepoints = findChokepoints(graph);
  const configConstraints = await scanConfigConstraints(rootDir, ctx);
  const conventions = await inferConventions(rootDir, graph, configConstraints);
  const testMapping = buildTestMapping(graph, ctx);
  const graphTopology = computeGraphTopology(graph);
  const structuralMismatches = gitActivity
    ? findStructuralTemporalMismatches(graph, gitActivity.changeCoupling)
    : undefined;
  const tightCouplings = findTightCouplings(graph);

  const analysis: ContextAnalysis = {
    hubFiles,
    circularDeps,
    layers,
    layerEdges,
    gitActivity,
    instabilities,
    communities,
    deadFiles,
    configConstraints,
    crossCuttingFiles,
    layerConsistency,
    chokepoints,
    conventions: conventions ?? undefined,
    testMapping: testMapping ?? undefined,
    graphTopology,
    structuralMismatches: structuralMismatches?.length
      ? structuralMismatches
      : undefined,
    tightCouplings: tightCouplings.length ? tightCouplings : undefined,
  };

  return { analysis, graph, ctx };
}

// ── Tool definitions ──────────────────────────────────────────────────

const TOOLS = [
  {
    name: "get_hub_files",
    description:
      "Get the most interconnected files in the codebase, ranked by HITS authority score. Returns path, centrality, authority, hub score, role, and import counts.",
    inputSchema: {
      type: "object" as const,
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of results (default: 10)",
        },
        min_centrality: {
          type: "number",
          description:
            "Minimum centrality threshold (0-1) to filter results",
        },
      },
    },
  },
  {
    name: "get_file_info",
    description:
      "Get full architectural analysis for a single file: role, centrality, imports, importers, layer, related tests, co-change partners, and circular dependencies.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "what_imports",
    description:
      "Find all files that import the given file (reverse dependency lookup).",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "what_does_import",
    description:
      "Find all files that the given file imports (forward dependency lookup).",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "find_circular_deps",
    description:
      "Find circular dependency chains in the codebase, optionally filtered to those involving a specific file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        involving: {
          type: "string",
          description:
            "Optional file path to filter cycles involving this file",
        },
      },
    },
  },
  {
    name: "get_layers",
    description:
      "Get all architectural layers with their files, inter-layer dependencies, and layer consistency score.",
    inputSchema: {
      type: "object" as const,
      properties: {},
    },
  },
  {
    name: "get_layer_for",
    description:
      "Find which architectural layer a file belongs to.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_related_tests",
    description:
      "Find test files associated with a given source file.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_change_partners",
    description:
      "Find files that frequently co-change with the given file based on git history analysis.",
    inputSchema: {
      type: "object" as const,
      properties: {
        path: { type: "string", description: "Relative file path" },
      },
      required: ["path"],
    },
  },
  {
    name: "get_architecture_summary",
    description:
      "Get a token-budgeted text summary of the project architecture.",
    inputSchema: {
      type: "object" as const,
      properties: {
        max_tokens: {
          type: "number",
          description: "Token budget for the summary (default: 4000)",
        },
      },
    },
  },
];

// ── Server startup ────────────────────────────────────────────────────

async function main() {
  const rootDir = process.cwd();

  // Run analysis pipeline on startup
  let state: {
    analysis: ContextAnalysis;
    graph: ImportGraph;
    ctx: DetectedContext;
  } | null = null;
  let analysisError: string | null = null;

  try {
    state = await runAnalysis(rootDir);
  } catch (err) {
    analysisError = err instanceof Error ? err.message : String(err);
  }

  // Create MCP server
  const server = new Server(
    { name: "clarte", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  // List tools handler
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // Call tool handler
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (!state) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              error: analysisError ?? "Analysis not ready",
            }),
          },
        ],
      };
    }

    const { analysis, graph, ctx } = state;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;

    const json = (data: unknown) => ({
      content: [{ type: "text" as const, text: JSON.stringify(data) }],
    });

    switch (request.params.name) {
      case "get_hub_files": {
        const result = queryHubFiles(
          analysis,
          args.limit as number | undefined,
          args.min_centrality as number | undefined,
        );
        return json(result);
      }

      case "get_file_info": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryFileInfo(filePath, analysis, graph);
        if (!result) {
          return json({
            error: "File not found in analysis",
            path: filePath,
          });
        }
        return json(result);
      }

      case "what_imports": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryWhatImports(filePath, graph);
        return json({ path: filePath, importedBy: result });
      }

      case "what_does_import": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryWhatDoesImport(filePath, graph);
        return json({ path: filePath, imports: result });
      }

      case "find_circular_deps": {
        const result = queryCircularDeps(
          analysis,
          args.involving as string | undefined,
        );
        return json(result);
      }

      case "get_layers": {
        const result = queryLayers(analysis);
        return json(result);
      }

      case "get_layer_for": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryLayerFor(filePath, analysis);
        if (!result) {
          return json({
            error: "File not found in any architectural layer",
            path: filePath,
          });
        }
        return json(result);
      }

      case "get_related_tests": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryRelatedTests(filePath, analysis);
        return json({ path: filePath, tests: result });
      }

      case "get_change_partners": {
        const filePath = args.path as string;
        if (!filePath) return json({ error: "Missing required parameter: path" });
        const result = queryChangePartners(filePath, analysis);
        return json({ path: filePath, changePartners: result });
      }

      case "get_architecture_summary": {
        const budget = (args.max_tokens as number) ?? 4000;
        const config = await loadConfig(rootDir);
        const answers = config
          ? configToAnswers(config)
          : {
              ides: [],
              projectPurpose: "",
              keyPatterns: "",
              gotchas: "",
              generateSnapshot: false,
              snapshotPaths: [],
              stackConfirmed: true,
              stackCorrections: "",
              generatePerPackage: false,
            };

        const sections = await buildSections(ctx, answers, null, analysis);
        const { included } = applyBudget(sections, budget);
        const summary = included
          .map((s) => s.content)
          .join("\n\n")
          .trimEnd();
        return json({ summary, tokenBudget: budget });
      }

      default:
        return json({ error: `Unknown tool: ${request.params.name}` });
    }
  });

  // Connect via stdio transport
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`clarte-mcp: ${err}\n`);
  process.exit(1);
});
