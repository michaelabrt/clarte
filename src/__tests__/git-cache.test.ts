import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  computeGitCacheKey,
  loadGitCache,
  saveGitCache,
  hydrateGitCache,
  buildGitCachePayload,
  GIT_CACHE_VERSION,
  type GitCacheData,
} from "../core/git-cache";
import type { GitAnalysis, LagCoupling } from "../core/types";
import { createDatabase } from "../storage/db-adapter";
import { initSchema } from "../storage/schema";
import { GraphStore } from "../storage/graph-store";

// ── Mock git/git.js ───────────────────────────────────────────────────────

const mockGitExecSafe = vi.fn<(args: string[], opts: { cwd: string }) => string | null>();

vi.mock("../core/git/git.js", () => ({
  gitExecSafe: (...args: unknown[]) => mockGitExecSafe(...(args as [string[], { cwd: string }])),
}));

// ── Fixtures ─────────────────────────────────────────────────────────────

const FAKE_HEAD = "abc123def456abc123def456abc123def456abc123def456abc123def456abc1";

function makeGitAnalysis(overrides: Partial<GitAnalysis> = {}): GitAnalysis {
  return {
    commitCounts: new Map([
      ["src/index.ts", 10],
      ["src/utils.ts", 5],
    ]),
    hotFiles: [
      { path: "src/index.ts", commits: 10, lastChanged: "1d ago" },
      { path: "src/utils.ts", commits: 5, lastChanged: "3d ago" },
    ],
    changeCoupling: [
      {
        fileA: "src/a.ts",
        fileB: "src/b.ts",
        coChangeCount: 3,
        support: 0.3,
        confidence: 0.6,
      },
    ],
    lagCouplings: [
      {
        fileA: "src/a.ts",
        fileB: "src/c.ts",
        sameCommitCount: 2,
        lagScore: 1.5,
      },
    ],
    ...overrides,
  };
}

function makeMinimalCacheData(): GitCacheData {
  return {
    version: GIT_CACHE_VERSION,
    cacheKey: "test-key",
    commitCounts: [["src/index.ts", 7]],
    hotFiles: [{ path: "src/index.ts", commits: 7, lastChanged: "2d ago" }],
    changeCoupling: [],
  };
}

// ── Store lifecycle ──────────────────────────────────────────────────────

let store: GraphStore;

beforeEach(async () => {
  const db = await createDatabase(":memory:");
  initSchema(db);
  store = new GraphStore(db);
  mockGitExecSafe.mockReturnValue(FAKE_HEAD);
});

afterEach(() => {
  store.close();
  vi.clearAllMocks();
});

// ── computeGitCacheKey ────────────────────────────────────────────────────

