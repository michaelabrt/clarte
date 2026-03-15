import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  computeProjectCacheKey,
  loadProjectCache,
  saveProjectCache,
  hydrateProjectCache,
  buildProjectCachePayload,
  PROJECT_CACHE_VERSION,
  type ProjectCacheData,
} from "../core/project-cache.js";
import { makeImportGraph, makeDetectedContext } from "./helpers/factories.js";
import type { MonorepoAnalysis, TestMapping } from "../core/types.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clarte-project-cache-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true });
});

// ── computeProjectCacheKey ────────────────────────────────────────────────

describe("computeProjectCacheKey", () => {
  it("is deterministic given the same inputs", async () => {
    const graph = makeImportGraph([], ["src/a.ts", "src/b.ts"]);
    const detected = makeDetectedContext();

    const key1 = await computeProjectCacheKey(tmpDir, graph, detected);
    const key2 = await computeProjectCacheKey(tmpDir, graph, detected);

    expect(key1).toBe(key2);
  });

  it("changes when a config file is added", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const detected = makeDetectedContext();

    const key1 = await computeProjectCacheKey(tmpDir, graph, detected);
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), '{"strict":true}');
    const key2 = await computeProjectCacheKey(tmpDir, graph, detected);

    expect(key1).not.toBe(key2);
  });

  it("changes when config file content changes", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const detected = makeDetectedContext();
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), '{"strict":true}');

    const key1 = await computeProjectCacheKey(tmpDir, graph, detected);
    await fs.writeFile(path.join(tmpDir, "tsconfig.json"), '{"strict":false}');
    const key2 = await computeProjectCacheKey(tmpDir, graph, detected);

    expect(key1).not.toBe(key2);
  });

  it("changes when the graph file list changes", async () => {
    const graph1 = makeImportGraph([], ["src/a.ts"]);
    const graph2 = makeImportGraph([], ["src/a.ts", "src/b.ts"]);
    const detected = makeDetectedContext();

    const key1 = await computeProjectCacheKey(tmpDir, graph1, detected);
    const key2 = await computeProjectCacheKey(tmpDir, graph2, detected);

    expect(key1).not.toBe(key2);
  });

  it("changes when detected language changes", async () => {
    const graph = makeImportGraph([], ["src/a.ts"]);
    const detected1 = makeDetectedContext({ language: "typescript" });
    const detected2 = makeDetectedContext({ language: "javascript" });

    const key1 = await computeProjectCacheKey(tmpDir, graph, detected1);
    const key2 = await computeProjectCacheKey(tmpDir, graph, detected2);

    expect(key1).not.toBe(key2);
  });

  it("changes when detected linter changes", async () => {
    const graph = makeImportGraph();
    const key1 = await computeProjectCacheKey(tmpDir, graph, makeDetectedContext({ linter: "eslint" }));
    const key2 = await computeProjectCacheKey(tmpDir, graph, makeDetectedContext({ linter: "biome" }));

    expect(key1).not.toBe(key2);
  });

  it("changes when detected testFramework changes", async () => {
    const graph = makeImportGraph();
    const key1 = await computeProjectCacheKey(tmpDir, graph, makeDetectedContext({ testFramework: "vitest" }));
    const key2 = await computeProjectCacheKey(tmpDir, graph, makeDetectedContext({ testFramework: "jest" }));

    expect(key1).not.toBe(key2);
  });

  it("changes when monorepo packages change", async () => {
    const graph = makeImportGraph();
    const detected1 = makeDetectedContext({
      monorepo: { type: "npm", packages: [{ name: "pkg-a", path: "packages/a" }] },
    });
    const detected2 = makeDetectedContext({
      monorepo: { type: "npm", packages: [{ name: "pkg-b", path: "packages/b" }] },
    });

    const key1 = await computeProjectCacheKey(tmpDir, graph, detected1);
    const key2 = await computeProjectCacheKey(tmpDir, graph, detected2);

    expect(key1).not.toBe(key2);
  });

  it("returns a 64-char hex string", async () => {
    const key = await computeProjectCacheKey(tmpDir, makeImportGraph(), makeDetectedContext());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ── loadProjectCache / saveProjectCache ──────────────────────────────────

describe("loadProjectCache", () => {
  it("returns null when no cache file exists", async () => {
    expect(await loadProjectCache(tmpDir)).toBeNull();
  });

  it("returns null when cache version does not match", async () => {
    const payload: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION + 1,
      cacheKey: "abc",
      configConstraints: undefined,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };
    const dir = path.join(tmpDir, ".clarte");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "project-cache.json"), JSON.stringify(payload));

    expect(await loadProjectCache(tmpDir)).toBeNull();
  });

  it("returns null when cache file is malformed JSON", async () => {
    const dir = path.join(tmpDir, ".clarte");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, "project-cache.json"), "not valid json{{{");

    expect(await loadProjectCache(tmpDir)).toBeNull();
  });
});

