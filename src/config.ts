import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { glob } from "tinyglobby";
import type { Language, ProjectConfig, UserAnswers } from "./types.js";
import { readFileOr, readJsonFile, writeFileSafe } from "./utils.js";

const CONFIG_FILENAME = ".clarte.json";
const CONFIG_VERSION = 2;

interface ConfigFile extends ProjectConfig {
  /** Schema version for future migrations */
  _version: number;
}

/**
 * Validate layer entries: each must have a string `name` and a valid RegExp `pattern`.
 * Invalid entries are silently dropped with a warning to stderr.
 */
function validateLayers(
  layers: Array<{ name: string; pattern: string }> | undefined,
): Array<{ name: string; pattern: string }> | undefined {
  if (!layers || !Array.isArray(layers)) return undefined;

  const valid: Array<{ name: string; pattern: string }> = [];
  for (const layer of layers) {
    if (typeof layer.name !== "string" || !layer.name) {
      console.error(`[clarte] Ignoring layer with missing or invalid name.`);
      continue;
    }
    if (typeof layer.pattern !== "string" || !layer.pattern) {
      console.error(`[clarte] Ignoring layer "${layer.name}" with missing or invalid pattern.`);
      continue;
    }
    try {
      new RegExp(layer.pattern);
    } catch {
      console.error(`[clarte] Ignoring layer "${layer.name}": invalid RegExp pattern "${layer.pattern}".`);
      continue;
    }
    valid.push(layer);
  }

  return valid.length > 0 ? valid : undefined;
}

/**
 * Migrate a raw config object from one version to another.
 * Each step handles one version increment (e.g. 1->2).
 *
 * @param raw - the raw config JSON object
 * @param fromVersion - the version found in the config file (or 1 if missing)
 * @param toVersion - the target version to migrate to
 * @returns the migrated config object
 */
export function migrateConfig(
  raw: Record<string, unknown>,
  fromVersion: number,
  toVersion: number,
): Record<string, unknown> {
  const result = { ...raw };

  for (let v = fromVersion; v < toVersion; v++) {
    if (v === 1) {
      // v1 -> v2: Rename `ide` (string) to `ides` (array) if not already present
      if (!result.ides && result.ide) {
        result.ides = [result.ide];
      }
      // Add analysisDays default if not present
      if (result.analysisDays == null) {
        result.analysisDays = 90;
      }
    }
  }

  result._version = toVersion;
  return result;
}

/**
 * Load project config from .clarte.json.
 * Returns null if the file doesn't exist or is invalid.
 * Automatically runs migrations when the config version is behind.
 */
export async function loadConfig(
  rootDir: string,
): Promise<ProjectConfig | null> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const raw = await readJsonFile(configPath);
  if (!raw) return null;

  // Run migrations if the config version is behind the current version
  const fileVersion = typeof raw._version === "number" ? raw._version : 1;

  // Forward-compatibility guard: config from a newer version of clarte
  if (fileVersion > CONFIG_VERSION) {
    console.error(
      `[clarte] Config version ${fileVersion} is newer than supported version ${CONFIG_VERSION}. ` +
      `Ignoring config and using defaults. Consider upgrading clarte.`,
    );
    return null;
  }

  const migrated = fileVersion < CONFIG_VERSION
    ? migrateConfig(raw, fileVersion, CONFIG_VERSION)
    : raw;

  const cfg = migrated as Partial<ConfigFile>;

  // Validate required fields: support old `ide` (string) or new `ides` (array)
  const ides = cfg.ides ?? (cfg.ide ? [cfg.ide] : undefined);
  if (!ides || ides.length === 0) return null;

  return {
    ides,
    ide: cfg.ide,
    projectPurpose: cfg.projectPurpose ?? "",
    keyPatterns: cfg.keyPatterns ?? "",
    gotchas: cfg.gotchas ?? "",
    generateSnapshot: cfg.generateSnapshot ?? false,
    snapshotPaths: cfg.snapshotPaths ?? [],
    stackCorrections: cfg.stackCorrections ?? "",
    generatePerPackage: cfg.generatePerPackage ?? false,
    snapshotHash: cfg.snapshotHash,
    snapshotGeneratedAt: cfg.snapshotGeneratedAt,
    language: cfg.language,
    staleDays: cfg.staleDays,
    colorScheme: cfg.colorScheme === "dark" || cfg.colorScheme === "light"
      ? cfg.colorScheme
      : undefined,
    layers: validateLayers(cfg.layers),
    analysisDays: cfg.analysisDays,
    sectionOrder: Array.isArray(cfg.sectionOrder) ? cfg.sectionOrder : undefined,
  };
}