describe("computeGitCacheKey", () => {
  it("is deterministic given the same inputs", () => {
    const key1 = computeGitCacheKey("/tmp/test", 90);
    const key2 = computeGitCacheKey("/tmp/test", 90);
    expect(key1).toBe(key2);
  });

  it("changes when analysisDays changes", () => {
    const key1 = computeGitCacheKey("/tmp/test", 90);
    const key2 = computeGitCacheKey("/tmp/test", 30);
    expect(key1).not.toBe(key2);
  });

  it("changes when HEAD changes", () => {
    const key1 = computeGitCacheKey("/tmp/test", 90);
    mockGitExecSafe.mockReturnValue("different-sha");
    const key2 = computeGitCacheKey("/tmp/test", 90);
    expect(key1).not.toBe(key2);
  });

  it("returns null when gitExecSafe returns null (not a git repo)", () => {
    mockGitExecSafe.mockReturnValue(null);
    expect(computeGitCacheKey("/tmp/test", 90)).toBeNull();
  });

  it("returns a 64-char hex string", () => {
    const key = computeGitCacheKey("/tmp/test", 90);
    expect(key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("passes rootDir as cwd to gitExecSafe", () => {
    computeGitCacheKey("/some/dir", 90);
    expect(mockGitExecSafe).toHaveBeenCalledWith(["rev-parse", "HEAD"], { cwd: "/some/dir" });
  });
});

// ── loadGitCache ──────────────────────────────────────────────────────────

describe("loadGitCache", () => {
  it("returns null when no cache exists", () => {
    expect(loadGitCache(store)).toBeNull();
  });

  it("returns null when cache version does not match", () => {
    const payload: GitCacheData = {
      version: GIT_CACHE_VERSION + 1,
      cacheKey: "abc",
      commitCounts: [],
      hotFiles: [],
      changeCoupling: [],
    };
    store.setCache("git_cache", JSON.stringify(payload));

    expect(loadGitCache(store)).toBeNull();
  });

  it("returns null when cache value is malformed JSON", () => {
    store.setCache("git_cache", "not valid json{{{");

    expect(loadGitCache(store)).toBeNull();
  });
});

// ── saveGitCache / loadGitCache round-trip ────────────────────────────────

describe("saveGitCache / loadGitCache round-trip", () => {
  it("persists and reloads a minimal cache", () => {
    const payload = makeMinimalCacheData();
    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    expect(loaded).toEqual(payload);
  });

  it("round-trips a full cache with optional fields", () => {
    const payload: GitCacheData = {
      version: GIT_CACHE_VERSION,
      cacheKey: "full-key",
      commitCounts: [
        ["src/a.ts", 3],
        ["src/b.ts", 1],
      ],
      hotFiles: [{ path: "src/a.ts", commits: 3, lastChanged: "1d ago" }],
      changeCoupling: [
        {
          fileA: "src/a.ts",
          fileB: "src/b.ts",
          coChangeCount: 2,
          support: 0.4,
          confidence: 0.8,
          confidenceAB: 0.9,
          confidenceBA: 0.7,
        },
      ],
      lagCouplings: [{ fileA: "src/a.ts", fileB: "src/c.ts", sameCommitCount: 1, lagScore: 1.0 }],
      fileChurn: [["src/a.ts", { linesAdded: 100, linesRemoved: 20 }]],
    };

    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    expect(loaded).toEqual(payload);
  });
});

// ── hydrateGitCache ───────────────────────────────────────────────────────

describe("hydrateGitCache", () => {
  it("reconstructs commitCounts as a Map", () => {
    const cache = makeMinimalCacheData();
    cache.commitCounts = [
      ["src/a.ts", 5],
      ["src/b.ts", 2],
    ];
    const { commitCounts } = hydrateGitCache(cache);
    expect(commitCounts).toBeInstanceOf(Map);
    expect(commitCounts.get("src/a.ts")).toBe(5);
    expect(commitCounts.get("src/b.ts")).toBe(2);
  });

  it("reconstructs fileChurn as a Map when present", () => {
    const cache = makeMinimalCacheData();
    cache.fileChurn = [["src/hot.ts", { linesAdded: 80, linesRemoved: 10 }]];
    const { fileChurn } = hydrateGitCache(cache);
    expect(fileChurn).toBeInstanceOf(Map);
    expect(fileChurn?.get("src/hot.ts")).toEqual({ linesAdded: 80, linesRemoved: 10 });
  });

  it("leaves fileChurn as undefined when not present", () => {
    const cache = makeMinimalCacheData();
    const { fileChurn } = hydrateGitCache(cache);
    expect(fileChurn).toBeUndefined();
  });

  it("passes hotFiles through unchanged", () => {
    const cache = makeMinimalCacheData();
    const { hotFiles } = hydrateGitCache(cache);
    expect(hotFiles).toBe(cache.hotFiles);
  });

  it("passes changeCoupling through unchanged", () => {
    const cache = makeMinimalCacheData();
    const { changeCoupling } = hydrateGitCache(cache);
    expect(changeCoupling).toBe(cache.changeCoupling);
  });

  it("passes lagCouplings through unchanged when present", () => {
    const lags: LagCoupling[] = [{ fileA: "src/a.ts", fileB: "src/b.ts", sameCommitCount: 1, lagScore: 1.0 }];
    const cache: GitCacheData = { ...makeMinimalCacheData(), lagCouplings: lags };
    const { lagCouplings } = hydrateGitCache(cache);
    expect(lagCouplings).toBe(lags);
  });

  it("leaves lagCouplings as undefined when not present", () => {
    const cache = makeMinimalCacheData();
    const { lagCouplings } = hydrateGitCache(cache);
    expect(lagCouplings).toBeUndefined();
  });
});

// ── buildGitCachePayload ──────────────────────────────────────────────────

describe("buildGitCachePayload", () => {
  it("stamps the current cache version", () => {
    const payload = buildGitCachePayload("key", makeGitAnalysis());
    expect(payload.version).toBe(GIT_CACHE_VERSION);
  });

  it("stores the provided cacheKey", () => {
    const payload = buildGitCachePayload("my-key", makeGitAnalysis());
    expect(payload.cacheKey).toBe("my-key");
  });

  it("serializes commitCounts Map to array-of-pairs", () => {
    const ga = makeGitAnalysis({ commitCounts: new Map([["src/x.ts", 7]]) });
    const payload = buildGitCachePayload("k", ga);
    expect(Array.isArray(payload.commitCounts)).toBe(true);
    expect(payload.commitCounts).toContainEqual(["src/x.ts", 7]);
  });

  it("serializes fileChurn Map to array-of-pairs when present", () => {
    const ga = makeGitAnalysis({
      fileChurn: new Map([["src/x.ts", { linesAdded: 50, linesRemoved: 5 }]]),
    });
    const payload = buildGitCachePayload("k", ga);
    expect(Array.isArray(payload.fileChurn)).toBe(true);
    expect(payload.fileChurn).toContainEqual(["src/x.ts", { linesAdded: 50, linesRemoved: 5 }]);
  });

  it("omits fileChurn when undefined on GitAnalysis", () => {
    const ga = makeGitAnalysis({ fileChurn: undefined });
    const payload = buildGitCachePayload("k", ga);
    expect(payload.fileChurn).toBeUndefined();
  });

  it("passes hotFiles through unchanged", () => {
    const ga = makeGitAnalysis();
    const payload = buildGitCachePayload("k", ga);
    expect(payload.hotFiles).toBe(ga.hotFiles);
  });

  it("passes changeCoupling through unchanged", () => {
    const ga = makeGitAnalysis();
    const payload = buildGitCachePayload("k", ga);
    expect(payload.changeCoupling).toBe(ga.changeCoupling);
  });

  it("produces a JSON-serializable payload", () => {
    const ga = makeGitAnalysis({
      fileChurn: new Map([["src/y.ts", { linesAdded: 10, linesRemoved: 2 }]]),
    });
    const payload = buildGitCachePayload("k", ga);
    expect(() => JSON.stringify(payload)).not.toThrow();
  });
});

// ── Full round-trip (save -> load -> hydrate) ─────────────────────────────

describe("full round-trip (save -> load -> hydrate)", () => {
  it("reconstructs commitCounts Map after persistence", () => {
    const ga = makeGitAnalysis();
    const payload = buildGitCachePayload("rt-key", ga);
    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    if (!loaded) throw new Error("expected cache to load");
    const hydrated = hydrateGitCache(loaded);

    expect(hydrated.commitCounts).toBeInstanceOf(Map);
    expect(hydrated.commitCounts.get("src/index.ts")).toBe(10);
    expect(hydrated.commitCounts.get("src/utils.ts")).toBe(5);
  });

  it("reconstructs fileChurn Map after persistence", () => {
    const ga = makeGitAnalysis({
      fileChurn: new Map([
        ["src/a.ts", { linesAdded: 200, linesRemoved: 50 }],
        ["src/b.ts", { linesAdded: 10, linesRemoved: 0 }],
      ]),
    });
    const payload = buildGitCachePayload("rt-key", ga);
    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    if (!loaded) throw new Error("expected cache to load");
    const hydrated = hydrateGitCache(loaded);

    expect(hydrated.fileChurn).toBeInstanceOf(Map);
    expect(hydrated.fileChurn?.get("src/a.ts")).toEqual({ linesAdded: 200, linesRemoved: 50 });
    expect(hydrated.fileChurn?.get("src/b.ts")).toEqual({ linesAdded: 10, linesRemoved: 0 });
  });

  it("preserves hotFiles, changeCoupling and lagCouplings after persistence", () => {
    const ga = makeGitAnalysis();
    const payload = buildGitCachePayload("rt-key", ga);
    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    if (!loaded) throw new Error("expected cache to load");
    const hydrated = hydrateGitCache(loaded);

    expect(hydrated.hotFiles).toEqual(ga.hotFiles);
    expect(hydrated.changeCoupling[0].fileA).toBe("src/a.ts");
    expect(hydrated.lagCouplings?.[0].fileA).toBe("src/a.ts");
  });

  it("handles absent optional fields after persistence", () => {
    const ga: GitAnalysis = {
      commitCounts: new Map([["src/z.ts", 1]]),
      hotFiles: [{ path: "src/z.ts", commits: 1, lastChanged: "5d ago" }],
      changeCoupling: [],
    };
    const payload = buildGitCachePayload("minimal-key", ga);
    saveGitCache(store, payload);
    const loaded = loadGitCache(store);
    if (!loaded) throw new Error("expected cache to load");
    const hydrated = hydrateGitCache(loaded);

    expect(hydrated.lagCouplings).toBeUndefined();
    expect(hydrated.fileChurn).toBeUndefined();
  });
});
