/**
 * Multi-language HITS recomputation test.
 *
 * Verifies that merging per-language graphs and recomputing HITS produces
 * sensible scores. Without recomputation, per-language authority scores are
 * incommensurable (different convergence runs, different scales).
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph, mergeGraph } from "../../graph/build.js";
import { computeHITS, computeBetweenness } from "../../graph/centrality.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(__dirname, "fixtures", "ts-python-multi");

describe("multi-language HITS recomputation", () => {
  it("builds separate TS and Python graphs with independent HITS scores", async () => {
    const tsGraph = await buildImportGraph(FIXTURE, "typescript");
    const pyGraph = await buildImportGraph(FIXTURE, "python");

    // Both graphs should have files and edges
    expect(tsGraph.inDegree.size).toBeGreaterThan(0);
    expect(pyGraph.inDegree.size).toBeGreaterThan(0);
    expect(tsGraph.edges.length).toBeGreaterThan(0);
    expect(pyGraph.edges.length).toBeGreaterThan(0);

    // Authority scores should exist for each graph's files
    const tsAuthority = [...tsGraph.authority.values()].filter((v) => v > 0);
    const pyAuthority = [...pyGraph.authority.values()].filter((v) => v > 0);
    expect(tsAuthority.length).toBeGreaterThan(0);
    expect(pyAuthority.length).toBeGreaterThan(0);
  });

  it("recomputes HITS after merge to produce unified scores", async () => {
    const tsGraph = await buildImportGraph(FIXTURE, "typescript");
    const pyGraph = await buildImportGraph(FIXTURE, "python");

    // Merge Python into TS graph
    mergeGraph(tsGraph, pyGraph);

    // After merge, the graph should contain files from both languages
    const allFiles = [...tsGraph.inDegree.keys()];
    const tsFiles = allFiles.filter((f) => f.endsWith(".ts"));
    const pyFiles = allFiles.filter((f) => f.endsWith(".py"));
    expect(tsFiles.length).toBeGreaterThan(0);
    expect(pyFiles.length).toBeGreaterThan(0);

    // Without recomputation: TS files keep old authority, Python files have their own
    // These scores were computed in isolation and aren't comparable

    // Recompute HITS on the merged graph (this is what §1.28 fixed)
    const { authority: recomputedAuth, hub: recomputedHub } = computeHITS(
      allFiles,
      tsGraph.edges,
      30,
      1e-6,
      tsGraph.barrelFiles,
    );

    // Recomputed scores should cover all files from both languages
    const recomputedTsFiles = tsFiles.filter((f) => recomputedAuth.has(f));
    const recomputedPyFiles = pyFiles.filter((f) => recomputedAuth.has(f));
    expect(recomputedTsFiles.length).toBe(tsFiles.length);
    expect(recomputedPyFiles.length).toBe(pyFiles.length);

    // The hub that is most imported should have highest authority
    // In our fixture, types.ts and models.py are the "foundation" files
    // They should have non-zero authority
    const typesAuth = recomputedAuth.get("src/types.ts") ?? 0;
    const modelsAuth = recomputedAuth.get("lib/models.py") ?? 0;
    expect(typesAuth).toBeGreaterThan(0);
    expect(modelsAuth).toBeGreaterThan(0);

    // Server files (leaf nodes) should have lower or zero authority
    const serverTsAuth = recomputedAuth.get("src/server.ts") ?? 0;
    const serverPyAuth = recomputedAuth.get("lib/server.py") ?? 0;
    expect(typesAuth).toBeGreaterThanOrEqual(serverTsAuth);
    expect(modelsAuth).toBeGreaterThanOrEqual(serverPyAuth);

    // Hub scores: leaf files (servers) should have non-zero hub scores
    // (they import other modules)
    const serverTsHub = recomputedHub.get("src/server.ts") ?? 0;
    const serverPyHub = recomputedHub.get("lib/server.py") ?? 0;
    expect(serverTsHub).toBeGreaterThan(0);
    expect(serverPyHub).toBeGreaterThan(0);
  });

  it("recomputes betweenness on merged graph", async () => {
    const tsGraph = await buildImportGraph(FIXTURE, "typescript");
    const pyGraph = await buildImportGraph(FIXTURE, "python");

    mergeGraph(tsGraph, pyGraph);

    // Recompute HITS first (sets authority/centrality)
    const allFiles = [...tsGraph.inDegree.keys()];
    const { authority, hub } = computeHITS(allFiles, tsGraph.edges, 30, 1e-6, tsGraph.barrelFiles);
    tsGraph.authority = authority;
    tsGraph.hubScores = hub;
    tsGraph.centrality = authority;

    // Recompute betweenness
    const betweenness = computeBetweenness(tsGraph);

    // Betweenness should be computed for files from both languages
    expect(betweenness.size).toBeGreaterThan(0);

    // Middle files (db, api) should have non-zero betweenness
    // since they sit between leaf and foundation
    const hasNonZeroBetweenness = [...betweenness.values()].some((v) => v > 0);
    expect(hasNonZeroBetweenness).toBe(true);
  });
});
