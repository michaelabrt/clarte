import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ArchitecturalLayer,
  Chokepoint,
  CircularDependency,
  Community,
  CrossCuttingFile,
  FileInstability,
  GraphTopology,
  HubFile,
  ImportGraph,
  LayerConsistency,
  LayerEdge,
  TightCoupling,
} from "../types.js";

const CACHE_DIR = ".clarte";
const ANALYSIS_CACHE_FILE = "analysis-cache.json";

export const ANALYSIS_CACHE_VERSION = 3;

/** Cached graph-derived analysis results (deterministic given edges + config) */
export interface AnalysisCacheData {
  version: number;
  /** SHA-256 of sorted edge list + layers config */
  cacheKey: string;
  hubFiles: HubFile[];
  circularDeps: CircularDependency[];
  layers: ArchitecturalLayer[];
  layerEdges: LayerEdge[];
  instabilities: FileInstability[];
  communities: Community[];
  deadFiles: string[];
  crossCuttingFiles: CrossCuttingFile[];
  layerConsistency?: LayerConsistency;
  chokepoints: Chokepoint[];
  tightCouplings: TightCoupling[];
  graphTopology: GraphTopology;
}

/** Compute a cache key from graph edges and optional custom layer config */
export function computeAnalysisCacheKey(
  graph: ImportGraph,
  layersConfig?: Array<{ name: string; pattern: string }>,
): string {
  // Sort edges deterministically, including properties that affect analysis
  const sortedEdges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => {
      const flags = `${e.importedNames.length}:${e.isTypeOnly ? 1 : 0}:${e.isDynamic ? 1 : 0}`;
      return `${e.from}>${e.to}:${flags}`;
    })
    .sort()
    .join("|");

  // Count external edges so adding a new npm dependency invalidates the cache
  const externalCount = graph.edges.filter((e) => e.isExternal).length;

  const layersPart = layersConfig ? JSON.stringify(layersConfig) : "";

  // Include betweenness sample size so cache invalidates if the constant changes
  const BETWEENNESS_K = 50;
  return createHash("sha256")
    .update(sortedEdges + `|ext:${externalCount}|bk:${BETWEENNESS_K}` + layersPart)
    .digest("hex");
}

export async function loadAnalysisCache(rootDir: string): Promise<AnalysisCacheData | null> {
  const cachePath = path.join(rootDir, CACHE_DIR, ANALYSIS_CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw) as AnalysisCacheData;
    if (data.version !== ANALYSIS_CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveAnalysisCache(rootDir: string, data: AnalysisCacheData): Promise<void> {
  const dir = path.join(rootDir, CACHE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, ANALYSIS_CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
}
