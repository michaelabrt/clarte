import { createHash } from "node:crypto";
import path from "node:path";
import fg from "fast-glob";
import type { Language, ProjectConfig, UserAnswers } from "./types.js";
import { readJsonFile, writeFileSafe } from "./utils.js";

const CONFIG_FILENAME = ".clarte.json";
const CONFIG_VERSION = 1;

interface ConfigFile extends ProjectConfig {
  /** Schema version for future migrations */
  _version: number;
}

/**
 * Load project config from .clarte.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadConfig(
  rootDir: string,
): Promise<ProjectConfig | null> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const raw = await readJsonFile(configPath);
  if (!raw) return null;

  const cfg = raw as Partial<ConfigFile>;

  // Validate required fields: support old `ide` (string) or new `ides` (array)
  const ides = cfg.ides ?? (cfg.ide ? [cfg.ide] : undefined);
  if (!ides || ides.length === 0 || !cfg.projectPurpose) return null;

  return {
    ides,
    ide: cfg.ide,
    projectPurpose: cfg.projectPurpose,
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
  };
}

/**
 * Compute a hash of all source files (path + mtime) to detect changes.
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

  const files = await fg(extMap[language] ?? extMap.other, {
    cwd: rootDir,
    ignore: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.next/**",
      "**/target/**",
      "**/vendor/**",
    ],
    stats: true,
    absolute: false,
  });

  // Sort by path for deterministic hashing
  const entries = files
    .map((f) => `${f.path}:${f.stats?.mtimeMs ?? 0}`)
    .sort();

  const hash = createHash("sha256")
    .update(entries.join("\n"))
    .digest("hex")
    .slice(0, 16);

  return hash;
}
