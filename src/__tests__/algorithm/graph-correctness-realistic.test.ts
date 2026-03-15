/**
 * Agent Performance Benchmark (§3.61)
 *
 * Validates all algorithms against realistic project graphs that model
 * real-world architectures (React fullstack, Python backend). These are
 * higher-fidelity than the core eval fixtures and test precision/recall
 * across the full algorithm suite.
 *
 * Deterministic evaluation: no LLM-in-the-loop, no fuzzy scoring.
 */

import { describe, expect, it } from "vitest";
import { findSCCs, findCircularDeps } from "../../core/graph/cycles.js";
import { getHubFiles } from "../../core/graph/hub-files.js";
import { computeInstability } from "../../core/graph/instability.js";
import { detectCommunities } from "../../core/graph/communities.js";
import { detectArchitecturalLayers } from "../../core/graph/layers.js";
import { findDeadFiles } from "../../core/graph/dead-files.js";
import { findChokepoints } from "../../core/graph/chokepoints.js";
import { buildGraphFromFixture, missingFromTopN } from "./helpers.js";
import { reactFullstack, pythonBackend, BENCHMARK_FIXTURES } from "./benchmark-fixtures.js";

// ── Fixture: react-fullstack ────────────────────────────────────────

describe("benchmark: react-fullstack", () => {
  const fixture = reactFullstack;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("HITS authority ranking", () => {
    it("expected top authority files should rank in the top 5", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = [...hubFiles].sort((a, b) => b.authority - a.authority).map((h) => h.path);

      if (fixture.expectations.topAuthorityFiles) {
        const missing = missingFromTopN(byAuthority, fixture.expectations.topAuthorityFiles, 5);
        expect(missing).toEqual([]);
      }
    });

    it("types/user.ts should have higher authority than any page file", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const userTypes = hubFiles.find((h) => h.path === "types/user.ts");
      const pageFiles = hubFiles.filter((h) => h.path.startsWith("pages/"));

      if (userTypes) {
        for (const page of pageFiles) {
          expect(userTypes.authority).toBeGreaterThan(page.authority);
        }
      }
    });
  });

  describe("instability metric", () => {
    it("page files should have high instability (> 0.8)", () => {
      const instabilities = computeInstability(graph);
      const highInstabilityPaths = new Set(instabilities.map((f) => f.path));

      if (fixture.expectations.highInstabilityFiles) {
        for (const expected of fixture.expectations.highInstabilityFiles) {
          expect(highInstabilityPaths.has(expected), `${expected} should have instability > 0.8`).toBe(true);
        }
      }
    });

    it("stable files should NOT have high instability", () => {
      const instabilities = computeInstability(graph);
      const highInstabilityPaths = new Set(instabilities.map((f) => f.path));

      if (fixture.expectations.stableFiles) {
        for (const stable of fixture.expectations.stableFiles) {
          expect(highInstabilityPaths.has(stable), `${stable} should be stable (not high instability)`).toBe(false);
        }
      }
    });
  });

  describe("architectural layer detection", () => {
    it("should detect expected layers", () => {
      const { layers } = detectArchitecturalLayers(graph);
      const layerNames = layers.map((l) => l.name);

      if (fixture.expectations.expectedLayerOrder) {
        for (const expected of fixture.expectations.expectedLayerOrder) {
          expect(layerNames, `should detect "${expected}" layer`).toContain(expected);
        }
      }
    });

    it("types layer should be among the most foundational", () => {
      const { layers } = detectArchitecturalLayers(graph);
      const typesLayer = layers.find((l) => l.name === "types");
      expect(typesLayer).toBeDefined();
      // types should be in the top 3 most-imported layers
      expect(layers.slice(0, 3).map((l) => l.name)).toContain("types");
    });
  });

  describe("cycle detection", () => {
    it("should detect the auth-store <-> use-auth cycle", () => {
      const cycles = findCircularDeps(graph, 20);
      expect(cycles.length).toBeGreaterThanOrEqual(1);

      // The cycle should involve both files
      const cycleFiles = new Set(cycles.flatMap((c) => c.chain));
      expect(cycleFiles.has("stores/auth-store.ts")).toBe(true);
      expect(cycleFiles.has("hooks/use-auth.ts")).toBe(true);
    });

    it("SCC should contain the cycle pair", () => {
      const sccs = findSCCs(graph);
      const authScc = sccs.find((scc) => scc.includes("stores/auth-store.ts") && scc.includes("hooks/use-auth.ts"));
      if (authScc) {
        expect(authScc.length).toBe(2);
      }
    });
  });

  describe("chokepoint detection", () => {
    it("should detect known chokepoints", () => {
      const chokepoints = findChokepoints(graph);
      const chokepointFiles = chokepoints.map((c) => c.file);

      if (fixture.expectations.knownChokepoints) {
        for (const expected of fixture.expectations.knownChokepoints) {
          expect(chokepointFiles, `${expected} should be detected as a chokepoint`).toContain(expected);
        }
      }
    });
  });

  describe("community detection", () => {
    it("should detect a reasonable number of communities", () => {
      const communities = detectCommunities(graph);
      if (fixture.expectations.minCommunities !== undefined && fixture.expectations.maxCommunities !== undefined) {
        expect(communities.length).toBeGreaterThanOrEqual(fixture.expectations.minCommunities);
        expect(communities.length).toBeLessThanOrEqual(fixture.expectations.maxCommunities);
      }
    });

    it("every file in a community should exist in the fixture", () => {
      const communities = detectCommunities(graph);
      const allFixtureFiles = new Set(fixture.graph.files);
      for (const community of communities) {
        for (const file of community.files) {
          expect(allFixtureFiles.has(file), `community contains unknown file: ${file}`).toBe(true);
        }
      }
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink config/env.ts should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      if (fixture.expectations.zeroBetweennessFiles && graph.betweennessScores) {
        for (const file of fixture.expectations.zeroBetweennessFiles) {
          expect(graph.betweennessScores.get(file) ?? 0, `${file} should have zero betweenness (pure sink)`).toBe(0);
        }
      }
    });
  });
});

