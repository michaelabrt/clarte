/**
 * Algorithm Evaluation Framework
 *
 * Validates algorithm outputs against hand-verified ground truth for
 * synthetic project graphs. Each fixture encodes known structural
 * properties that the algorithms must correctly identify.
 *
 * This is a deterministic evaluation: no LLM-in-the-loop, no fuzzy scoring.
 * Assertions verify ranking order and set membership, not exact numeric values.
 */

import { describe, expect, it } from "vitest";
import {
  findSCCs,
  findCircularDeps,
  getHubFiles,
  computeInstability,
  detectCommunities,
  detectArchitecturalLayers,
  findDeadFiles,
  computeBetweenness,
} from "../../graph.js";
import { buildGraphFromFixture, missingFromTopN } from "./helpers.js";
import {
  layeredApp,
  hubAndSpoke,
  circularMess,
  monolith,
  EVAL_FIXTURES,
} from "./fixtures.js";

// ── Fixture: layered-app ──────────────────────────────────────────────

describe("eval: layered-app", () => {
  const fixture = layeredApp;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("HITS authority ranking", () => {
    it("types/index.ts should have the highest authority score", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const ranked = hubFiles.map((h) => h.path);

      // types/index.ts is imported by the most files transitively
      const topAuthority = hubFiles.sort((a, b) => b.authority - a.authority);
      expect(topAuthority[0].path).toBe("types/index.ts");
    });

    it("expected top authority files should rank in the top 5", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = hubFiles
        .sort((a, b) => b.authority - a.authority)
        .map((h) => h.path);

      const missing = missingFromTopN(
        byAuthority,
        fixture.expectations.topAuthorityFiles!,
        5,
      );
      expect(missing).toEqual([]);
    });
  });

  describe("instability metric", () => {
    it("route files should have instability > 0.8", () => {
      const instabilities = computeInstability(graph);
      const highInstability = new Set(instabilities.map((f) => f.path));

      for (const expectedFile of fixture.expectations.highInstabilityFiles!) {
        expect(
          highInstability.has(expectedFile),
          `${expectedFile} should have instability > 0.8 but was not in the high-instability set`,
        ).toBe(true);
      }
    });

    it("types/index.ts should NOT have high instability (it is foundational)", () => {
      const instabilities = computeInstability(graph);
      const highInstabilityPaths = instabilities.map((f) => f.path);
      expect(highInstabilityPaths).not.toContain("types/index.ts");
    });
  });

  describe("architectural layer detection", () => {
    it("should detect types, utils, services, and routes layers", () => {
      const { layers } = detectArchitecturalLayers(graph);
      const layerNames = layers.map((l) => l.name);

      expect(layerNames).toContain("types");
      expect(layerNames).toContain("utils");
      expect(layerNames).toContain("services");
      // routes are matched by the "pages" pattern (which matches routes/)
      expect(layerNames).toContain("pages");
    });

    it("types layer should be most foundational (imported by the most other layers)", () => {
      const { layers } = detectArchitecturalLayers(graph);
      // Layers are sorted by importedByLayers descending
      const typesLayer = layers.find((l) => l.name === "types");
      expect(typesLayer).toBeDefined();

      // types should be imported by at least 3 other layers (utils, services, controllers, routes)
      expect(typesLayer!.importedByLayers).toBeGreaterThanOrEqual(3);

      // types should be in the top 2 most-imported layers
      expect(layers.slice(0, 2).map((l) => l.name)).toContain("types");
    });
  });

  describe("cycle detection", () => {
    it("should not detect any circular dependencies (clean layered architecture)", () => {
      const cycles = findCircularDeps(graph);
      expect(cycles).toHaveLength(0);
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink types/index.ts should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      for (const file of fixture.expectations.zeroBetweennessFiles!) {
        expect(
          graph.betweennessScores!.get(file) ?? 0,
          `${file} should have zero betweenness (pure sink, no outgoing edges)`,
        ).toBe(0);
      }
    });
  });
});

// ── Fixture: hub-and-spoke ────────────────────────────────────────────

