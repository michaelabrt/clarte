/**
 * Golden-file tests for the full analysis pipeline.
 *
 * Runs buildImportGraph + all graph analysis on minimal fixture projects,
 * then compares the ContextAnalysis output against checked-in golden JSON.
 *
 * To update golden files after intentional changes:
 *   GOLDEN_UPDATE=1 npm test -- src/__tests__/golden/golden.test.ts
 */

import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
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
  findTightCouplings,
  computeGraphTopology,
  computeBetweenness,
} from "../../graph.js";
import type { ImportGraph } from "../../types.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "fixtures");
const GOLDEN_DIR = path.join(__dirname, "snapshots");
const UPDATE = process.env.GOLDEN_UPDATE === "1";

/** Serializable subset of ContextAnalysis (graph-derived, no Maps) */
interface GoldenAnalysis {
  fileCount: number;
  edgeCount: number;
  hubFiles: Array<{ path: string; authority: number }>;
  circularDeps: Array<{ chain: string[] }>;
  layers: Array<{ name: string; files: string[]; dependsOn: string[] }>;
  layerEdges: Array<{ from: string; to: string }>;
  instabilities: Array<{ file: string; instability: number }>;
  communityCount: number;
  communityFiles: string[][];
  deadFiles: string[];
  crossCuttingFiles: Array<{ file: string; layerSpread: number }>;
  layerConsistency: { consistency: number; violationCount: number } | null;
  chokepoints: Array<{ file: string; separates: number }>;
  tightCouplings: Array<{ from: string; to: string; importedNames: number }>;
  betweennessTopFiles: Array<{ file: string; score: number }>;
  graphTopology: {
    componentCount: number;
    componentSizes: number[];
    approximateDiameter: number;
    reachability: number;
    isFragmented: boolean;
  };
}

/**
 * Run the full graph analysis pipeline on a fixture directory and
 * return a normalized, serializable result object.
 */
