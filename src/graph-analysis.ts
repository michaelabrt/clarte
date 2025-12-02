import { deriveRole } from "./centrality.js";
import type {
  ArchitecturalLayer,
  ArchViolation,
  Chokepoint,
  Community,
  CrossCuttingFile,
  FileInstability,
  GraphTopology,
  HubFile,
  ImportEdge,
  ImportGraph,
  LayerConsistency,
  LayerEdge,
  LayerViolation,
  StructuralTemporalMismatch,
  TightCoupling,
} from "./types.js";

// ── Algorithm constants ──────────────────────────────────────────────

/** Community detection parameters */
const COMMUNITY = {
  /** Minimum community size; smaller groups get merged into neighbors */
  MIN_SIZE: 3,
  /** Maximum merge rounds to attempt */
  MAX_MERGE_ROUNDS: 3,
  /** ARI threshold above which communities just mirror directory structure (no novel insight) */
  ARI_NOVELTY_THRESHOLD: 0.85,
} as const;

/** Instability metric parameters */
const INSTABILITY = {
  /** Type-only imports carry less coupling risk (erased at runtime) */
  TYPE_ONLY_WEIGHT: 0.3,
} as const;

/** Layer consistency parameters */
const LAYER_CONSISTENCY = {
  /** Minimum number of importers for a file to be a cross-cutting concern */
  MIN_CROSS_LAYER_IMPORTERS: 5,
  /** Minimum layers for a file to be cross-cutting */
  MIN_LAYERS: 2,
  /** Minimum layers for layer consistency scoring */
  MIN_LAYERS_FOR_SCORING: 2,
  /** Minimum confidence to report architectural mismatches */
  DEFAULT_MIN_CONFIDENCE: 0.4,
  /** Minimum layer skip distance to count as a violation */
  MIN_SKIP_DISTANCE: 2,
} as const;

/**
 * Build a set of "filepath::ExportName" pairs that are actually imported
 * somewhere in the project. Used for dead export filtering.
 */
export function findUsedExports(edges: ImportEdge[]): Set<string> {
  const used = new Set<string>();
  for (const edge of edges) {
    if (edge.isExternal) continue;
    for (const name of edge.importedNames) {
      used.add(`${edge.to}::${name}`);
    }
  }
  return used;
}

/**
 * Get the most interconnected files sorted by max(authority, hubScore).
 * Captures both foundations (high authority) and orchestrators (high hub).
 */
export function getHubFiles(graph: ImportGraph, limit = 8): HubFile[] {
  // Count outgoing internal imports per file
  const outCount = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      outCount.set(edge.from, (outCount.get(edge.from) ?? 0) + 1);
    }
  }

  // Build list of all files with their scores
  const files: HubFile[] = [];
  for (const [filePath] of graph.centrality) {
    const importedBy = graph.directInDegree?.get(filePath) ?? graph.inDegree.get(filePath) ?? 0;
    const imports = outCount.get(filePath) ?? 0;
    // Only include files that have some connectivity
    if (importedBy > 0 || imports > 0) {
      const authority = graph.authority?.get(filePath) ?? graph.centrality.get(filePath) ?? 0;
      const hubScore = graph.hubScores?.get(filePath) ?? 0;
      const isBarrel = graph.barrelFiles?.has(filePath) ?? false;
      const role = deriveRole(authority, hubScore, isBarrel);
      files.push({
        path: filePath,
        centrality: authority,
        authority,
        hubScore,
        role,
        importedBy,
        imports,
      });
    }
  }

  // Sort by max(authority, hubScore) descending — captures both foundations and orchestrators
  // Alphabetical tiebreaker for deterministic output
  files.sort((a, b) => Math.max(b.authority, b.hubScore) - Math.max(a.authority, a.hubScore) || a.path.localeCompare(b.path));

  return files.slice(0, limit);
}

