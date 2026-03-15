/**
 * End-to-end pipeline benchmark: measures runAnalysis wall-clock time
 * under cold, warm (graph cache), and warm (both caches) scenarios.
 *
 * Uses the synthetic graph generator with the golden fixture as rootDir
 * for realistic I/O paths. Git analysis is mocked (no real git repo).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { bench, describe, vi, afterAll } from "vitest";
import { generateGraph } from "./graph-generator.js";
import { CLARTE_DIR } from "../../core/config/config.js";

// Mock git analysis (no real git repo in fixture)
vi.mock("../../core/git/analysis.js", () => ({
  analyzeGitActivity: vi.fn().mockResolvedValue({
    hotFiles: [
      { path: "src/components/File0.ts", commits: 15, lastChanged: "1d ago" },
      { path: "src/hooks/File1.ts", commits: 8, lastChanged: "3d ago" },
    ],
    changeCoupling: [
      { fileA: "src/components/File0.ts", fileB: "src/hooks/File1.ts", coChangeCount: 5, confidence: 0.6 },
    ],
    lagCouplings: [],
  }),
}));

// Mock git filter (needs fileExists which hits disk)
vi.mock("../../core/git/filter-alive.js", () => ({
  filterAliveGitActivity: vi.fn().mockResolvedValue(undefined),
}));

// Import after mocks
const { runAnalysis } = await import("../../core/run-analysis.js");

const FIXTURE_DIR = path.resolve(import.meta.dirname, "../golden/fixtures/ts-layered");
const CACHE_DIR = path.join(FIXTURE_DIR, CLARTE_DIR);

const graph = generateGraph(200, 3, 42);

const detected = {
  rootDir: FIXTURE_DIR,
  language: "typescript" as const,
  hasTypeScript: true,
  packageManager: "npm" as const,
  linter: "none" as const,
  frameworks: [],
  directories: ["controllers", "services", "types", "utils"],
  dependencies: [],
  isGitRepo: true,
  totalSourceBytes: 5000,
  sourceFileCount: 10,
  monorepo: null,
  testFramework: "vitest",
};

const noop = () => {};

// Cleanup caches between benchmark variants
async function clearCaches() {
  try {
    await fs.rm(CACHE_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

afterAll(async () => {
  await clearCaches();
});

describe("runAnalysis pipeline", () => {
  bench(
    "cold (no caches)",
    async () => {
      await clearCaches();
      await runAnalysis(FIXTURE_DIR, graph, detected, null, false, false, noop, noop);
    },
    { warmupIterations: 1, iterations: 5 },
  );

  bench(
    "warm (graph cache hit)",
    async () => {
      // First run populates graph cache, then subsequent runs hit it
      await runAnalysis(FIXTURE_DIR, graph, detected, null, false, false, noop, noop);
    },
    {
      warmupIterations: 1,
      iterations: 10,
      async setup() {
        // Ensure graph cache exists but project cache does not
        await clearCaches();
        await runAnalysis(FIXTURE_DIR, graph, detected, null, false, false, noop, noop);
        // Delete project cache only
        try {
          await fs.unlink(path.join(CACHE_DIR, "project-cache.json"));
        } catch {
          // ignore
        }
      },
    },
  );

  bench(
    "warm (both caches)",
    async () => {
      await runAnalysis(FIXTURE_DIR, graph, detected, null, false, false, noop, noop);
    },
    {
      warmupIterations: 1,
      iterations: 10,
      async setup() {
        // Ensure both caches are populated
        await clearCaches();
        await runAnalysis(FIXTURE_DIR, graph, detected, null, false, false, noop, noop);
      },
    },
  );
});
