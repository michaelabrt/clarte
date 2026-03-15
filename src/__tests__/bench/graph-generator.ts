/**
 * Synthetic graph generator for performance benchmarks.
 *
 * Produces realistic-looking ImportGraph instances with power-law degree
 * distributions (some hub files, many leaf files), both internal and
 * external edges, and fully populated metadata maps.
 */

import type { ImportEdge, ImportGraph } from "../../core/types.js";
import { computeHITS } from "../../core/graph/centrality.js";

// ── Seeded PRNG (xorshift32) ────────────────────────────────────────

function xorshift32(seed: number): () => number {
  let state = seed | 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
}

// ── Plausible file path generation ──────────────────────────────────

const DIRS = [
  "src/components",
  "src/hooks",
  "src/utils",
  "src/services",
  "src/stores",
  "src/pages",
  "src/types",
  "src/lib",
  "src/api",
  "src/config",
];

const EXTERNAL_PACKAGES = ["react", "lodash", "axios", "zod", "date-fns", "uuid", "chalk", "express", "path", "fs"];

const SYMBOL_POOL = [
  "fetchUser",
  "handleRequest",
  "validateInput",
  "formatResponse",
  "parseConfig",
  "createRouter",
  "useAuth",
  "getSession",
  "renderPage",
  "loadModule",
  "buildQuery",
  "mapResults",
  "filterItems",
  "sortEntries",
  "mergeDefaults",
  "initDatabase",
  "closeConnection",
  "runMigration",
  "seedData",
  "resetState",
  "encryptPayload",
  "decryptToken",
  "hashPassword",
  "verifySignature",
  "generateKey",
  "logError",
  "warnDeprecated",
  "trackEvent",
  "measureLatency",
  "reportMetric",
  "readConfig",
  "writeCache",
  "deleteRecord",
  "updateProfile",
  "patchSettings",
  "transformData",
  "normalizeInput",
  "sanitizeHtml",
  "escapeRegex",
  "debounceCall",
];

function generateFilePaths(count: number, rng: () => number): string[] {
  const files: string[] = [];
  for (let i = 0; i < count; i++) {
    const dir = DIRS[Math.floor(rng() * DIRS.length)];
    files.push(`${dir}/File${i}.ts`);
  }
  return files;
}

// ── Power-law edge generation ───────────────────────────────────────

/**
 * Generate edges following a power-law distribution.
 * Hub files (low indices) get more outgoing edges; popular targets
 * (also power-law distributed) get more incoming edges.
 */
function generateEdges(files: string[], density: number, rng: () => number): ImportEdge[] {
  const n = files.length;
  const targetEdgeCount = Math.floor(n * density);
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  // Pre-compute power-law weights for targets (incoming popularity)
  const targetWeights = files.map((_, i) => 1 / (i + 1) ** 1.2);
  const totalTargetWeight = targetWeights.reduce((a, b) => a + b, 0);
  const cumulativeTarget: number[] = [];
  let cumSum = 0;
  for (const w of targetWeights) {
    cumSum += w / totalTargetWeight;
    cumulativeTarget.push(cumSum);
  }

  function pickTarget(): number {
    const r = rng();
    for (let i = 0; i < cumulativeTarget.length; i++) {
      if (r <= cumulativeTarget[i]) return i;
    }
    return cumulativeTarget.length - 1;
  }

  // Generate internal edges
  const internalCount = Math.floor(targetEdgeCount * 0.85);
  let attempts = 0;
  while (edges.length < internalCount && attempts < internalCount * 5) {
    attempts++;
    // Source: power-law biased toward hub files (low indices)
    const srcIdx = Math.floor(rng() ** 1.2 * n);
    const tgtIdx = pickTarget();
    if (srcIdx === tgtIdx) continue;

    const key = `${srcIdx}->${tgtIdx}`;
    if (seen.has(key)) continue;
    seen.add(key);

    const importedNames = generateImportNames(rng);
    edges.push({
      from: files[srcIdx],
      to: files[tgtIdx],
      isExternal: false,
      specifier: `./${files[tgtIdx]}`,
      importedNames,
      isTypeOnly: rng() < 0.15,
      isDynamic: rng() < 0.05,
    });
  }

  // Generate external edges (15% of total)
  const externalCount = targetEdgeCount - internalCount;
  for (let i = 0; i < externalCount; i++) {
    const srcIdx = Math.floor(rng() * n);
    const pkg = EXTERNAL_PACKAGES[Math.floor(rng() * EXTERNAL_PACKAGES.length)];
    edges.push({
      from: files[srcIdx],
      to: pkg,
      isExternal: true,
      specifier: pkg,
      importedNames: [pkg],
    });
  }

  return edges;
}

function generateImportNames(rng: () => number): string[] {
  const count = Math.floor(rng() * 4) + 1;
  const names: string[] = [];
  for (let i = 0; i < count; i++) {
    names.push(SYMBOL_POOL[Math.floor(rng() * SYMBOL_POOL.length)]);
  }
  return names;
}

// ── Main generator ──────────────────────────────────────────────────

/**
 * Generate a synthetic ImportGraph with realistic structure.
 *
 * @param nodeCount - Number of files in the graph
 * @param edgeDensity - Average number of edges per node (default: 3)
 * @param seed - PRNG seed for reproducibility (default: 42)
 */
export function generateGraph(nodeCount: number, edgeDensity = 3, seed = 42): ImportGraph {
  const rng = xorshift32(seed);
  const files = generateFilePaths(nodeCount, rng);
  const edges = generateEdges(files, edgeDensity, rng);

  // Compute inDegree
  const inDegree = new Map<string, number>();
  for (const f of files) inDegree.set(f, 0);
  for (const e of edges) {
    if (!e.isExternal) {
      inDegree.set(e.to, (inDegree.get(e.to) ?? 0) + 1);
    }
  }

  // Compute externalImportCounts
  const externalImportCounts = new Map<string, number>();
  for (const e of edges) {
    if (e.isExternal) {
      externalImportCounts.set(e.to, (externalImportCounts.get(e.to) ?? 0) + 1);
    }
  }

  // Run HITS to populate authority/hub/centrality
  const { authority, hub } = computeHITS(files, edges);

  return {
    edges,
    inDegree,
    centrality: authority,
    externalImportCounts,
    authority,
    hubScores: hub,
  };
}