describe("saveProjectCache / loadProjectCache round-trip", () => {
  it("persists and reloads a minimal cache", async () => {
    const payload: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION,
      cacheKey: "test-key",
      configConstraints: undefined,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };

    await saveProjectCache(tmpDir, payload);
    const loaded = await loadProjectCache(tmpDir);

    expect(loaded).toEqual(payload);
  });

  it("creates .clarte directory if it does not exist", async () => {
    const payload: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION,
      cacheKey: "key",
      configConstraints: undefined,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };

    await saveProjectCache(tmpDir, payload);

    const stat = await fs.stat(path.join(tmpDir, ".clarte"));
    expect(stat.isDirectory()).toBe(true);
  });

  it("round-trips configConstraints", async () => {
    const payload = buildProjectCachePayload(
      "key",
      { typescript: { strict: true, target: "ES2022", pathAliases: {}, otherStrict: [] } },
      undefined,
      undefined,
      undefined,
    );

    await saveProjectCache(tmpDir, payload);
    const loaded = await loadProjectCache(tmpDir);

    expect(loaded?.configConstraints?.typescript?.strict).toBe(true);
    expect(loaded?.configConstraints?.typescript?.target).toBe("ES2022");
  });
});

// ── hydrateProjectCache ───────────────────────────────────────────────────