/** Directory patterns for classifying files into architectural layers */
const LAYER_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: "types", pattern: /(?:^|\/)types?\// },
  { name: "stores", pattern: /(?:^|\/)stores?\// },
  { name: "hooks", pattern: /(?:^|\/)hooks?\// },
  { name: "services", pattern: /(?:^|\/)(?:services?|api)\// },
  { name: "components", pattern: /(?:^|\/)components?\// },
  { name: "pages", pattern: /(?:^|\/)(?:pages?|app|routes?)\// },
  { name: "utils", pattern: /(?:^|\/)(?:utils?|lib|helpers?)\// },
  { name: "config", pattern: /(?:^|\/)config\// },
];

/**
 * Classify files into architectural layers and determine their dependency ordering.
 * Returns both the layers and directed edges between them.
 *
 * When customLayers is provided, those patterns are matched first (before the
 * hardcoded LAYER_PATTERNS). Each entry's `pattern` string is compiled to a RegExp.
 */
export function detectArchitecturalLayers(
  graph: ImportGraph,
  customLayers?: Array<{ name: string; pattern: string }>,
): { layers: ArchitecturalLayer[]; layerEdges: LayerEdge[] } {
  // Build the effective pattern list: user patterns first, then built-in defaults
  const userPatterns: Array<{ name: string; pattern: RegExp }> = (customLayers ?? []).map((l) => ({
    name: l.name,
    pattern: new RegExp(l.pattern),
  }));
  const effectivePatterns = [...userPatterns, ...LAYER_PATTERNS];

  // Classify each internal file into a layer
  const layerFiles = new Map<string, string[]>();
  const fileToLayer = new Map<string, string>();

  for (const [filePath] of graph.centrality) {
    for (const { name, pattern } of effectivePatterns) {
      if (pattern.test(filePath)) {
        const files = layerFiles.get(name) ?? [];
        files.push(filePath);
        layerFiles.set(name, files);
        fileToLayer.set(filePath, name);
        break; // First match wins
      }
    }
  }

  // Track both directions: who imports each layer, and who each layer depends on
  const layerImportedBy = new Map<string, Set<string>>();
  const layerDependsOn = new Map<string, Set<string>>();
  for (const name of layerFiles.keys()) {
    layerImportedBy.set(name, new Set());
    layerDependsOn.set(name, new Set());
  }

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (fromLayer && toLayer && fromLayer !== toLayer) {
      layerImportedBy.get(toLayer)?.add(fromLayer);
      layerDependsOn.get(fromLayer)?.add(toLayer);
    }
  }

  // Build layer edges from dependsOn data
  const layerEdges: LayerEdge[] = [];
  const edgeSet = new Set<string>();
  for (const [from, deps] of layerDependsOn) {
    for (const to of deps) {
      const key = `${from}->${to}`;
      if (!edgeSet.has(key)) {
        edgeSet.add(key);
        layerEdges.push({ from, to });
      }
    }
  }

  // Build result sorted by importedByLayers descending (most foundational first)
  const layers: ArchitecturalLayer[] = [];
  for (const [name, files] of layerFiles) {
    layers.push({
      name,
      files,
      importedByLayers: layerImportedBy.get(name)?.size ?? 0,
      dependsOn: [...(layerDependsOn.get(name) ?? [])],
    });
  }

  // Sort: most imported layers first (foundational), then by name
  layers.sort((a, b) => b.importedByLayers - a.importedByLayers || a.name.localeCompare(b.name));

  return { layers, layerEdges };
}

/** Threshold above which a file is considered high-instability */
export const INSTABILITY_THRESHOLD = 0.8;

/**
 * Compute instability metric (Robert C. Martin) for each file.
 * instability = fanOut / (fanIn + fanOut)
 * Returns files with instability > INSTABILITY_THRESHOLD and fanIn >= 1 (high-risk zones).
 */
export function computeInstability(graph: ImportGraph): FileInstability[] {
  const TYPE_ONLY_WEIGHT = INSTABILITY.TYPE_ONLY_WEIGHT;

  // Count weighted outgoing internal edges per file
  const fanOutMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanOutMap.set(edge.from, (fanOutMap.get(edge.from) ?? 0) + weight);
    }
  }

  // Count weighted incoming internal edges per file
  const fanInMap = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!edge.isExternal) {
      const weight = edge.isTypeOnly ? TYPE_ONLY_WEIGHT : 1;
      fanInMap.set(edge.to, (fanInMap.get(edge.to) ?? 0) + weight);
    }
  }

  const results: FileInstability[] = [];
  for (const [filePath] of graph.inDegree) {
    const fanOut = fanOutMap.get(filePath) ?? 0;
    const fanIn = fanInMap.get(filePath) ?? 0;
    const total = fanIn + fanOut;
    if (total === 0) continue;
    const instability = fanOut / total;
    if (instability > INSTABILITY_THRESHOLD && fanIn >= 1) {
      results.push({ path: filePath, fanIn: Math.round(fanIn), fanOut: Math.round(fanOut), instability });
    }
  }

  // Sort by instability descending, alphabetical tiebreaker
  results.sort((a, b) => b.instability - a.instability || a.path.localeCompare(b.path));
  return results;
}

/**
 * Detect communities of tightly-connected files using directory-seeded
 * modularity optimization. Deterministic (no random shuffling).
 *
 * Phase 1: Seed communities from directory structure.
 * Phase 2: Merge tiny communities (< 3 files) into their best neighbor.
 * Phase 3: Reassign files with majority cross-community imports.
 * Phase 4: Validate novelty (skip if communities just mirror directories).
 */
export function detectCommunities(graph: ImportGraph): Community[] {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const files = [...allFiles];
  if (files.length === 0) return [];

  // Phase 1: Seed from directory structure (deepest meaningful directory)
  const dirLabels = new Map<string, number>();
  const fileToCommunity = new Map<string, number>();
  let nextLabel = 0;

  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirLabels.has(dir)) {
      dirLabels.set(dir, nextLabel++);
    }
    fileToCommunity.set(file, dirLabels.get(dir)!);
  }

  // Phase 2: Merge tiny communities (< 3 files) into best neighbor
  for (let round = 0; round < COMMUNITY.MAX_MERGE_ROUNDS; round++) {
    const groups = groupByCommunity(fileToCommunity);
    let merged = false;

    for (const [label, members] of groups) {
      if (members.length >= COMMUNITY.MIN_SIZE) continue;

      // Find neighboring community with most edges
      const neighborCounts = new Map<number, number>();
      for (const file of members) {
        for (const neighbor of adj.get(file) ?? []) {
          const nLabel = fileToCommunity.get(neighbor);
          if (nLabel != null && nLabel !== label) {
            neighborCounts.set(nLabel, (neighborCounts.get(nLabel) ?? 0) + 1);
          }
        }
      }

      if (neighborCounts.size === 0) continue;

      // Merge into most-connected neighbor
      let bestNeighbor = label;
      let bestCount = 0;
      for (const [nLabel, count] of neighborCounts) {
        if (count > bestCount) {
          bestCount = count;
          bestNeighbor = nLabel;
        }
      }

      if (bestNeighbor !== label) {
        for (const file of members) {
          fileToCommunity.set(file, bestNeighbor);
        }
        merged = true;
      }
    }

    if (!merged) break;
  }

  // Phase 3: Reassign files with >50% cross-community imports
  for (let round = 0; round < COMMUNITY.MAX_MERGE_ROUNDS; round++) {
    let changed = false;
    // Process in deterministic sorted order
    for (const file of files.sort()) {
      const currentLabel = fileToCommunity.get(file)!;
      const neighbors = adj.get(file);
      if (!neighbors || neighbors.size === 0) continue;

      // Count which communities neighbors belong to
      const communityEdges = new Map<number, number>();
      for (const neighbor of neighbors) {
        const nLabel = fileToCommunity.get(neighbor);
        if (nLabel != null) {
          communityEdges.set(nLabel, (communityEdges.get(nLabel) ?? 0) + 1);
        }
      }

      // If majority of edges go to a different community, reassign
      let bestCommunity = currentLabel;
      let bestEdges = communityEdges.get(currentLabel) ?? 0;
      for (const [cLabel, count] of communityEdges) {
        if (count > bestEdges) {
          bestEdges = count;
          bestCommunity = cLabel;
        }
      }

      if (bestCommunity !== currentLabel && bestEdges > neighbors.size / 2) {
        fileToCommunity.set(file, bestCommunity);
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Build final communities
  const finalGroups = groupByCommunity(fileToCommunity);
  const communities: Community[] = [];
  let id = 0;

  for (const memberFiles of finalGroups.values()) {
    if (memberFiles.length < COMMUNITY.MIN_SIZE) continue;
    const label = deriveLabel(memberFiles);
    communities.push({ id: id++, files: memberFiles.sort(), label });
  }

  // Phase 4: Validate novelty using Adjusted Rand Index
  // If communities closely mirror directory structure, return empty
  const dirOnlyCommunities = new Map<string, number>();
  let dirNextLabel = 0;
  for (const file of files) {
    const dir = getDeepestDir(file);
    if (!dirOnlyCommunities.has(dir)) dirOnlyCommunities.set(dir, dirNextLabel++);
  }
  const ari = computeARI(files, fileToCommunity, file => dirOnlyCommunities.get(getDeepestDir(file))!);
  if (ari > COMMUNITY.ARI_NOVELTY_THRESHOLD) {
    // Communities just restate directory tree; no novel insight
    return [];
  }

  // Sort by size descending, alphabetical tiebreaker on first file
  communities.sort((a, b) => b.files.length - a.files.length || (a.files[0] ?? "").localeCompare(b.files[0] ?? ""));
  return communities;
}

/**
 * Get the deepest meaningful directory for a file path.
 * e.g. "src/components/Button.tsx" -> "src/components"
 */
function getDeepestDir(filePath: string): string {
  const parts = filePath.split("/");
  return parts.length > 1 ? parts.slice(0, -1).join("/") : ".";
}

/**
 * Group files by their community label.
 */
function groupByCommunity(fileToCommunity: Map<string, number>): Map<number, string[]> {
  const groups = new Map<number, string[]>();
  for (const [file, label] of fileToCommunity) {
    const group = groups.get(label) ?? [];
    group.push(file);
    groups.set(label, group);
  }
  return groups;
}

/**
 * Compute Adjusted Rand Index between two clusterings of the same files.
 * Returns a value between -1 and 1, where 1 means identical clusterings.
 */
function computeARI(
  files: string[],
  labelingA: Map<string, number>,
  getLabelB: (file: string) => number,
): number {
  const n = files.length;
  if (n < 2) return 1;

  // Build contingency table
  const contingency = new Map<string, number>();
  const aCounts = new Map<number, number>();
  const bCounts = new Map<number, number>();

  for (const file of files) {
    const a = labelingA.get(file)!;
    const b = getLabelB(file);
    const key = `${a}|${b}`;
    contingency.set(key, (contingency.get(key) ?? 0) + 1);
    aCounts.set(a, (aCounts.get(a) ?? 0) + 1);
    bCounts.set(b, (bCounts.get(b) ?? 0) + 1);
  }

  // Choose-2 helper
  const c2 = (x: number) => (x * (x - 1)) / 2;

  let sumNij = 0;
  for (const nij of contingency.values()) sumNij += c2(nij);

  let sumAi = 0;
  for (const ai of aCounts.values()) sumAi += c2(ai);

  let sumBj = 0;
  for (const bj of bCounts.values()) sumBj += c2(bj);

  const totalC2 = c2(n);
  const expected = (sumAi * sumBj) / totalC2;
  const maxIndex = (sumAi + sumBj) / 2;
  const denominator = maxIndex - expected;

  if (denominator === 0) return 1;
  return (sumNij - expected) / denominator;
}

/**
 * Derive a human-readable label from a group of file paths
 * by finding their common directory prefix.
 */
function deriveLabel(files: string[]): string {
  if (files.length === 0) return "unknown";

  const dirs = files.map((f) => {
    const parts = f.split("/");
    return parts.slice(0, -1).join("/");
  });

  // Find common prefix
  const first = dirs[0];
  let prefixLen = first.length;
  for (const dir of dirs) {
    let i = 0;
    while (i < prefixLen && i < dir.length && first[i] === dir[i]) i++;
    prefixLen = i;
  }

  let common = first.slice(0, prefixLen);
  // Trim to last full directory segment
  if (common.includes("/")) {
    common = common.slice(0, common.lastIndexOf("/") + 1);
  }
  common = common.replace(/\/$/, "");

  return common || files[0].split("/")[0] || "root";
}

/**
 * Find dead files: files with zero in-degree (not imported by anything).
 * Excludes entry points, test files, and config files.
 */
export function findDeadFiles(
  graph: ImportGraph,
  entryPoints: string[] = [],
): string[] {
  const entrySet = new Set(entryPoints);
  const dead: string[] = [];

  for (const [file, degree] of graph.inDegree) {
    if (degree > 0) continue;
    if (entrySet.has(file)) continue;
    // Skip test files
    if (/\.(test|spec)\.[jt]sx?$/.test(file) || file.includes("__tests__/")) continue;
    // Skip config files
    if (/\.(config|rc)\.[jt]sx?$/.test(file)) continue;
    // Skip entry points by convention
    const basename = file.split("/").pop() ?? "";
    if (/^(index|main|app|server|cli|worker|seed|migrate|setup|cron|bootstrap|handler|lambda)\.[jt]sx?$/.test(basename)) continue;
    if (basename === "mod.ts" || basename === "lib.rs" || basename === "main.rs") continue;
    if (basename === "main.go" || basename === "main.py" || basename === "manage.py" || basename === "wsgi.py" || basename === "asgi.py") continue;

    dead.push(file);
  }

  return dead.sort();
}


// ── §1.7 Cross-Layer Fan-In Analysis ──────────────────────────────────

/**
 * Find files imported across multiple architectural layers.
 * A file imported by 10 files all in `components/` is local.
 * A file imported across `components/`, `services/`, `hooks/`, and `pages/`
 * is a cross-cutting concern where changes ripple across boundaries.
 */
export function findCrossCuttingFiles(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  minLayerSpread = 3,
): CrossCuttingFile[] {
  if (layers.length < minLayerSpread) return [];

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // For each target file, collect which layers import it
  const importerLayers = new Map<string, Set<string>>();
  const importerCounts = new Map<string, number>();

  const barrels = graph.barrelFiles ?? new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    // Skip barrel files' own re-export edges (not genuine cross-layer usage)
    if (barrels.has(edge.from)) continue;
    const fromLayer = fileToLayer.get(edge.from);
    if (!fromLayer) continue;

    if (!importerLayers.has(edge.to)) importerLayers.set(edge.to, new Set());
    importerLayers.get(edge.to)!.add(fromLayer);
    importerCounts.set(edge.to, (importerCounts.get(edge.to) ?? 0) + 1);
  }

  const results: CrossCuttingFile[] = [];
  for (const [file, layerSet] of importerLayers) {
    if (layerSet.size >= minLayerSpread) {
      results.push({
        file,
        totalImporters: importerCounts.get(file) ?? 0,
        layerSpread: layerSet.size,
        layers: [...layerSet].sort(),
      });
    }
  }

  // Sort by layer spread descending, then by total importers descending, alphabetical tiebreaker
  results.sort((a, b) => b.layerSpread - a.layerSpread || b.totalImporters - a.totalImporters || a.file.localeCompare(b.file));
  return results;
}

// ── §1.8 Layer Dependency Consistency Score ────────────────────────────

/**
 * Topological sort of layers using Kahn's algorithm.
 * Returns layers ordered from most foundational to most consumer.
 * Falls back to input order for cycles.
 */
function topologicalSortLayers(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): string[] {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDeg = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDeg.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: from depends on to (from imports to)
  // For topological order: to is more foundational, from is more consumer
  // Edge direction for topo sort: to -> from (foundational -> consumer)
  for (const edge of layerEdges) {
    if (!layerNames.has(edge.from) || !layerNames.has(edge.to)) continue;
    adj.get(edge.to)!.push(edge.from);
    inDeg.set(edge.from, (inDeg.get(edge.from) ?? 0) + 1);
  }

  const queue: string[] = [];
  for (const [name, deg] of inDeg) {
    if (deg === 0) queue.push(name);
  }
  queue.sort(); // deterministic tie-breaking

  const sorted: string[] = [];
  while (queue.length > 0) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const neighbor of adj.get(node) ?? []) {
      const newDeg = (inDeg.get(neighbor) ?? 1) - 1;
      inDeg.set(neighbor, newDeg);
      if (newDeg === 0) {
        // Insert in sorted position for determinism
        const insertIdx = queue.findIndex((q) => q > neighbor);
        if (insertIdx === -1) queue.push(neighbor);
        else queue.splice(insertIdx, 0, neighbor);
      }
    }
  }

  // If cycle exists, append remaining layers
  if (sorted.length < layerNames.size) {
    for (const name of layerNames) {
      if (!sorted.includes(name)) sorted.push(name);
    }
  }

  return sorted;
}

