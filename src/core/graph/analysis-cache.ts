import { createHash } from "node:crypto";
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

import { CLARTE_DIR } from "../config/config.js";
import { BETWEENNESS_K } from "../config/thresholds.js";
import { openGraphStore } from "../../storage/loader.js";
import type { GraphStore } from "../../storage/graph-store.js";

export const ANALYSIS_CACHE_VERSION = 4;

const META_KEY = "analysis_cache_key";
const META_DATA_KEY = "analysis_cache_data";

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
  const sortedEdges = graph.edges
    .filter((e) => !e.isExternal)
    .map((e) => {
      const flags = `${e.importedNames.length}:${e.isTypeOnly ? 1 : 0}:${e.isDynamic ? 1 : 0}`;
      return `${e.from}>${e.to}:${flags}`;
    })
    .sort()
    .join("|");

  const externalCount = graph.edges.filter((e) => e.isExternal).length;
  const layersPart = layersConfig ? JSON.stringify(layersConfig) : "";

  return createHash("sha256")
    .update(sortedEdges + `|ext:${externalCount}|bk:${BETWEENNESS_K}` + layersPart)
    .digest("hex");
}

/**
 * Load the analysis cache from the meta table in graph.db.
 * Returns null if not found or version mismatch.
 */
export async function loadAnalysisCache(rootDir: string): Promise<AnalysisCacheData | null> {
  let store: GraphStore | null = null;
  try {
    store = await openGraphStore(rootDir);
    return loadAnalysisCacheFromStore(store);
  } catch {
    return null;
  } finally {
    store?.close();
  }
}

/**
 * Save the analysis cache to the meta table in graph.db.
 */
export async function saveAnalysisCache(rootDir: string, data: AnalysisCacheData): Promise<void> {
  const store = await openGraphStore(rootDir);
  try {
    saveAnalysisCacheToStore(store, data);
  } finally {
    store.close();
  }
}

export function loadAnalysisCacheFromStore(store: GraphStore): AnalysisCacheData | null {
  const cacheKey = store.getMeta(META_KEY);
  const cacheDataStr = store.getMeta(META_DATA_KEY);
  if (!cacheKey || !cacheDataStr) return null;

  try {
    const data = JSON.parse(cacheDataStr) as AnalysisCacheData;
    if (data.version !== ANALYSIS_CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveAnalysisCacheToStore(store: GraphStore, data: AnalysisCacheData): void {
  store.setMeta(META_KEY, data.cacheKey);
  store.setMeta(META_DATA_KEY, JSON.stringify(data));
}

// Keep CLARTE_DIR export for any code that imports it from here
export { CLARTE_DIR };