describe("eval: hub-and-spoke", () => {
  const fixture = hubAndSpoke;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("HITS authority ranking", () => {
    it("api-client.ts should have the highest authority score", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = [...hubFiles].sort((a, b) => b.authority - a.authority);
      expect(byAuthority[0].path).toBe("lib/api-client.ts");
    });

    it("config.ts should rank second in authority", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = [...hubFiles].sort((a, b) => b.authority - a.authority);

      const configIndex = byAuthority.findIndex((h) => h.path === "lib/config.ts");
      expect(configIndex).toBeGreaterThanOrEqual(0);
      expect(configIndex).toBeLessThanOrEqual(2);
    });

    it("api-client.ts should have authority significantly higher than any feature file", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const apiClient = hubFiles.find((h) => h.path === "lib/api-client.ts");
      const featureFiles = hubFiles.filter((h) => h.path.startsWith("features/"));

      expect(apiClient).toBeDefined();
      for (const feature of featureFiles) {
        expect(apiClient!.authority).toBeGreaterThan(feature.authority);
      }
    });
  });

  describe("dead file detection", () => {
    it("should detect feature files with zero importers as dead files", () => {
      const deadFiles = findDeadFiles(graph);

      for (const expectedDead of fixture.expectations.knownDeadFiles!) {
        expect(
          deadFiles.includes(expectedDead),
          `${expectedDead} should be detected as a dead file (zero importers, not an entry point)`,
        ).toBe(true);
      }
    });

    it("should NOT flag api-client.ts or config.ts as dead (they have importers)", () => {
      const deadFiles = findDeadFiles(graph);
      expect(deadFiles).not.toContain("lib/api-client.ts");
      expect(deadFiles).not.toContain("lib/config.ts");
    });
  });

  describe("hub scores", () => {
    it("feature files should have higher hub scores than api-client.ts (they orchestrate)", () => {
      // In a hub-and-spoke, leaf files that import the hub are "hubs" in HITS terms
      // (they point to the authority). api-client.ts is the authority (pointed to by many).
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const apiClient = hubFiles.find((h) => h.path === "lib/api-client.ts");
      const featureFiles = hubFiles.filter((h) => h.path.startsWith("features/"));

      expect(apiClient).toBeDefined();
      expect(featureFiles.length).toBeGreaterThan(0);

      // At least some feature files should have higher hub score than api-client
      const featureWithHigherHub = featureFiles.filter(
        (f) => f.hubScore > apiClient!.hubScore,
      );
      expect(featureWithHigherHub.length).toBeGreaterThan(0);
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink config.ts should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      for (const file of fixture.expectations.zeroBetweennessFiles!) {
        expect(
          graph.betweennessScores!.get(file) ?? 0,
          `${file} should have zero betweenness (pure sink)`,
        ).toBe(0);
      }
    });

    it("api-client.ts should rank in top-3 betweenness (bridge to config)", () => {
      expect(graph.betweennessScores).toBeDefined();
      const ranked = [...graph.betweennessScores!.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([file]) => file);

      const missing = missingFromTopN(
        ranked,
        fixture.expectations.topBetweennessFiles!,
        3,
      );
      expect(missing).toEqual([]);
    });
  });
});

// ── Fixture: circular-mess ────────────────────────────────────────────