/**
 * Measure how well the codebase follows its own layering conventions.
 * For each detected layer pair, count edges in the "correct" direction
 * (foundational -> consumer) vs. the "wrong" direction (upward imports).
 */
export function computeLayerConsistency(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): LayerConsistency {
  if (layers.length < LAYER_CONSISTENCY.MIN_LAYERS_FOR_SCORING) return { consistency: 1, violations: [] };

  // Build topological order and rank map
  const order = topologicalSortLayers(layers, layerEdges);
  const rank = new Map<string, number>();
  for (let i = 0; i < order.length; i++) {
    rank.set(order[i], i);
  }

  // Build file -> layer lookup
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  const violations: LayerViolation[] = [];
  let correctCount = 0;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    const fromLayer = fileToLayer.get(edge.from);
    const toLayer = fileToLayer.get(edge.to);
    if (!fromLayer || !toLayer || fromLayer === toLayer) continue;

    const fromRank = rank.get(fromLayer);
    const toRank = rank.get(toLayer);
    if (fromRank == null || toRank == null) continue;

    if (fromRank < toRank) {
      // Foundational layer importing from a consumer layer = violation
      violations.push({
        from: edge.from,
        to: edge.to,
        fromLayer,
        toLayer,
      });
    } else {
      correctCount++;
    }
  }

  const total = correctCount + violations.length;
  const consistency = total === 0 ? 1 : correctCount / total;

  // Sort violations by layer rank distance (most egregious first), alphabetical tiebreaker
  violations.sort((a, b) => {
    const distA = (rank.get(a.toLayer) ?? 0) - (rank.get(a.fromLayer) ?? 0);
    const distB = (rank.get(b.toLayer) ?? 0) - (rank.get(b.fromLayer) ?? 0);
    return distB - distA || a.from.localeCompare(b.from) || a.to.localeCompare(b.to);
  });

  return { consistency, violations: violations.slice(0, 10) };
}