// ── Fixture: python-backend ─────────────────────────────────────────

describe("benchmark: python-backend", () => {
  const fixture = pythonBackend;
  const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

  describe("HITS authority ranking", () => {
    it("expected top authority files should rank in the top 5", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const byAuthority = [...hubFiles].sort((a, b) => b.authority - a.authority).map((h) => h.path);

      if (fixture.expectations.topAuthorityFiles) {
        const missing = missingFromTopN(byAuthority, fixture.expectations.topAuthorityFiles, 5);
        expect(missing).toEqual([]);
      }
    });

    it("core files should have higher authority than route files", () => {
      const hubFiles = getHubFiles(graph, fixture.graph.files.length);
      const coreFiles = hubFiles.filter((h) => h.path.startsWith("core/"));
      const routeFiles = hubFiles.filter((h) => h.path.startsWith("routes/"));

      const avgCoreAuth = coreFiles.reduce((sum, h) => sum + h.authority, 0) / coreFiles.length;
      const avgRouteAuth = routeFiles.reduce((sum, h) => sum + h.authority, 0) / routeFiles.length;

      expect(avgCoreAuth).toBeGreaterThan(avgRouteAuth);
    });
  });

  describe("instability metric", () => {
    it("route files should have high instability (> 0.8)", () => {
      const instabilities = computeInstability(graph);
      const highInstabilityPaths = new Set(instabilities.map((f) => f.path));

      if (fixture.expectations.highInstabilityFiles) {
        for (const expected of fixture.expectations.highInstabilityFiles) {
          expect(highInstabilityPaths.has(expected), `${expected} should have instability > 0.8`).toBe(true);
        }
      }
    });

    it("stable files should NOT have high instability", () => {
      const instabilities = computeInstability(graph);
      const highInstabilityPaths = new Set(instabilities.map((f) => f.path));

      if (fixture.expectations.stableFiles) {
        for (const stable of fixture.expectations.stableFiles) {
          expect(highInstabilityPaths.has(stable), `${stable} should be stable (not high instability)`).toBe(false);
        }
      }
    });
  });

  describe("architectural layer detection", () => {
    it("should detect expected layers", () => {
      const { layers } = detectArchitecturalLayers(graph);
      const layerNames = layers.map((l) => l.name);

      if (fixture.expectations.expectedLayerOrder) {
        for (const expected of fixture.expectations.expectedLayerOrder) {
          expect(layerNames, `should detect "${expected}" layer`).toContain(expected);
        }
      }
    });
  });

  describe("cycle detection", () => {
    it("should detect no cycles (clean architecture)", () => {
      const cycles = findCircularDeps(graph);
      expect(cycles).toHaveLength(0);
    });

    it("should have no strongly connected components", () => {
      const sccs = findSCCs(graph);
      expect(sccs).toHaveLength(0);
    });
  });

  describe("chokepoint detection", () => {
    it("should detect core/database.py as a chokepoint", () => {
      const chokepoints = findChokepoints(graph);
      const chokepointFiles = chokepoints.map((c) => c.file);

      if (fixture.expectations.knownChokepoints) {
        for (const expected of fixture.expectations.knownChokepoints) {
          expect(chokepointFiles, `${expected} should be detected as a chokepoint`).toContain(expected);
        }
      }
    });
  });

  describe("community detection", () => {
    it("should detect a reasonable number of communities", () => {
      const communities = detectCommunities(graph);
      if (fixture.expectations.minCommunities !== undefined && fixture.expectations.maxCommunities !== undefined) {
        expect(communities.length).toBeGreaterThanOrEqual(fixture.expectations.minCommunities);
        expect(communities.length).toBeLessThanOrEqual(fixture.expectations.maxCommunities);
      }
    });
  });

  describe("betweenness centrality (directed)", () => {
    it("pure sink core/config.py should have zero betweenness", () => {
      expect(graph.betweennessScores).toBeDefined();
      if (fixture.expectations.zeroBetweennessFiles && graph.betweennessScores) {
        for (const file of fixture.expectations.zeroBetweennessFiles) {
          expect(graph.betweennessScores.get(file) ?? 0, `${file} should have zero betweenness (pure sink)`).toBe(0);
        }
      }
    });
  });
});