async function analyzeFixture(
  fixtureDir: string,
  language: "typescript" | "python",
): Promise<GoldenAnalysis> {
  const graph: ImportGraph = await buildImportGraph(fixtureDir, language);

  const hubFiles = getHubFiles(graph, 10);
  const circularDeps = findCircularDeps(graph, 20);
  const { layers, layerEdges } = detectArchitecturalLayers(graph);
  const instabilities = computeInstability(graph);
  const communities = detectCommunities(graph);
  const deadFiles = findDeadFiles(graph);
  const crossCuttingFiles = findCrossCuttingFiles(graph, layers, 2);
  const layerConsistency =
    layers.length > 0
      ? computeLayerConsistency(graph, layers, layerEdges)
      : null;
  const chokepoints = findChokepoints(graph);
  const tightCouplings = findTightCouplings(graph, 2, 20);
  const betweenness = computeBetweenness(graph, graph.inDegree.size);
  const topology = computeGraphTopology(graph);

  // Normalize for stable JSON output: sort arrays by primary key
  return {
    fileCount: graph.inDegree.size,
    edgeCount: graph.edges.filter((e) => !e.isExternal).length,
    hubFiles: hubFiles
      .map((h) => ({ path: h.path, authority: round(h.authority) }))
      .sort((a, b) => a.path.localeCompare(b.path)),
    circularDeps: circularDeps
      .map((c) => ({ chain: [...c.chain].sort() }))
      .sort((a, b) => a.chain.join(",").localeCompare(b.chain.join(","))),
    layers: layers
      .map((l) => ({
        name: l.name,
        files: [...l.files].sort(),
        dependsOn: [...l.dependsOn].sort(),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    layerEdges: layerEdges
      .map((e) => ({ from: e.from, to: e.to }))
      .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`)),
    instabilities: instabilities
      .map((i) => ({ file: i.file, instability: round(i.instability) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    communityCount: communities.length,
    communityFiles: communities
      .map((c) => [...c.files].sort())
      .sort((a, b) => a.join(",").localeCompare(b.join(","))),
    deadFiles: [...deadFiles].sort(),
    crossCuttingFiles: crossCuttingFiles
      .map((c) => ({ file: c.file, layerSpread: c.layerSpread }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    layerConsistency: layerConsistency
      ? {
          consistency: round(layerConsistency.consistency),
          violationCount: layerConsistency.violations.length,
        }
      : null,
    chokepoints: chokepoints
      .map((c) => ({ file: c.file, separates: c.separates }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    tightCouplings: tightCouplings
      .map((t) => ({ from: t.from, to: t.to, importedNames: t.importedNames }))
      .sort((a, b) => `${a.from}>${a.to}`.localeCompare(`${b.from}>${b.to}`)),
    betweennessTopFiles: [...betweenness.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([file, score]) => ({ file, score: round(score) }))
      .sort((a, b) => a.file.localeCompare(b.file)),
    graphTopology: {
      componentCount: topology.componentCount,
      componentSizes: topology.componentSizes,
      approximateDiameter: topology.approximateDiameter,
      reachability: round(topology.reachability),
      isFragmented: topology.isFragmented,
    },
  };
}

function round(n: number): number {
  return Math.round(n * 10000) / 10000;
}

async function loadGolden(name: string): Promise<GoldenAnalysis | null> {
  const goldenPath = path.join(GOLDEN_DIR, `${name}.json`);
  try {
    const content = await fs.readFile(goldenPath, "utf-8");
    return JSON.parse(content);
  } catch {
    return null;
  }
}

async function saveGolden(name: string, data: GoldenAnalysis): Promise<void> {
  await fs.mkdir(GOLDEN_DIR, { recursive: true });
  const goldenPath = path.join(GOLDEN_DIR, `${name}.json`);
  await fs.writeFile(goldenPath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ── Fixture definitions ──────────────────────────────────────────────

interface FixtureDef {
  name: string;
  language: "typescript" | "python";
  /** Basic sanity assertions independent of golden file */
  sanity: (analysis: GoldenAnalysis) => void;
}

const fixtures: FixtureDef[] = [
  {
    name: "ts-layered",
    language: "typescript",
    sanity: (a) => {
      // 10 files: types/index, types/errors, utils/validate, utils/format,
      //           utils/logger, services/user-service, services/product-service,
      //           controllers/user-controller, controllers/product-controller, app
      expect(a.fileCount).toBe(10);
      expect(a.edgeCount).toBeGreaterThan(10);
      // types/index.ts should be a hub (imported by many files)
      expect(a.hubFiles.some((h) => h.path.includes("types/index"))).toBe(true);
      // Layered architecture should have multiple layers
      expect(a.layers.length).toBeGreaterThanOrEqual(3);
      // No circular deps in a clean layered project
      expect(a.circularDeps).toHaveLength(0);
    },
  },
  {
    name: "python-flask",
    language: "python",
    sanity: (a) => {
      expect(a.fileCount).toBeGreaterThanOrEqual(8);
      expect(a.edgeCount).toBeGreaterThan(5);
      // models/user.py should be a hub (imported by services and routes)
      expect(a.hubFiles.some((h) => h.path.includes("user"))).toBe(true);
    },
  },
  {
    name: "mixed-monorepo",
    language: "typescript",
    sanity: (a) => {
      // 9 files across 3 packages
      expect(a.fileCount).toBeGreaterThanOrEqual(8);
      expect(a.edgeCount).toBeGreaterThan(8);
      // core/src/types.ts or core/src/utils.ts should be hubs
      expect(
        a.hubFiles.some(
          (h) => h.path.includes("core/src/types") || h.path.includes("core/src/utils"),
        ),
      ).toBe(true);
      // Should detect at least one community
      expect(a.communityCount).toBeGreaterThanOrEqual(1);
      // Should have tight couplings across packages
      expect(a.tightCouplings.length).toBeGreaterThan(0);
    },
  },
  {
    name: "ts-bottleneck",
    language: "typescript",
    sanity: (a) => {
      // 9 files: features/a, features/b, features/c, features/d,
      //          core/router, core/handler, lib/utils, lib/db, lib/cache
      expect(a.fileCount).toBe(9);
      expect(a.edgeCount).toBeGreaterThanOrEqual(9);
      // router.ts should have high betweenness (4 features funnel through it)
      const router = a.betweennessTopFiles.find((f) => f.file.includes("router"));
      expect(router, "router.ts should be in top 5 betweenness").toBeDefined();
      expect(router!.score).toBeGreaterThan(0.3);
      // Pure sinks (db.ts, cache.ts) should have zero betweenness
      const db = a.betweennessTopFiles.find((f) => f.file.includes("db"));
      const cache = a.betweennessTopFiles.find((f) => f.file.includes("cache"));
      // Sinks may not be in top 5 (since scores are sorted desc), check via full data
      // if they appear, their score must be 0
      if (db) expect(db.score).toBe(0);
      if (cache) expect(cache.score).toBe(0);
    },
  },
];

// ── Tests ─────────────────────────────────────────────────────────────

describe("golden-file analysis", () => {
  for (const fixture of fixtures) {
    describe(fixture.name, () => {
      let analysis: GoldenAnalysis;

      it("runs the full analysis pipeline", async () => {
        const fixtureDir = path.join(FIXTURES_DIR, fixture.name);
        analysis = await analyzeFixture(fixtureDir, fixture.language);
        expect(analysis).toBeDefined();
        expect(analysis.fileCount).toBeGreaterThan(0);
      });

      it("passes sanity checks", () => {
        fixture.sanity(analysis);
      });

      it("matches golden snapshot", async () => {
        const golden = await loadGolden(fixture.name);

        if (UPDATE) {
          // Explicit update mode: regenerate golden file
          await saveGolden(fixture.name, analysis);
          console.log(`  [golden] ${golden ? "Updated" : "Created"} snapshot for ${fixture.name}`);
          return;
        }

        // Guard: golden file must exist in non-update mode (prevents silent self-seeding in CI)
        if (!golden) {
          throw new Error(
            `Golden snapshot missing for "${fixture.name}". Run GOLDEN_UPDATE=1 npx vitest to create it.`,
          );
        }

        // Compare key structural properties
        expect(analysis.fileCount).toBe(golden.fileCount);
        expect(analysis.edgeCount).toBe(golden.edgeCount);
        expect(analysis.hubFiles).toEqual(golden.hubFiles);
        expect(analysis.circularDeps).toEqual(golden.circularDeps);
        expect(analysis.layers).toEqual(golden.layers);
        expect(analysis.layerEdges).toEqual(golden.layerEdges);
        expect(analysis.instabilities).toEqual(golden.instabilities);
        expect(analysis.communityCount).toBe(golden.communityCount);
        expect(analysis.communityFiles).toEqual(golden.communityFiles);
        expect(analysis.deadFiles).toEqual(golden.deadFiles);
        expect(analysis.crossCuttingFiles).toEqual(golden.crossCuttingFiles);
        expect(analysis.layerConsistency).toEqual(golden.layerConsistency);
        expect(analysis.chokepoints).toEqual(golden.chokepoints);
        expect(analysis.tightCouplings).toEqual(golden.tightCouplings);
        expect(analysis.betweennessTopFiles).toEqual(golden.betweennessTopFiles);
        // approximateDiameter is sampled BFS, so allow ±1 tolerance
        expect(analysis.graphTopology.componentCount).toBe(golden.graphTopology.componentCount);
        expect(analysis.graphTopology.componentSizes).toEqual(golden.graphTopology.componentSizes);
        expect(analysis.graphTopology.approximateDiameter).toBeGreaterThanOrEqual(golden.graphTopology.approximateDiameter - 1);
        expect(analysis.graphTopology.approximateDiameter).toBeLessThanOrEqual(golden.graphTopology.approximateDiameter + 1);
        expect(analysis.graphTopology.reachability).toBe(golden.graphTopology.reachability);
        expect(analysis.graphTopology.isFragmented).toBe(golden.graphTopology.isFragmented);
      });
    });
  }
});