// ── §1.9 Articulation Point Detection ─────────────────────────────────

/**
 * Find articulation points (chokepoints) in the import graph using
 * Tarjan's algorithm. These are files whose removal would disconnect
 * parts of the codebase.
 *
 * Runs in O(V + E), same complexity as SCC detection.
 */
export function findChokepoints(graph: ImportGraph): Chokepoint[] {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  if (allFiles.size === 0) return [];

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const articulationPoints = new Set<string>();
  let timer = 0;

  // Iterative articulation point detection using an explicit call stack.
  // Each frame stores the current node, its neighbor list as an array,
  // the iteration index into that list, and the tree-child count.
  const callStack: Array<{
    u: string;
    neighbors: string[];
    neighborIdx: number;
    childCount: number;
  }> = [];

  // Run DFS from each unvisited node (handles disconnected components)
  const sortedFiles = [...allFiles].sort();
  for (const file of sortedFiles) {
    if (disc.has(file)) continue;

    parent.set(file, null);
    disc.set(file, timer);
    low.set(file, timer);
    timer++;
    callStack.push({
      u: file,
      neighbors: [...(adj.get(file) ?? [])],
      neighborIdx: 0,
      childCount: 0,
    });

    while (callStack.length > 0) {
      const frame = callStack[callStack.length - 1]!;

      if (frame.neighborIdx < frame.neighbors.length) {
        const v = frame.neighbors[frame.neighborIdx]!;
        frame.neighborIdx++;

        if (!disc.has(v)) {
          frame.childCount++;
          parent.set(v, frame.u);
          disc.set(v, timer);
          low.set(v, timer);
          timer++;
          // "Recurse" into v: push a new frame
          callStack.push({
            u: v,
            neighbors: [...(adj.get(v) ?? [])],
            neighborIdx: 0,
            childCount: 0,
          });
        } else if (v !== parent.get(frame.u)) {
          low.set(frame.u, Math.min(low.get(frame.u)!, disc.get(v)!));
        }
      } else {
        // All neighbors processed: pop frame and update parent
        callStack.pop();
        if (callStack.length > 0) {
          const parentFrame = callStack[callStack.length - 1]!;
          low.set(parentFrame.u, Math.min(low.get(parentFrame.u)!, low.get(frame.u)!));

          // Root with 2+ children
          if (parent.get(parentFrame.u) == null && parentFrame.childCount > 1) {
            articulationPoints.add(parentFrame.u);
          }
          // Non-root where no back edge from subtree reaches above u
          if (parent.get(parentFrame.u) != null && low.get(frame.u)! >= disc.get(parentFrame.u)!) {
            articulationPoints.add(parentFrame.u);
          }
        }
      }
    }
  }

  // For each articulation point, find components without it and disconnected files
  const results: Chokepoint[] = [];
  for (const cp of articulationPoints) {
    const { componentCount, disconnected } = analyzeComponentsWithout(adj, allFiles, cp);
    results.push({
      file: cp,
      separates: componentCount,
      importedBy: graph.inDegree.get(cp) ?? 0,
      dependents: disconnected.slice(0, 10), // Cap at 10 for context size
    });
  }

  // Sort by separates descending, then importedBy descending, alphabetical tiebreaker
  results.sort((a, b) => b.separates - a.separates || b.importedBy - a.importedBy || a.file.localeCompare(b.file));
  return results;
}