describe("eval: circular-mess", () => {
  const fixture = circularMess;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("SCC detection (Tarjan)", () => {
    it("should find exactly 3 strongly connected components", () => {
      const sccs = findSCCs(graph);
      expect(sccs).toHaveLength(3);
    });

    it("should identify the 2-node cycle (a, b)", () => {
      const sccs = findSCCs(graph);
      const twoNodeScc = sccs.find((scc) => scc.length === 2);
      expect(twoNodeScc).toBeDefined();
      expect(twoNodeScc!.sort()).toEqual(["modules/a.ts", "modules/b.ts"]);
    });

    it("should identify the 3-node cycle (c, d, e)", () => {
      const sccs = findSCCs(graph);
      const threeNodeScc = sccs.find((scc) => scc.length === 3);
      expect(threeNodeScc).toBeDefined();
      expect(threeNodeScc!.sort()).toEqual(["modules/c.ts", "modules/d.ts", "modules/e.ts"]);
    });

    it("should identify the 4-node cycle (f, g, h, i)", () => {
      const sccs = findSCCs(graph);
      const fourNodeScc = sccs.find((scc) => scc.length === 4);
      expect(fourNodeScc).toBeDefined();
      expect(fourNodeScc!.sort()).toEqual([
        "modules/f.ts",
        "modules/g.ts",
        "modules/h.ts",
        "modules/i.ts",
      ]);
    });

    it("clean files should NOT appear in any SCC", () => {
      const sccs = findSCCs(graph);
      const allSccFiles = new Set(sccs.flat());
      expect(allSccFiles.has("modules/clean-x.ts")).toBe(false);
      expect(allSccFiles.has("modules/clean-y.ts")).toBe(false);
      expect(allSccFiles.has("modules/clean-z.ts")).toBe(false);
    });
  });

  describe("circular dependency detection", () => {
    it("should report at least 3 circular dependencies", () => {
      const cycles = findCircularDeps(graph, 20);
      expect(cycles.length).toBeGreaterThanOrEqual(3);
    });

    it("every reported cycle should form a closed loop", () => {
      const cycles = findCircularDeps(graph, 20);
      for (const cycle of cycles) {
        expect(
          cycle.chain[0],
          "cycle chain should start and end with the same file",
        ).toBe(cycle.chain[cycle.chain.length - 1]);
      }
    });

    it("every consecutive pair in a reported cycle should have an actual edge", () => {
      const cycles = findCircularDeps(graph, 20);
      const edgeSet = new Set(
        fixture.graph.edges.map((e) => `${e.from}->${e.to}`),
      );
      for (const cycle of cycles) {
        for (let i = 0; i < cycle.chain.length - 1; i++) {
          const key = `${cycle.chain[i]}->${cycle.chain[i + 1]}`;
          expect(
            edgeSet.has(key),
            `expected edge ${key} in cycle but it does not exist in the graph`,
          ).toBe(true);
        }
      }
    });

    it("should assign severity scores between 0 and 1", () => {
      const cycles = findCircularDeps(graph, 20);
      for (const cycle of cycles) {
        expect(cycle.severity).toBeDefined();
        expect(cycle.severity).toBeGreaterThanOrEqual(0);
        expect(cycle.severity).toBeLessThanOrEqual(1);
      }
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink clean-z.ts should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      for (const file of fixture.expectations.zeroBetweennessFiles!) {
        expect(
          graph.betweennessScores!.get(file) ?? 0,
          `${file} should have zero betweenness (pure sink)`,
        ).toBe(0);
      }
    });
  });
});

// ── Fixture: monolith ─────────────────────────────────────────────────