// ── Cross-benchmark consistency checks ──────────────────────────────

describe("benchmark: cross-fixture consistency", () => {
  it("all benchmark fixtures should produce a valid ImportGraph", () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);

      expect(graph.edges.length).toBeGreaterThan(0);
      expect(graph.inDegree.size).toBeGreaterThan(0);
      expect(graph.authority.size).toBeGreaterThan(0);
      expect(graph.hubScores.size).toBeGreaterThan(0);
    }
  });

  it("authority scores should be non-negative and bounded", () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      for (const [file, score] of graph.authority) {
        expect(score, `authority for ${file} should be non-negative`).toBeGreaterThanOrEqual(0);
        expect(score, `authority for ${file} should be bounded`).toBeLessThanOrEqual(1.0);
      }
    }
  });

  it("benchmark fixtures should be larger than core eval fixtures", () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      expect(fixture.graph.files.length).toBeGreaterThanOrEqual(25);
    }
  });

  it("dead file detection should not flag files with importers", () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      const deadFiles = findDeadFiles(graph);

      for (const dead of deadFiles) {
        const inDeg = graph.inDegree.get(dead) ?? 0;
        expect(inDeg, `dead file ${dead} should have zero importers`).toBe(0);
      }
    }
  });

  it("betweennessScores should be defined with values in [0,1] for all benchmark fixtures", () => {
    for (const fixture of BENCHMARK_FIXTURES) {
      const graph = buildGraphFromFixture(fixture.graph.files, fixture.graph.edges);
      expect(graph.betweennessScores, `betweennessScores should be defined for ${fixture.name}`).toBeDefined();

      if (graph.betweennessScores) {
        for (const [file, score] of graph.betweennessScores) {
          expect(score, `betweenness for ${file} in ${fixture.name} should be >= 0`).toBeGreaterThanOrEqual(0);
          expect(score, `betweenness for ${file} in ${fixture.name} should be <= 1`).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});