/**
 * Analyze the graph after removing a node: count components and find
 * files disconnected from the largest remaining component.
 */
function analyzeComponentsWithout(
  adj: Map<string, Set<string>>,
  allFiles: Set<string>,
  removed: string,
): { componentCount: number; disconnected: string[] } {
  const visited = new Set<string>();
  visited.add(removed);
  const componentMembers: string[][] = [];

  for (const file of allFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    let qHead = 0;
    visited.add(file);
    while (qHead < queue.length) {
      const current = queue[qHead++];
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    componentMembers.push(component);
  }

  // Find the largest component; all other files are "disconnected"
  componentMembers.sort((a, b) => b.length - a.length);
  const disconnected: string[] = [];
  for (let i = 1; i < componentMembers.length; i++) {
    disconnected.push(...componentMembers[i]);
  }
  disconnected.sort();

  return { componentCount: componentMembers.length, disconnected };
}

// ── Graph Topology Analysis ────────────────────────────────────────────

/**
 * Compute graph topology metrics: connected components, approximate diameter,
 * and reachability. Helps LLMs understand whether a project has independent
 * subsystems or is a tightly connected monolith.
 */
export function computeGraphTopology(graph: ImportGraph): GraphTopology {
  // Build undirected adjacency from internal edges
  const adj = new Map<string, Set<string>>();
  const allFiles = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    allFiles.add(edge.from);
    allFiles.add(edge.to);

    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const totalFiles = allFiles.size;
  if (totalFiles === 0) {
    return { componentCount: 0, componentSizes: [], approximateDiameter: 0, reachability: 0, isFragmented: false };
  }

  // 1. Find connected components via BFS
  const visited = new Set<string>();
  const components: string[][] = [];

  for (const file of allFiles) {
    if (visited.has(file)) continue;
    const component: string[] = [];
    const queue = [file];
    let qHead = 0;
    visited.add(file);
    while (qHead < queue.length) {
      const current = queue[qHead++];
      component.push(current);
      for (const neighbor of adj.get(current) ?? []) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push(neighbor);
        }
      }
    }
    components.push(component);
  }

  components.sort((a, b) => b.length - a.length);
  const componentSizes = components.map((c) => c.length);

  // 2. Approximate diameter of the largest component using multi-source BFS
  const largest = components[0];
  let approximateDiameter = 0;

  if (largest.length > 1) {
    // Sample up to 3 nodes deterministically (first, middle, last)
    const samples = [
      largest[0],
      largest[Math.floor(largest.length / 2)],
      largest[largest.length - 1],
    ];

    for (const start of samples) {
      // BFS to find max distance from start
      const dist = new Map<string, number>();
      dist.set(start, 0);
      const bfsQueue = [start];
      let bfsHead = 0;
      let maxDist = 0;

      while (bfsHead < bfsQueue.length) {
        const current = bfsQueue[bfsHead++]!;
        const d = dist.get(current)!;
        for (const neighbor of adj.get(current) ?? []) {
          if (!dist.has(neighbor)) {
            const nd = d + 1;
            dist.set(neighbor, nd);
            if (nd > maxDist) maxDist = nd;
            bfsQueue.push(neighbor);
          }
        }
      }

      if (maxDist > approximateDiameter) approximateDiameter = maxDist;
    }
  }

  // 3. Reachability: fraction of files in the largest component
  const reachability = totalFiles > 0 ? largest.length / totalFiles : 0;

  // 4. Fragmentation: more than one component with 5+ files
  const isFragmented = components.length > 1 && components[1].length >= 5;

  return { componentCount: components.length, componentSizes, approximateDiameter, reachability, isFragmented };
}