describe("hydrateProjectCache", () => {
  it("reconstructs TestMapping Maps from serialized arrays", () => {
    const payload = buildProjectCachePayload(
      "key",
      undefined,
      undefined,
      {
        sourceToTests: new Map([["src/a.ts", ["src/a.test.ts"]]]),
        untestedFiles: ["src/b.ts"],
        testTypes: new Map([["src/a.test.ts", "unit" as const]]),
      },
      undefined,
    );

    const { testMapping } = hydrateProjectCache(payload);

    expect(testMapping?.sourceToTests).toBeInstanceOf(Map);
    expect(testMapping?.sourceToTests.get("src/a.ts")).toEqual(["src/a.test.ts"]);
    expect(testMapping?.testTypes).toBeInstanceOf(Map);
    expect(testMapping?.testTypes?.get("src/a.test.ts")).toBe("unit");
  });

  it("reconstructs MonorepoAnalysis Map and Sets from serialized arrays", () => {
    const monorepo: MonorepoAnalysis = {
      crossPackageEdges: [],
      encapsulationViolations: [],
      packageDependencies: new Map([["pkg-a", new Set(["pkg-b", "pkg-c"])]]),
      packageHubFiles: new Map([["pkg-a", [{ path: "src/index.ts", authority: 0.9 }]]]),
    };

    const payload = buildProjectCachePayload("key", undefined, undefined, undefined, monorepo);
    const { monorepoAnalysis } = hydrateProjectCache(payload);

    expect(monorepoAnalysis?.packageDependencies).toBeInstanceOf(Map);
    const deps = monorepoAnalysis?.packageDependencies.get("pkg-a");
    expect(deps).toBeInstanceOf(Set);
    expect(deps?.has("pkg-b")).toBe(true);
    expect(deps?.has("pkg-c")).toBe(true);

    expect(monorepoAnalysis?.packageHubFiles).toBeInstanceOf(Map);
    expect(monorepoAnalysis?.packageHubFiles?.get("pkg-a")?.[0].path).toBe("src/index.ts");
  });

  it("returns undefined testMapping when cache has none", () => {
    const cache: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION,
      cacheKey: "key",
      configConstraints: undefined,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };

    const { testMapping } = hydrateProjectCache(cache);
    expect(testMapping).toBeUndefined();
  });

  it("returns undefined monorepoAnalysis when cache has none", () => {
    const cache: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION,
      cacheKey: "key",
      configConstraints: undefined,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };

    const { monorepoAnalysis } = hydrateProjectCache(cache);
    expect(monorepoAnalysis).toBeUndefined();
  });

  it("passes configConstraints through unchanged", () => {
    const constraints = { typescript: { strict: true, target: "ES2022", pathAliases: {}, otherStrict: [] } };
    const cache: ProjectCacheData = {
      version: PROJECT_CACHE_VERSION,
      cacheKey: "key",
      configConstraints: constraints,
      conventions: undefined,
      testMapping: undefined,
      monorepoAnalysis: undefined,
    };

    expect(hydrateProjectCache(cache).configConstraints).toBe(constraints);
  });

  it("preserves testTypes as undefined when not set", () => {
    const tm: TestMapping = {
      sourceToTests: new Map(),
      untestedFiles: [],
    };
    const payload = buildProjectCachePayload("key", undefined, undefined, tm, undefined);
    const { testMapping } = hydrateProjectCache(payload);

    expect(testMapping?.testTypes).toBeUndefined();
  });

  it("preserves packageHubFiles as undefined when not set", () => {
    const monorepo: MonorepoAnalysis = {
      crossPackageEdges: [],
      encapsulationViolations: [],
      packageDependencies: new Map(),
    };
    const payload = buildProjectCachePayload("key", undefined, undefined, undefined, monorepo);
    const { monorepoAnalysis } = hydrateProjectCache(payload);

    expect(monorepoAnalysis?.packageHubFiles).toBeUndefined();
  });
});

// ── buildProjectCachePayload ──────────────────────────────────────────────

describe("buildProjectCachePayload", () => {
  it("stamps the current cache version", () => {
    const payload = buildProjectCachePayload("k", undefined, undefined, undefined, undefined);
    expect(payload.version).toBe(PROJECT_CACHE_VERSION);
  });

  it("stores the provided cacheKey", () => {
    const payload = buildProjectCachePayload("my-key", undefined, undefined, undefined, undefined);
    expect(payload.cacheKey).toBe("my-key");
  });

  it("serializes TestMapping.sourceToTests Map to array-of-pairs", () => {
    const tm: TestMapping = {
      sourceToTests: new Map([["src/a.ts", ["src/a.test.ts"]]]),
      untestedFiles: [],
    };
    const payload = buildProjectCachePayload("k", undefined, undefined, tm, undefined);

    // Serialized form must be JSON-safe (no Map)
    expect(Array.isArray(payload.testMapping?.sourceToTests)).toBe(true);
    expect(payload.testMapping?.sourceToTests).toEqual([["src/a.ts", ["src/a.test.ts"]]]);
  });

  it("serializes MonorepoAnalysis.packageDependencies Map<string,Set<string>> to array-of-pairs with array values", () => {
    const monorepo: MonorepoAnalysis = {
      crossPackageEdges: [],
      encapsulationViolations: [],
      packageDependencies: new Map([["pkg-a", new Set(["pkg-b"])]]),
    };
    const payload = buildProjectCachePayload("k", undefined, undefined, undefined, monorepo);

    const deps = payload.monorepoAnalysis?.packageDependencies;
    expect(Array.isArray(deps)).toBe(true);
    const [key, vals] = (deps as [string, string[]][])[0];
    expect(key).toBe("pkg-a");
    expect(Array.isArray(vals)).toBe(true);
    expect(vals).toContain("pkg-b");
  });

  it("coerces null conventions to undefined", () => {
    const payload = buildProjectCachePayload("k", undefined, null, undefined, undefined);
    expect(payload.conventions).toBeUndefined();
  });

  it("coerces null testMapping to undefined", () => {
    const payload = buildProjectCachePayload("k", undefined, undefined, null, undefined);
    expect(payload.testMapping).toBeUndefined();
  });

  it("produces a payload that is JSON-serializable", () => {
    const tm: TestMapping = {
      sourceToTests: new Map([["src/x.ts", ["src/x.test.ts"]]]),
      untestedFiles: ["src/y.ts"],
    };
    const monorepo: MonorepoAnalysis = {
      crossPackageEdges: [],
      encapsulationViolations: [],
      packageDependencies: new Map([["a", new Set(["b"])]]),
    };
    const payload = buildProjectCachePayload("k", undefined, undefined, tm, monorepo);

    expect(() => JSON.stringify(payload)).not.toThrow();
  });

  it("omits testMapping when not provided", () => {
    const payload = buildProjectCachePayload("k", undefined, undefined, undefined, undefined);
    expect(payload.testMapping).toBeUndefined();
  });

  it("omits monorepoAnalysis when not provided", () => {
    const payload = buildProjectCachePayload("k", undefined, undefined, undefined, undefined);
    expect(payload.monorepoAnalysis).toBeUndefined();
  });
});

