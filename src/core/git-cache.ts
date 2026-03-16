import { createHash } from "node:crypto";
import type { ChangeCoupling, GitAnalysis, LagCoupling } from "./types.js";
import { gitExecSafe } from "./git/git.js";
import type { GraphStore } from "../storage/graph-store.js";

const KV_KEY = "git_cache";

export const GIT_CACHE_VERSION = 1;

/**
 * Serializable git cache data.
 * Maps are stored as arrays for JSON compatibility.
 */
export interface GitCacheData {
  version: number;
  cacheKey: string;
  commitCounts: [string, number][];
  hotFiles: Array<{ path: string; commits: number; lastChanged: string }>;
  changeCoupling: ChangeCoupling[];
  lagCouplings?: LagCoupling[];
  fileChurn?: [string, { linesAdded: number; linesRemoved: number }][];
}

// ── Cache key computation ────────────────────────────────────────────

/**
 * Compute a cache key for git analysis based on HEAD, analysisDays and today's date.
 * Returns null if not in a git repo (no HEAD).
 */
export function computeGitCacheKey(rootDir: string, analysisDays: number): string | null {
  const head = gitExecSafe(["rev-parse", "HEAD"], { cwd: rootDir });
  if (!head) return null;

  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const hash = createHash("sha256");
  hash.update(head);
  hash.update(String(analysisDays));
  hash.update(today);
  return hash.digest("hex");
}

// ── Serialization ────────────────────────────────────────────────────

export function serializeGitAnalysis(ga: GitAnalysis): Omit<GitCacheData, "version" | "cacheKey"> {
  return {
    commitCounts: [...ga.commitCounts.entries()],
    hotFiles: ga.hotFiles,
    changeCoupling: ga.changeCoupling,
    lagCouplings: ga.lagCouplings,
    fileChurn: ga.fileChurn ? [...ga.fileChurn.entries()] : undefined,
  };
}

export function hydrateGitCache(cache: GitCacheData): GitAnalysis {
  return {
    commitCounts: new Map(cache.commitCounts),
    hotFiles: cache.hotFiles,
    changeCoupling: cache.changeCoupling,
    lagCouplings: cache.lagCouplings,
    fileChurn: cache.fileChurn ? new Map(cache.fileChurn) : undefined,
  };
}

// ── Load / Save ──────────────────────────────────────────────────────

export function loadGitCache(store: GraphStore): GitCacheData | null {
  try {
    const raw = store.getCache(KV_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as GitCacheData;
    if (data.version !== GIT_CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export function saveGitCache(store: GraphStore, data: GitCacheData): void {
  store.setCache(KV_KEY, JSON.stringify(data));
}

/**
 * Build the serializable cache payload from live git analysis results.
 */
export function buildGitCachePayload(cacheKey: string, gitAnalysis: GitAnalysis): GitCacheData {
  return {
    version: GIT_CACHE_VERSION,
    cacheKey,
    ...serializeGitAnalysis(gitAnalysis),
  };
}