/**
 * Save project config to .clarte.json.
 * Optionally includes snapshot hash and timestamp.
 */
export async function saveConfig(
  rootDir: string,
  answers: UserAnswers,
  snapshotHash?: string,
  language?: Language,
): Promise<void> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  // Preserve user-editable fields from existing config
  const existing = await readJsonFile(configPath) as Partial<ConfigFile> | null;
  const cfg: ConfigFile = {
    _version: CONFIG_VERSION,
    ides: answers.ides,
    projectPurpose: answers.projectPurpose,
    keyPatterns: answers.keyPatterns,
    gotchas: answers.gotchas,
    generateSnapshot: answers.generateSnapshot,
    snapshotPaths: answers.snapshotPaths,
    stackCorrections: answers.stackCorrections,
    generatePerPackage: answers.generatePerPackage,
    ...(snapshotHash
      ? { snapshotHash, snapshotGeneratedAt: Date.now() }
      : {}),
    ...(language ? { language } : {}),
    ...(existing?.staleDays != null ? { staleDays: existing.staleDays } : {}),
    ...(existing?.colorScheme ? { colorScheme: existing.colorScheme } : {}),
    ...(answers.layers?.length ? { layers: answers.layers } : {}),
    ...(existing?.analysisDays != null ? { analysisDays: existing.analysisDays } : {}),
    ...(existing?.autoRefreshOnCommit != null ? { autoRefreshOnCommit: existing.autoRefreshOnCommit } : {}),
    ...(existing?.sectionOrder?.length ? { sectionOrder: existing.sectionOrder } : {}),
  };
  await writeFileSafe(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Convert a loaded ProjectConfig into UserAnswers (filling in defaults
 * for fields that only come from the interactive prompts).
 */
export function configToAnswers(config: ProjectConfig): UserAnswers {
  return {
    ides: config.ides,
    projectPurpose: config.projectPurpose,
    keyPatterns: config.keyPatterns,
    gotchas: config.gotchas,
    generateSnapshot: config.generateSnapshot,
    snapshotPaths: config.snapshotPaths,
    stackConfirmed: true,
    stackCorrections: config.stackCorrections,
    generatePerPackage: config.generatePerPackage,
    layers: config.layers,
    sectionOrder: config.sectionOrder,
  };
}


/** Map of language to the project manifest filename(s) to include in the hash */
const MANIFEST_FILES: Record<string, string[]> = {
  typescript: ["package.json"],
  javascript: ["package.json"],
  python: ["pyproject.toml", "setup.py", "requirements.txt"],
  go: ["go.mod"],
  rust: ["Cargo.toml"],
  java: ["pom.xml", "build.gradle"],
  other: ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"],
};

/**
 * Compute a hash of all source files (path + mtime) to detect changes.
 * Also includes the project manifest file (package.json, Cargo.toml, etc.)
 * so that dependency changes make the snapshot stale even if no source files changed.
 * Returns a 16-char hex string.
 */
export async function computeSnapshotHash(
  rootDir: string,
  language: Language,
): Promise<string> {
  const extMap: Record<string, string[]> = {
    typescript: ["**/*.{ts,tsx}"],
    javascript: ["**/*.{js,jsx,mjs}"],
    python: ["**/*.py"],
    go: ["**/*.go"],
    rust: ["**/*.rs"],
    java: ["**/*.java"],
    other: ["**/*.{ts,tsx,js,jsx,py,go,rs}"],
  };

  const files = await glob(extMap[language] ?? extMap.other, {
    cwd: rootDir,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/**",
      "**/vendor/**",
    ],
    absolute: false,
  });

  // Sort by path for deterministic hashing
  const entries = await Promise.all(
    files.map(async (f) => {
      const stat = await fs.stat(path.join(rootDir, f)).catch(() => null);
      return `${f}:${stat?.mtimeMs ?? 0}`;
    }),
  );
  entries.sort();

  // Include manifest file content so dependency changes invalidate the hash
  const manifestCandidates = MANIFEST_FILES[language] ?? MANIFEST_FILES.other;
  let manifestContent = "";
  for (const filename of manifestCandidates) {
    const content = await readFileOr(path.join(rootDir, filename));
    if (content) {
      manifestContent += `manifest:${filename}:${content}`;
      break; // use the first manifest found
    }
  }

  const hash = createHash("sha256")
    .update(entries.join("\n"))
    .update(manifestContent)
    .digest("hex")
    .slice(0, 16);

  return hash;
}