// ── Full round-trip through save/load/hydrate ────────────────────────────

describe("full round-trip (save -> load -> hydrate)", () => {
  it("reconstructs TestMapping Maps after disk persistence", async () => {
    const tm: TestMapping = {
      sourceToTests: new Map([
        ["src/a.ts", ["src/a.test.ts"]],
        ["src/b.ts", []],
      ]),
      untestedFiles: ["src/c.ts"],
      testTypes: new Map([["src/a.test.ts", "unit" as const]]),
      exemplarTestFile: "src/a.test.ts",
    };

    const payload = buildProjectCachePayload("round-trip-key", undefined, undefined, tm, undefined);
    await saveProjectCache(tmpDir, payload);
    const loaded = await loadProjectCache(tmpDir);
    if (!loaded) throw new Error("expected cache to load");
    const { testMapping } = hydrateProjectCache(loaded);

    expect(testMapping?.sourceToTests).toBeInstanceOf(Map);
    expect(testMapping?.sourceToTests.get("src/a.ts")).toEqual(["src/a.test.ts"]);
    expect(testMapping?.untestedFiles).toEqual(["src/c.ts"]);
    expect(testMapping?.testTypes?.get("src/a.test.ts")).toBe("unit");
    expect(testMapping?.exemplarTestFile).toBe("src/a.test.ts");
  });

  it("reconstructs MonorepoAnalysis Map and Sets after disk persistence", async () => {
    const monorepo: MonorepoAnalysis = {
      crossPackageEdges: [],
      encapsulationViolations: [],
      packageDependencies: new Map([["alpha", new Set(["beta", "gamma"])]]),
      packageHubFiles: new Map([["alpha", [{ path: "index.ts", authority: 1 }]]]),
    };

    const payload = buildProjectCachePayload("round-trip-key", undefined, undefined, undefined, monorepo);
    await saveProjectCache(tmpDir, payload);
    const loaded = await loadProjectCache(tmpDir);
    if (!loaded) throw new Error("expected cache to load");
    const { monorepoAnalysis } = hydrateProjectCache(loaded);

    expect(monorepoAnalysis?.packageDependencies).toBeInstanceOf(Map);
    expect(monorepoAnalysis?.packageDependencies.get("alpha")).toBeInstanceOf(Set);
    expect(monorepoAnalysis?.packageDependencies.get("alpha")?.has("beta")).toBe(true);
    expect(monorepoAnalysis?.packageDependencies.get("alpha")?.has("gamma")).toBe(true);
    expect(monorepoAnalysis?.packageHubFiles).toBeInstanceOf(Map);
    expect(monorepoAnalysis?.packageHubFiles?.get("alpha")?.[0].path).toBe("index.ts");
  });
});