// ── Structural-Temporal Mismatch Detection ────────────────────────────

/**
 * Find file pairs that co-change frequently (high temporal coupling)
 * but are structurally distant in the import graph (no direct or short path).
 *
 * These mismatches suggest hidden dependencies: the files are coupled in
 * practice but the import graph doesn't reflect it. Common causes:
 * - Shared database schema or API contract
 * - Copy-paste duplication
 * - Missing shared module that should be extracted
 */
export function findStructuralTemporalMismatches(
  graph: ImportGraph,
  changeCoupling: Array<{ fileA: string; fileB: string; confidence: number; coChangeCount: number }>,
  minConfidence = 0.4,
  minDistance = 3,
  topN = 10,
): StructuralTemporalMismatch[] {
  if (changeCoupling.length === 0) return [];

  // Build undirected adjacency for BFS distance
  const adj = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (!adj.has(edge.from)) adj.set(edge.from, new Set());
    if (!adj.has(edge.to)) adj.set(edge.to, new Set());
    adj.get(edge.from)!.add(edge.to);
    adj.get(edge.to)!.add(edge.from);
  }

  const bfsDistance = (from: string, to: string): number => {
    if (from === to) return 0;
    if (!adj.has(from) || !adj.has(to)) return -1;
    const visited = new Set<string>();
    const queue: Array<{ node: string; dist: number }> = [{ node: from, dist: 0 }];
    let qHead = 0;
    visited.add(from);
    while (qHead < queue.length) {
      const { node, dist } = queue[qHead++];
      for (const neighbor of adj.get(node) ?? []) {
        if (neighbor === to) return dist + 1;
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          queue.push({ node: neighbor, dist: dist + 1 });
        }
      }
    }
    return -1; // unreachable
  };

  const results: StructuralTemporalMismatch[] = [];

  for (const pair of changeCoupling) {
    if (pair.confidence < minConfidence) continue;

    const dist = bfsDistance(pair.fileA, pair.fileB);
    if (dist >= minDistance || dist === -1) {
      results.push({
        fileA: pair.fileA,
        fileB: pair.fileB,
        graphDistance: dist,
        coChangeConfidence: pair.confidence,
        coChangeCount: pair.coChangeCount,
      });
    }
  }

  // Sort by confidence descending (strongest hidden coupling first), alphabetical tiebreaker
  results.sort((a, b) => b.coChangeConfidence - a.coChangeConfidence || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB));
  return results.slice(0, topN);
}

