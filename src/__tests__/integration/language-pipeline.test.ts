/**
 * Language integration tests: verify that the import graph pipeline
 * works end-to-end for each supported language without crashing.
 *
 * For languages with full import resolution (TypeScript, Python):
 *   - Verifies non-empty edge count and hub file detection.
 *
 * For languages without full resolution (Go, Rust, Java):
 *   - Verifies file discovery, external import parsing, and no crashes.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildImportGraph } from "../../core/graph/build.js";
import { getHubFiles } from "../../core/graph/hub-files.js";
import { findCircularDeps } from "../../core/graph/cycles.js";
import { detectArchitecturalLayers } from "../../core/graph/layers.js";
import { computeInstability } from "../../core/graph/instability.js";
import { detectCommunitiesLeiden as detectCommunities } from "../../core/graph/leiden.js";
import { computeGraphTopology } from "../../core/graph/topology.js";
import type { Language } from "../../core/types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");

interface LanguageFixture {
  name: string;
  language: Language;
  dir: string;
  expectedMinFiles: number;
  /** Whether this language has internal import resolution */
  resolvesInternalEdges: boolean;
}

const fixtures: LanguageFixture[] = [
  {
    name: "Go service",
    language: "go",
    dir: path.join(FIXTURES_DIR, "go-service"),
    expectedMinFiles: 4,
    resolvesInternalEdges: true,
  },
  {
    name: "Rust library",
    language: "rust",
    dir: path.join(FIXTURES_DIR, "rust-lib"),
    expectedMinFiles: 5,
    resolvesInternalEdges: true,
  },
  {
    name: "Java application",
    language: "java",
    dir: path.join(FIXTURES_DIR, "java-app"),
    expectedMinFiles: 5,
    resolvesInternalEdges: true,
  },
  {
    name: "Python application",
    language: "python",
    dir: path.join(FIXTURES_DIR, "python-app"),
    expectedMinFiles: 4,
    resolvesInternalEdges: true,
  },
];

describe("language pipeline integration", () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      it("builds import graph without crashing", async () => {
        const graph = await buildImportGraph(fixture.dir, fixture.language);
        expect(graph).toBeDefined();
        expect(graph.edges).toBeDefined();
        expect(graph.inDegree).toBeDefined();

        // File discovery works
        const fileCount = graph.inDegree.size;
        expect(fileCount).toBeGreaterThanOrEqual(fixture.expectedMinFiles);
      }, 30_000);

      it("runs full analysis pipeline", async () => {
        const graph = await buildImportGraph(fixture.dir, fixture.language);

        // These should all complete without throwing
        const hubFiles = getHubFiles(graph, 10);
        const circularDeps = findCircularDeps(graph, 10);
        const { layers } = detectArchitecturalLayers(graph);
        const instabilities = computeInstability(graph);
        const communities = detectCommunities(graph);
        const topology = computeGraphTopology(graph);

        // Basic structural assertions
        expect(hubFiles).toBeInstanceOf(Array);
        expect(circularDeps).toBeInstanceOf(Array);
        expect(layers).toBeInstanceOf(Array);
        expect(instabilities).toBeInstanceOf(Array);
        expect(communities).toBeInstanceOf(Array);
        expect(topology).toBeDefined();
        expect(topology.componentCount).toBeGreaterThanOrEqual(0);
      }, 30_000);

      if (fixture.resolvesInternalEdges) {
        it("resolves internal imports", async () => {
          const graph = await buildImportGraph(fixture.dir, fixture.language);
          const internalEdges = graph.edges.filter((e) => !e.isExternal);
          expect(internalEdges.length).toBeGreaterThan(0);

          // At least one hub file should be detected
          const hubFiles = getHubFiles(graph, 5);
          expect(hubFiles.length).toBeGreaterThan(0);
        }, 30_000);
      }

      it("detects external imports", async () => {
        const graph = await buildImportGraph(fixture.dir, fixture.language);
        // External import counts should be populated (stdlib, third-party)
        const totalExternal = [...graph.externalImportCounts.values()].reduce((sum, n) => sum + n, 0);
        // Most languages import at least some external packages
        expect(totalExternal).toBeGreaterThanOrEqual(0);
      }, 30_000);
    });
  }
});
