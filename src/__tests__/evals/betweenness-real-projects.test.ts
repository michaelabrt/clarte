/**
 * Real-world project betweenness score analysis.
 *
 * Tests directed betweenness on cloned open-source projects to verify:
 * 1. Score distributions on real dependency graphs
 * 2. Whether flow bottleneck directives fire on larger codebases
 * 3. That pure sinks get zero betweenness (the core directed vs undirected difference)
 *
 * Skipped unless REAL_PROJECT_EVAL=1 is set (requires cloned repos in /tmp).
 *
 * Setup:
 *   git clone --depth=1 https://github.com/honojs/hono.git /tmp/clarte-test-hono
 *   git clone --depth=1 https://github.com/trpc/trpc.git /tmp/clarte-test-trpc
 *   git clone --depth=1 https://github.com/drizzle-team/drizzle-orm.git /tmp/clarte-test-drizzle
 *
 * Run:
 *   REAL_PROJECT_EVAL=1 npx vitest run src/__tests__/integration/betweenness-real-projects.test.ts
 */

import { describe, it, expect, beforeAll } from "vitest";
import { existsSync } from "node:fs";
import { buildImportGraph } from "../../graph/build.js";
import { findChokepoints } from "../../graph/chokepoints.js";
import { initTreeSitter } from "../../parsers/init.js";
import { buildDirectives, renderDirectivesSection } from "../../templates/directives.js";
import type { ImportGraph, ContextAnalysis, DetectedContext } from "../../types.js";

const SKIP = !process.env.REAL_PROJECT_EVAL;

interface ProjectResult {
  name: string;
  dir: string;
  fileCount: number;
  edgeCount: number;
  topScores: Array<{ file: string; score: number; isChokepoint: boolean }>;
  above05NotChokepoint: number;
  above03NotChokepoint: number;
  pureZeroSinks: string[];
  flowBottleneckDirectives: string[];
  renderedSection: string | null;
  medianBetweenness: number;
  maxBetweenness: number;
  countAbove03: number;
}

const PROJECTS = [
  { name: "hono", dir: "/tmp/clarte-test-hono" },
  { name: "trpc", dir: "/tmp/clarte-test-trpc" },
  { name: "drizzle", dir: "/tmp/clarte-test-drizzle" },
];

