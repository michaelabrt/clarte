import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  ConfigConstraints,
  DetectedContext,
  ImportGraph,
  InferredConventions,
  MonorepoAnalysis,
  PackageHubFile,
  TestMapping,
  TestType,
} from "./types.js";
import { CLARTE_DIR } from "./config/config.js";

const PROJECT_CACHE_FILE = "project-cache.json";

export const PROJECT_CACHE_VERSION = 1;

/**
 * Serializable project cache data.
 * Maps and Sets are stored as arrays for JSON compatibility.
 */
export interface ProjectCacheData {
  version: number;
  cacheKey: string;
  configConstraints: ConfigConstraints | undefined;
  conventions: InferredConventions | undefined;
  testMapping: SerializedTestMapping | undefined;
  monorepoAnalysis: SerializedMonorepoAnalysis | undefined;
}

/** TestMapping with Maps converted to arrays for JSON serialization */
interface SerializedTestMapping {
  sourceToTests: [string, string[]][];
  untestedFiles: string[];
  testPattern?: TestMapping["testPattern"];
  testTypes?: [string, TestType][];
  exemplarTestFile?: string;
}

/** MonorepoAnalysis with Maps/Sets converted for JSON serialization */
interface SerializedMonorepoAnalysis {
  crossPackageEdges: MonorepoAnalysis["crossPackageEdges"];
  encapsulationViolations: MonorepoAnalysis["encapsulationViolations"];
  packageDependencies: [string, string[]][];
  packageHubFiles?: [string, PackageHubFile[]][];
}

// ── Config files that affect project cache key ────────────────────────

const CONFIG_FILE_CANDIDATES = [
  "tsconfig.json",
  "biome.json",
  "biome.jsonc",
  ".eslintrc.json",
  ".eslintrc",
  ".prettierrc",
  ".prettierrc.json",
  "go.mod",
  "Cargo.toml",
  "pyproject.toml",
];

// ── Cache key computation ────────────────────────────────────────────

export async function computeProjectCacheKey(
  rootDir: string,
  graph: ImportGraph,
  detected: DetectedContext,
): Promise<string> {
  const hash = createHash("sha256");

  // 1. Config file hashes
  const configHashes = await Promise.all(
    CONFIG_FILE_CANDIDATES.map(async (file) => {
      try {
        const content = await fs.readFile(path.join(rootDir, file), "utf-8");
        return `${file}:${createHash("md5").update(content).digest("hex")}`;
      } catch {
        return null;
      }
    }),
  );
  for (const h of configHashes.sort()) {
    if (h) hash.update(h);
  }

  // 2. Top-50 source file paths by centrality (what inferConventions reads)
  const filesByCentrality = [...(graph.authority?.entries() ?? [])]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 50)
    .map(([f]) => f)
    .sort();
  hash.update(filesByCentrality.join("|"));

  // 3. All filenames in graph (affects test mapping, convention filename inference)
  const allFiles = [...graph.inDegree.keys()].sort();
  hash.update(allFiles.join("|"));

  // 4. Detection context fields that affect project analysis
  hash.update(detected.language);
  hash.update(detected.linter);
  hash.update(detected.testFramework ?? "");
  if (detected.monorepo) {
    hash.update(
      detected.monorepo.packages
        .map((p) => p.name)
        .sort()
        .join("|"),
    );
  }

  return hash.digest("hex");
}

// ── Serialization ────────────────────────────────────────────────────

function serializeTestMapping(tm: TestMapping): SerializedTestMapping {
  return {
    sourceToTests: [...tm.sourceToTests.entries()],
    untestedFiles: tm.untestedFiles,
    testPattern: tm.testPattern,
    testTypes: tm.testTypes ? [...tm.testTypes.entries()] : undefined,
    exemplarTestFile: tm.exemplarTestFile,
  };
}

function deserializeTestMapping(s: SerializedTestMapping): TestMapping {
  return {
    sourceToTests: new Map(s.sourceToTests),
    untestedFiles: s.untestedFiles,
    testPattern: s.testPattern,
    testTypes: s.testTypes ? new Map(s.testTypes) : undefined,
    exemplarTestFile: s.exemplarTestFile,
  };
}

function serializeMonorepoAnalysis(ma: MonorepoAnalysis): SerializedMonorepoAnalysis {
  return {
    crossPackageEdges: ma.crossPackageEdges,
    encapsulationViolations: ma.encapsulationViolations,
    packageDependencies: [...ma.packageDependencies.entries()].map(([k, v]) => [k, [...v]]),
    packageHubFiles: ma.packageHubFiles ? [...ma.packageHubFiles.entries()] : undefined,
  };
}

function deserializeMonorepoAnalysis(s: SerializedMonorepoAnalysis): MonorepoAnalysis {
  return {
    crossPackageEdges: s.crossPackageEdges,
    encapsulationViolations: s.encapsulationViolations,
    packageDependencies: new Map(s.packageDependencies.map(([k, v]) => [k, new Set(v)])),
    packageHubFiles: s.packageHubFiles ? new Map(s.packageHubFiles) : undefined,
  };
}

// ── Load / Save ──────────────────────────────────────────────────────

export async function loadProjectCache(rootDir: string): Promise<ProjectCacheData | null> {
  const cachePath = path.join(rootDir, CLARTE_DIR, PROJECT_CACHE_FILE);
  try {
    const raw = await fs.readFile(cachePath, "utf-8");
    const data = JSON.parse(raw) as ProjectCacheData;
    if (data.version !== PROJECT_CACHE_VERSION) return null;
    return data;
  } catch {
    return null;
  }
}

export async function saveProjectCache(rootDir: string, data: ProjectCacheData): Promise<void> {
  const dir = path.join(rootDir, CLARTE_DIR);
  await fs.mkdir(dir, { recursive: true });
  const cachePath = path.join(dir, PROJECT_CACHE_FILE);
  await fs.writeFile(cachePath, JSON.stringify(data), "utf-8");
}

/**
 * Hydrate cached project results into live objects (reconstruct Maps/Sets).
 */
export function hydrateProjectCache(cache: ProjectCacheData): {
  configConstraints: ConfigConstraints | undefined;
  conventions: InferredConventions | undefined;
  testMapping: TestMapping | undefined;
  monorepoAnalysis: MonorepoAnalysis | undefined;
} {
  return {
    configConstraints: cache.configConstraints,
    conventions: cache.conventions,
    testMapping: cache.testMapping ? deserializeTestMapping(cache.testMapping) : undefined,
    monorepoAnalysis: cache.monorepoAnalysis ? deserializeMonorepoAnalysis(cache.monorepoAnalysis) : undefined,
  };
}

/**
 * Build the serializable cache payload from live analysis results.
 */
export function buildProjectCachePayload(
  cacheKey: string,
  configConstraints: ConfigConstraints | undefined,
  conventions: InferredConventions | null | undefined,
  testMapping: TestMapping | null | undefined,
  monorepoAnalysis: MonorepoAnalysis | undefined,
): ProjectCacheData {
  return {
    version: PROJECT_CACHE_VERSION,
    cacheKey,
    configConstraints,
    conventions: conventions ?? undefined,
    testMapping: testMapping ? serializeTestMapping(testMapping) : undefined,
    monorepoAnalysis: monorepoAnalysis ? serializeMonorepoAnalysis(monorepoAnalysis) : undefined,
  };
}