// ── Tight Coupling Detection ──────────────────────────────────────────

/**
 * Find file pairs where one file imports many named exports from another,
 * indicating tight coupling. High import specificity means the importing
 * file depends on many implementation details of the imported file.
 *
 * Threshold: 5+ named imports from a single file suggests the importing
 * file may be too tightly coupled and could benefit from an intermediate
 * interface or facade.
 */
export function findTightCouplings(
  graph: ImportGraph,
  minNames = 5,
  topN = 10,
): TightCoupling[] {
  // Aggregate named imports per (from, to) pair
  const pairNames = new Map<string, { from: string; to: string; names: Set<string> }>();

  const barrels = graph.barrelFiles ?? new Set<string>();

  for (const edge of graph.edges) {
    if (edge.isExternal || edge.importedNames.length === 0) continue;
    // Skip barrel files' own re-export edges (not genuine coupling)
    if (barrels.has(edge.from)) continue;
    const key = `${edge.from}->${edge.to}`;
    let entry = pairNames.get(key);
    if (!entry) {
      entry = { from: edge.from, to: edge.to, names: new Set() };
      pairNames.set(key, entry);
    }
    for (const name of edge.importedNames) {
      entry.names.add(name);
    }
  }

  const results: TightCoupling[] = [];

  for (const entry of pairNames.values()) {
    if (entry.names.size >= minNames) {
      results.push({
        from: entry.from,
        to: entry.to,
        importedNames: entry.names.size,
        names: [...entry.names].sort(),
      });
    }
  }

  // Sort by number of imported names descending, alphabetical tiebreaker
  results.sort((a, b) => b.importedNames - a.importedNames || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
  return results.slice(0, topN);
}

// ── Architectural Fitness Functions ───────────────────────────────────

/**
 * Derive a topological ordering of layers from layer dependency edges.
 * Returns a map of layer name to its depth (0 = lowest/most foundational).
 * Uses Kahn's algorithm; layers in cycles get the same depth.
 */
function computeLayerOrdering(
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): Map<string, number> {
  const layerNames = new Set(layers.map((l) => l.name));
  const inDegree = new Map<string, number>();
  const adj = new Map<string, string[]>();

  for (const name of layerNames) {
    inDegree.set(name, 0);
    adj.set(name, []);
  }

  // layerEdges: {from: "components", to: "types"} means components depends on types.
  // For topological ordering: types is more foundational (lower).
  // Build graph: to -> from (foundational -> consumer) for topo sort.
  for (const e of layerEdges) {
    if (!layerNames.has(e.from) || !layerNames.has(e.to)) continue;
    adj.get(e.to)!.push(e.from);
    inDegree.set(e.from, (inDegree.get(e.from) ?? 0) + 1);
  }

  // Kahn's algorithm
  const queue: string[] = [];
  for (const [name, deg] of inDegree) {
    if (deg === 0) queue.push(name);
  }

  const ordering = new Map<string, number>();
  let depth = 0;

  while (queue.length > 0) {
    const nextQueue: string[] = [];
    for (const node of queue) {
      ordering.set(node, depth);
      for (const neighbor of adj.get(node) ?? []) {
        const newDeg = (inDegree.get(neighbor) ?? 1) - 1;
        inDegree.set(neighbor, newDeg);
        if (newDeg === 0) {
          nextQueue.push(neighbor);
        }
      }
    }
    queue.length = 0;
    queue.push(...nextQueue);
    depth++;
  }

  // Assign remaining (cycle members) to the max depth
  for (const name of layerNames) {
    if (!ordering.has(name)) {
      ordering.set(name, depth);
    }
  }

  return ordering;
}

/**
 * Check architectural fitness rules against the import graph.
 *
 * Rules:
 * 1. No upward dependencies: lower layers should not import higher layers
 * 2. Test isolation: test files should not import other test files
 *    (except fixtures/test-utils)
 * 3. Layer skip detection: imports skipping 2+ intermediate layers
 *
 * Returns at most 20 violations to avoid noise.
 */
export function checkArchitecturalFitness(
  graph: ImportGraph,
  layers: ArchitecturalLayer[],
  layerEdges: LayerEdge[],
): ArchViolation[] {
  const violations: ArchViolation[] = [];
  const MAX_VIOLATIONS = 20;

  // Build file-to-layer mapping
  const fileToLayer = new Map<string, string>();
  for (const layer of layers) {
    for (const file of layer.files) {
      fileToLayer.set(file, layer.name);
    }
  }

  // Compute layer ordering (depth: 0 = most foundational)
  const hasLayers = layers.length >= LAYER_CONSISTENCY.MIN_LAYERS_FOR_SCORING;
  const layerOrder = hasLayers ? computeLayerOrdering(layers, layerEdges) : new Map<string, number>();

  // Test file patterns
  const testFilePattern = /(?:\.test\.|\.spec\.|__tests__\/|tests?\/)/;
  const testUtilPattern = /(?:__fixtures__|test[-_]?utils?|test[-_]?helpers?|test[-_]?setup|fixtures)/;

  for (const edge of graph.edges) {
    if (edge.isExternal) continue;
    if (violations.length >= MAX_VIOLATIONS) break;

    // Rule 1 and 3 only apply when we have 2+ layers
    if (hasLayers) {
      const fromLayer = fileToLayer.get(edge.from);
      const toLayer = fileToLayer.get(edge.to);

      if (fromLayer && toLayer && fromLayer !== toLayer) {
        const fromDepth = layerOrder.get(fromLayer) ?? 0;
        const toDepth = layerOrder.get(toLayer) ?? 0;

        // Rule 1: No upward dependencies
        // If fromLayer is lower (more foundational) than toLayer, it's an upward dep
        if (fromDepth < toDepth) {
          violations.push({
            from: edge.from,
            to: edge.to,
            rule: "no-upward-dep",
            message: `\`${edge.from}\` (${fromLayer} layer) should not import from \`${edge.to}\` (${toLayer} layer). Extract shared logic to a lower layer.`,
            severity: "warning",
          });
          if (violations.length >= MAX_VIOLATIONS) break;
        }

        // Rule 3: Layer skip detection
        const skipDistance = Math.abs(toDepth - fromDepth);
        if (skipDistance >= LAYER_CONSISTENCY.MIN_SKIP_DISTANCE) {
          // Only flag when going from higher to lower (normal direction but skipping)
          // i.e., fromDepth > toDepth means consumer importing foundational, but skipping
          if (fromDepth > toDepth) {
            violations.push({
              from: edge.from,
              to: edge.to,
              rule: "layer-skip",
              message: `\`${edge.from}\` imports directly from \`${edge.to}\`, skipping ${skipDistance - 1} intermediate layer${skipDistance - 1 === 1 ? "" : "s"}. Consider adding an abstraction in an intermediate layer.`,
              severity: "warning",
            });
            if (violations.length >= MAX_VIOLATIONS) break;
          }
        }
      }
    }

    // Rule 2: Test isolation (works regardless of layer count)
    const fromIsTest = testFilePattern.test(edge.from);
    const toIsTest = testFilePattern.test(edge.to);

    if (fromIsTest && toIsTest) {
      // Allow imports from fixtures/test-utils
      const toIsUtility = testUtilPattern.test(edge.to);
      if (!toIsUtility) {
        violations.push({
          from: edge.from,
          to: edge.to,
          rule: "test-isolation",
          message: `\`${edge.from}\` imports another test file \`${edge.to}\`. Extract shared setup to a test utility.`,
          severity: "warning",
        });
        if (violations.length >= MAX_VIOLATIONS) break;
      }
    }
  }

  return violations.slice(0, MAX_VIOLATIONS);
}