describe.skipIf(SKIP)("Real-project betweenness analysis", () => {
  beforeAll(async () => {
    await initTreeSitter();
  });

  for (const project of PROJECTS) {
    const available = existsSync(project.dir);

    describe.skipIf(!available)(`${project.name}`, () => {
      let graph: ImportGraph;
      let result: ProjectResult;

      beforeAll(async () => {
        graph = await buildImportGraph(project.dir, "typescript");
        if (!graph.betweennessScores) throw new Error("betweennessScores missing after buildImportGraph");
        const scores = graph.betweennessScores;
        const chokepoints = new Set(findChokepoints(graph).map((c) => c.file));

        const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);

        // Find files with zero outgoing edges (pure sinks)
        const outDegree = new Map<string, number>();
        for (const e of graph.edges) {
          if (!e.isExternal) {
            outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
          }
        }
        const pureZeroSinks = entries
          .filter(([f]) => !outDegree.has(f) || outDegree.get(f) === 0)
          .filter(([, s]) => s === 0)
          .map(([f]) => f)
          .slice(0, 10);

        // Build minimal context to test directive generation
        const chokepointList = findChokepoints(graph);
        const mockAnalysis = {
          chokepoints: chokepointList,
          hubFiles: [],
        } as unknown as ContextAnalysis;
        const mockCtx = {
          rootDir: project.dir,
        } as DetectedContext;
        const directives = buildDirectives(mockAnalysis, mockCtx, undefined, graph);
        const flowBottleneckDirectives = directives.filter((d) => d.includes("flow bottleneck"));

        // Render full pipeline output (Gap 1)
        const renderedSection = await renderDirectivesSection(mockAnalysis, mockCtx, graph);

        // Summary statistics
        const allScores = entries.map(([, s]) => s);
        const sorted = [...allScores].sort((a, b) => a - b);
        const medianBetweenness = sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0;
        const maxBetweenness = sorted.length > 0 ? sorted[sorted.length - 1] : 0;
        const countAbove03 = allScores.filter((s) => s > 0.3).length;

        result = {
          name: project.name,
          dir: project.dir,
          fileCount: entries.length,
          edgeCount: graph.edges.filter((e) => !e.isExternal).length,
          topScores: entries.slice(0, 15).map(([file, score]) => ({
            file,
            score,
            isChokepoint: chokepoints.has(file),
          })),
          above05NotChokepoint: entries.filter(([f, s]) => s > 0.5 && !chokepoints.has(f)).length,
          above03NotChokepoint: entries.filter(([f, s]) => s > 0.3 && !chokepoints.has(f)).length,
          pureZeroSinks,
          flowBottleneckDirectives,
          renderedSection,
          medianBetweenness,
          maxBetweenness,
          countAbove03,
        };

        // Print report
        console.log(`\n${"=".repeat(60)}`);
        console.log(`  ${project.name} (${result.fileCount} files, ${result.edgeCount} edges)`);
        console.log(`${"=".repeat(60)}`);
        console.log(`\n  Top 15 betweenness scores:`);
        for (const { file, score, isChokepoint } of result.topScores) {
          const cp = isChokepoint ? " [chokepoint]" : "";
          console.log(`    ${score.toFixed(4)}  ${file}${cp}`);
        }
        console.log(`\n  Above 0.5 (not chokepoints): ${result.above05NotChokepoint}`);
        console.log(`  Above 0.3 (not chokepoints): ${result.above03NotChokepoint}`);
        console.log(`  Pure sinks with zero betweenness: ${result.pureZeroSinks.length}`);
        if (result.pureZeroSinks.length > 0) {
          for (const f of result.pureZeroSinks.slice(0, 5)) {
            console.log(`    ${f}`);
          }
        }
        console.log(
          `\n  Summary: median=${result.medianBetweenness.toFixed(4)}, max=${result.maxBetweenness.toFixed(4)}, count>0.3=${result.countAbove03}`,
        );
        console.log(`  Flow bottleneck directives: ${result.flowBottleneckDirectives.length}`);
        for (const d of result.flowBottleneckDirectives) {
          console.log(`    ${d}`);
        }
        console.log("");
      }, 120_000);

      it("should compute betweenness scores for all files", () => {
        if (!graph.betweennessScores) throw new Error("expected betweennessScores");
        expect(graph.betweennessScores.size).toBeGreaterThan(0);
      });

      it("betweennessScores has non-zero entries (graph has structure)", () => {
        const nonZero = [...(graph.betweennessScores?.values() ?? [])].filter((s) => s > 0);
        expect(nonZero.length).toBeGreaterThan(0);
      });

      it("all scores should be in [0, 1]", () => {
        if (!graph.betweennessScores) throw new Error("betweennessScores missing");
        for (const [file, score] of graph.betweennessScores) {
          expect(score, `${file} score out of range`).toBeGreaterThanOrEqual(0);
          expect(score, `${file} score out of range`).toBeLessThanOrEqual(1);
        }
      });

      it("pure sinks (no outgoing edges) should have zero betweenness", () => {
        // Core semantic guarantee of directed betweenness
        expect(result.pureZeroSinks.length).toBeGreaterThan(0);
      });
    });
  }

  // ── Project-specific assertions (Gap 4) ────────────────────────────

  describe.skipIf(!existsSync("/tmp/clarte-test-drizzle"))("drizzle: flow bottleneck directives fire", () => {
    let drizzleResult: ProjectResult;

    beforeAll(async () => {
      const graph = await buildImportGraph("/tmp/clarte-test-drizzle", "typescript");
      if (!graph.betweennessScores) throw new Error("betweennessScores missing after buildImportGraph");
      const scores = graph.betweennessScores;
      const chokepointList = findChokepoints(graph);
      const chokepoints = new Set(chokepointList.map((c) => c.file));

      const entries = [...scores.entries()].sort((a, b) => b[1] - a[1]);

      const outDegree = new Map<string, number>();
      for (const e of graph.edges) {
        if (!e.isExternal) {
          outDegree.set(e.from, (outDegree.get(e.from) ?? 0) + 1);
        }
      }
      const pureZeroSinks = entries
        .filter(([f]) => !outDegree.has(f) || outDegree.get(f) === 0)
        .filter(([, s]) => s === 0)
        .map(([f]) => f)
        .slice(0, 10);

      const mockAnalysis = {
        chokepoints: chokepointList,
        hubFiles: [],
      } as unknown as ContextAnalysis;
      const mockCtx = {
        rootDir: "/tmp/clarte-test-drizzle",
      } as DetectedContext;
      const directives = buildDirectives(mockAnalysis, mockCtx, undefined, graph);
      const flowBottleneckDirectives = directives.filter((d) => d.includes("flow bottleneck"));

      const renderedSection = await renderDirectivesSection(mockAnalysis, mockCtx, graph);

      const allScores = entries.map(([, s]) => s);
      const sorted = [...allScores].sort((a, b) => a - b);

      drizzleResult = {
        name: "drizzle",
        dir: "/tmp/clarte-test-drizzle",
        fileCount: entries.length,
        edgeCount: graph.edges.filter((e) => !e.isExternal).length,
        topScores: entries.slice(0, 15).map(([file, score]) => ({
          file,
          score,
          isChokepoint: chokepoints.has(file),
        })),
        above05NotChokepoint: entries.filter(([f, s]) => s > 0.5 && !chokepoints.has(f)).length,
        above03NotChokepoint: entries.filter(([f, s]) => s > 0.3 && !chokepoints.has(f)).length,
        pureZeroSinks,
        flowBottleneckDirectives,
        renderedSection,
        medianBetweenness: sorted.length > 0 ? sorted[Math.floor(sorted.length / 2)] : 0,
        maxBetweenness: sorted.length > 0 ? sorted[sorted.length - 1] : 0,
        countAbove03: allScores.filter((s) => s > 0.3).length,
      };
    }, 120_000);

    it("flow bottleneck directives fire (>= 1)", () => {
      expect(drizzleResult.flowBottleneckDirectives.length).toBeGreaterThanOrEqual(1);
    });

    it("rendered section contains 'flow bottleneck'", () => {
      expect(drizzleResult.renderedSection).toBeDefined();
      expect(drizzleResult.renderedSection).toContain("flow bottleneck");
    });

    it("rendered section starts with '## Working Guidelines'", () => {
      if (!drizzleResult.renderedSection) throw new Error("expected renderedSection");
      expect(drizzleResult.renderedSection.startsWith("## Working Guidelines")).toBe(true);
    });

    it("no chokepoint file appears in a flow bottleneck directive", () => {
      const chokepointFiles = drizzleResult.topScores.filter((t) => t.isChokepoint).map((t) => t.file);
      for (const d of drizzleResult.flowBottleneckDirectives) {
        for (const cp of chokepointFiles) {
          expect(d, `chokepoint ${cp} should not appear in flow bottleneck directive`).not.toContain(cp);
        }
      }
    });
  });

  describe.skipIf(!existsSync("/tmp/clarte-test-hono"))("hono: no flow bottleneck directives", () => {
    let honoDirectives: string[];

    beforeAll(async () => {
      const graph = await buildImportGraph("/tmp/clarte-test-hono", "typescript");
      const chokepointList = findChokepoints(graph);
      const mockAnalysis = {
        chokepoints: chokepointList,
        hubFiles: [],
      } as unknown as ContextAnalysis;
      const mockCtx = { rootDir: "/tmp/clarte-test-hono" } as DetectedContext;
      const directives = buildDirectives(mockAnalysis, mockCtx, undefined, graph);
      honoDirectives = directives.filter((d) => d.includes("flow bottleneck"));
    }, 120_000);

    it("all high-betweenness files are already chokepoints (0 flow bottleneck directives)", () => {
      expect(honoDirectives.length).toBe(0);
    });
  });

  describe.skipIf(!existsSync("/tmp/clarte-test-trpc"))("trpc: no flow bottleneck directives", () => {
    let trpcDirectives: string[];

    beforeAll(async () => {
      const graph = await buildImportGraph("/tmp/clarte-test-trpc", "typescript");
      const chokepointList = findChokepoints(graph);
      const mockAnalysis = {
        chokepoints: chokepointList,
        hubFiles: [],
      } as unknown as ContextAnalysis;
      const mockCtx = { rootDir: "/tmp/clarte-test-trpc" } as DetectedContext;
      const directives = buildDirectives(mockAnalysis, mockCtx, undefined, graph);
      trpcDirectives = directives.filter((d) => d.includes("flow bottleneck"));
    }, 120_000);

    it("all high-betweenness files are already chokepoints (0 flow bottleneck directives)", () => {
      expect(trpcDirectives.length).toBe(0);
    });
  });
});