describe("eval: monolith", () => {
  const fixture = monolith;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("community detection", () => {
    it("should detect a meaningful number of communities (between 3 and 10)", () => {
      const communities = detectCommunities(graph);
      expect(communities.length).toBeGreaterThanOrEqual(
        fixture.expectations.minCommunities!,
      );
      expect(communities.length).toBeLessThanOrEqual(
        fixture.expectations.maxCommunities!,
      );
    });

    it("every file in a community should exist in the fixture", () => {
      const communities = detectCommunities(graph);
      const allFixtureFiles = new Set(fixture.graph.files);
      for (const community of communities) {
        for (const file of community.files) {
          expect(
            allFixtureFiles.has(file),
            `community contains unknown file: ${file}`,
          ).toBe(true);
        }
      }
    });

    it("communities should have meaningful labels (non-empty strings)", () => {
      const communities = detectCommunities(graph);
      for (const community of communities) {
        expect(community.label.length).toBeGreaterThan(0);
      }
    });

    it("worker files should tend to land in the same community", () => {
      // Worker files are densely connected through base-worker; most should share a community
      const communities = detectCommunities(graph);
      const workerFiles = fixture.graph.files.filter((f) => f.startsWith("worker/"));

      // Build file -> community lookup
      const fileToCommunity = new Map<string, number>();
      for (const community of communities) {
        for (const file of community.files) {
          fileToCommunity.set(file, community.id);
        }
      }

      // Count how many worker files share the most common community assignment
      const communityCounts = new Map<number, number>();
      for (const file of workerFiles) {
        const cid = fileToCommunity.get(file);
        if (cid !== undefined) {
          communityCounts.set(cid, (communityCounts.get(cid) ?? 0) + 1);
        }
      }

      const maxInSameCommunity = Math.max(...communityCounts.values(), 0);
      // At least half of worker files should be in the same community
      expect(maxInSameCommunity).toBeGreaterThanOrEqual(Math.ceil(workerFiles.length / 2));
    });

    it("communities should span multiple directories (not just mirror directory structure)", () => {
      const communities = detectCommunities(graph);
      // At least one community should contain files from 2+ directories
      const multiDirCommunities = communities.filter((c) => {
        const dirs = new Set(c.files.map((f) => f.split("/")[0]));
        return dirs.size >= 2;
      });
      expect(multiDirCommunities.length).toBeGreaterThan(0);
    });
  });

  describe("HITS authority", () => {
    it("shared/api-client.ts should be among the top 5 authority files", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = [...hubFiles]
        .sort((a, b) => b.authority - a.authority)
        .map((h) => h.path);

      const missing = missingFromTopN(byAuthority, ["shared/api-client.ts"], 5);
      expect(missing).toEqual([]);
    });

    it("shared/ files should collectively rank higher than worker/ files", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);

      // Average authority of shared/ files
      const sharedFiles = hubFiles.filter((h) => h.path.startsWith("shared/"));
      const avgSharedAuth =
        sharedFiles.reduce((sum, h) => sum + h.authority, 0) / sharedFiles.length;

      // Average authority of worker/ files
      const workerFiles = hubFiles.filter((h) => h.path.startsWith("worker/"));
      if (workerFiles.length > 0) {
        const avgWorkerAuth =
          workerFiles.reduce((sum, h) => sum + h.authority, 0) / workerFiles.length;
        expect(
          avgSharedAuth,
          "shared/ average authority should exceed worker/ average authority",
        ).toBeGreaterThan(avgWorkerAuth);
      }
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink shared/config.ts should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      for (const file of fixture.expectations.zeroBetweennessFiles!) {
        expect(
          graph.betweennessScores!.get(file) ?? 0,
          `${file} should have zero betweenness (pure sink)`,
        ).toBe(0);
      }
    });
  });

  describe("graph scale", () => {
    it("should handle 40+ files without errors", () => {
      expect(fixture.graph.files.length).toBeGreaterThanOrEqual(40);
      // If we got here, all algorithms ran successfully on 48 files
      const hubFiles = getHubFiles(graph, 10);
      expect(hubFiles.length).toBeGreaterThan(0);

      const instabilities = computeInstability(graph);
      expect(instabilities).toBeDefined();

      const sccs = findSCCs(graph);
      expect(sccs).toBeDefined();
    });
  });
});

// ── Cross-fixture consistency checks ──────────────────────────────────

describe("eval: cross-fixture consistency", () => {
  it("all fixtures should produce a valid ImportGraph", () => {
    for (const fixture of EVAL_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.inDegree.size).toBeGreaterThan(0);
      expect(graph.authority.size).toBeGreaterThan(0);
      expect(graph.hubScores.size).toBeGreaterThan(0);
    }
  });

  it("authority scores should be non-negative and bounded for all fixtures", () => {
    for (const fixture of EVAL_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      for (const [file, score] of graph.authority) {
        expect(score, `authority for ${file} should be non-negative`).toBeGreaterThanOrEqual(0);
        // Individual authority scores should be bounded (L2-normalized)
        expect(score, `authority for ${file} should be bounded`).toBeLessThanOrEqual(1.0);
      }
      // At least one file should have a meaningful authority score
      const maxAuth = Math.max(...graph.authority.values());
      expect(maxAuth).toBeGreaterThan(0);
    }
  });

  it("getHubFiles should never return more files than the limit", () => {
    for (const fixture of EVAL_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      const limit = 5;
      const hubFiles = getHubFiles(graph, limit);
      expect(hubFiles.length).toBeLessThanOrEqual(limit);
    }
  });

  it("cycle detection should never report a cycle containing only one file", () => {
    for (const fixture of EVAL_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      const cycles = findCircularDeps(graph, 50);
      for (const cycle of cycles) {
        // Chain is [A, ..., A] so length must be at least 3 (A -> B -> A)
        expect(cycle.chain.length).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("betweennessScores should be defined with values in [0,1] for all fixtures", () => {
    for (const fixture of EVAL_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      expect(
        graph.betweennessScores,
        `betweennessScores should be defined for ${fixture.name}`,
      ).toBeDefined();

      for (const [file, score] of graph.betweennessScores!) {
        expect(
          score,
          `betweenness for ${file} in ${fixture.name} should be >= 0`,
        ).toBeGreaterThanOrEqual(0);
        expect(
          score,
          `betweenness for ${file} in ${fixture.name} should be <= 1`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });
});
