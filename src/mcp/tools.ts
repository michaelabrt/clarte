import { isTestFile } from "../utils.js";
import { formatInspect, formatImpact, type InspectData, type ImpactData } from "./formatters.js";
import type { PersistedGraph } from "./types.js";

const MAX_INTEGRATION_TESTS = 5;
const MAX_COCHANGE = 3;
const MAX_HIDDEN_COCHANGE = 3;
const MAX_BFS_DEPTH = 10;

/**
 * Handle a clarte_inspect query for a single file.
 * Returns graph-derived context impossible for grep/read to compute.
 */
export function handleInspect(graph: PersistedGraph, filePath: string): string {
  const normalized = normalizePath(filePath);
  const file = graph.files[normalized];
  if (!file) {
    return `file not found in analysis graph: ${normalized}`;
  }

  // Build reverse adjacency for transitive test discovery
  const reverseAdj = buildReverseAdjacency(graph);

  // Find integration tests: tests that exercise this file transitively
  // (exclude direct/co-located tests the agent finds via glob)
  const directTests = new Set(file.testFiles);
  const integrationTests = findTransitiveTests(reverseAdj, normalized, directTests, graph);

  // Find co-change partners
  const coChange = graph.changeCoupling
    .filter((c) => c.fileA === normalized || c.fileB === normalized)
    .map((c) => ({
      file: c.fileA === normalized ? c.fileB : c.fileA,
      confidence: c.confidence,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_COCHANGE);

  // Look up community
  let community: InspectData["community"];
  if (file.communityId !== null) {
    const comm = graph.communities.find((c) => c.id === file.communityId);
    if (comm) {
      community = { id: comm.id, label: comm.label };
    }
  }

  // Cross-cutting
  let crossCutting: InspectData["crossCutting"];
  if (file.isCrossCutting) {
    crossCutting = { layerSpread: file.layerSpread, layers: file.layers };
  }

  const data: InspectData = {
    role: file.role ?? "Leaf",
    betweenness: file.betweenness,
    instability: file.instability,
    chokepoint: file.isChokepoint ? { separates: file.separatesComponents } : undefined,
    integrationTests,
    coChange,
    community,
    crossCutting,
  };

  return formatInspect(data);
}

/**
 * Handle a clarte_impact query for changed files.
 * Returns graph-exclusive effects grep cannot find.
 */
export function handleImpact(graph: PersistedGraph, changedFiles: string[]): string {
  const normalizedFiles = changedFiles.map(normalizePath);
  const validFiles = normalizedFiles.filter((f) => graph.files[f]);

  if (validFiles.length === 0) {
    return `no changed files found in analysis graph: ${normalizedFiles.join(", ")}`;
  }

  const reverseAdj = buildReverseAdjacency(graph);

  // 1. Transitive integration test discovery
  const allDirectTests = new Set<string>();
  for (const f of validFiles) {
    for (const t of graph.files[f].testFiles) {
      allDirectTests.add(t);
    }
  }

  const transitiveTests = new Map<string, string>(); // test -> via (first intermediate file)
  for (const changedFile of validFiles) {
    const visited = new Set<string>([changedFile]);
    const queue: Array<{ file: string; depth: number; firstHop: string | null }> = [];

    for (const importer of reverseAdj.get(changedFile) ?? []) {
      queue.push({ file: importer, depth: 1, firstHop: importer });
    }

    while (queue.length > 0) {
      const { file, depth, firstHop } = queue.shift()!;
      if (visited.has(file) || depth > MAX_BFS_DEPTH) continue;
      visited.add(file);

      if (isTestFile(file) && !allDirectTests.has(file) && !transitiveTests.has(file)) {
        transitiveTests.set(file, firstHop!);
      }

      for (const next of reverseAdj.get(file) ?? []) {
        if (!visited.has(next)) {
          queue.push({ file: next, depth: depth + 1, firstHop: firstHop });
        }
      }
    }
  }

  const integrationTests = [...transitiveTests.entries()]
    .slice(0, MAX_INTEGRATION_TESTS)
    .map(([file, via]) => ({ file, via }));

  // 2. Transitive reach (who depends on changed files, beyond depth 1)
  let transitiveReach = 0;
  {
    const directDependents = new Set<string>();
    const allReached = new Set<string>();

    for (const changedFile of validFiles) {
      allReached.add(changedFile);
      for (const dep of reverseAdj.get(changedFile) ?? []) {
        directDependents.add(dep);
        allReached.add(dep);
      }
    }

    // BFS beyond direct dependents
    const queue = [...directDependents];
    const visited = new Set(allReached);

    while (queue.length > 0) {
      const current = queue.shift()!;
      for (const next of reverseAdj.get(current) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          allReached.add(next);
          queue.push(next);
        }
      }
    }

    // Transitive reach = total reached minus changed files minus direct dependents
    transitiveReach = allReached.size - validFiles.length - directDependents.size;
    if (transitiveReach < 0) transitiveReach = 0;
  }

  // 3. Hidden co-change (structural mismatches involving changed files)
  const hiddenCoChange = graph.structuralMismatches
    .filter((m) => validFiles.includes(m.fileA) || validFiles.includes(m.fileB))
    .map((m) => ({
      file: validFiles.includes(m.fileA) ? m.fileB : m.fileA,
      confidence: m.coChangeConfidence,
      coChangeCount: m.coChangeCount,
    }))
    .sort((a, b) => b.confidence - a.confidence)
    .slice(0, MAX_HIDDEN_COCHANGE);

  // 4. Risk assessment
  const risk = computeRisk(graph, validFiles);

  // 5. Community crossing
  let communityCrossing: ImpactData["communityCrossing"];
  const communityIds = new Set<number>();
  for (const f of validFiles) {
    const cid = graph.files[f].communityId;
    if (cid !== null) communityIds.add(cid);
  }
  if (communityIds.size > 1) {
    const communities = [...communityIds]
      .map((id) => graph.communities.find((c) => c.id === id))
      .filter((c): c is NonNullable<typeof c> => !!c)
      .map((c) => ({ id: c.id, label: c.label }));
    communityCrossing = { communities };
  }

  const data: ImpactData = {
    integrationTests,
    transitiveReach,
    hiddenCoChange,
    risk,
    communityCrossing,
  };

  return formatImpact(data);
}

function normalizePath(p: string): string {
  return p.replace(/^\.\//, "").replace(/\\/g, "/");
}

/**
 * Build reverse adjacency map (to -> from[]) from persisted edges.
 */
function buildReverseAdjacency(graph: PersistedGraph): Map<string, string[]> {
  const rev = new Map<string, string[]>();
  for (const edge of graph.edges) {
    let arr = rev.get(edge.to);
    if (!arr) {
      arr = [];
      rev.set(edge.to, arr);
    }
    arr.push(edge.from);
  }
  return rev;
}

/**
 * Find test files that exercise a target file transitively through import chains.
 * Excludes tests already in the directTests set (agent finds those via glob).
 */
function findTransitiveTests(
  reverseAdj: Map<string, string[]>,
  target: string,
  directTests: Set<string>,
  graph: PersistedGraph,
): string[] {
  const results: string[] = [];
  const visited = new Set<string>([target]);
  const queue: Array<{ file: string; depth: number }> = [];

  for (const importer of reverseAdj.get(target) ?? []) {
    queue.push({ file: importer, depth: 1 });
  }

  while (queue.length > 0 && results.length < MAX_INTEGRATION_TESTS) {
    const { file, depth } = queue.shift()!;
    if (visited.has(file) || depth > MAX_BFS_DEPTH) continue;
    visited.add(file);

    if (isTestFile(file) && !directTests.has(file)) {
      results.push(file);
    }

    for (const next of reverseAdj.get(file) ?? []) {
      if (!visited.has(next)) {
        queue.push({ file: next, depth: depth + 1 });
      }
    }
  }

  return results;
}

/**
 * Compute a composite risk score for the set of changed files.
 * Returns the max-risk file with a human-readable reason.
 */
function computeRisk(graph: PersistedGraph, changedFiles: string[]): { level: string; reason: string } {
  let maxScore = 0;
  let maxFile = changedFiles[0];
  let reasons: string[] = [];

  for (const f of changedFiles) {
    const file = graph.files[f];
    if (!file) continue;

    let score = 0;
    const fileReasons: string[] = [];

    // Betweenness weight (0.4)
    score += file.betweenness * 0.4;
    if (file.betweenness > 0.3) {
      fileReasons.push(`flow bottleneck (betweenness: ${Math.round(file.betweenness * 100)}%)`);
    }

    // Chokepoint weight (0.3)
    if (file.isChokepoint) {
      score += 0.3;
      fileReasons.push(`chokepoint (separates ${file.separatesComponents} components)`);
    }

    // Role weight (0.2 Foundation, 0.1 Bridge)
    if (file.role === "Foundation") {
      score += 0.2;
      fileReasons.push("Foundation");
    } else if (file.role === "Bridge") {
      score += 0.1;
      fileReasons.push("Bridge");
    }

    // High instability weight (0.1)
    if (file.instability !== null && file.instability > 0.8) {
      score += 0.1;
      fileReasons.push("high instability");
    }

    if (score > maxScore) {
      maxScore = score;
      maxFile = f;
      reasons = fileReasons;
    }
  }

  let level: string;
  if (maxScore >= 0.5) level = "high";
  else if (maxScore >= 0.25) level = "medium";
  else level = "low";

  const reason = reasons.length > 0 ? `${maxFile}: ${reasons.join(" + ")}` : `${maxFile}: no elevated risk factors`;

  return { level, reason };
}
