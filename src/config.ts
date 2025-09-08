import path from "node:path";
import type { ProjectConfig, UserAnswers } from "./types.js";
import { readJsonFile, writeFileSafe } from "./utils.js";

const CONFIG_FILENAME = ".context-pilot.json";
const CONFIG_VERSION = 1;

interface ConfigFile extends ProjectConfig {
  /** Schema version for future migrations */
  _version: number;
}

/**
 * Load project config from .context-pilot.json.
 * Returns null if the file doesn't exist or is invalid.
 */
export async function loadConfig(
  rootDir: string,
): Promise<ProjectConfig | null> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const raw = await readJsonFile(configPath);
  if (!raw) return null;

  const cfg = raw as Partial<ConfigFile>;

  // Validate required fields
  if (!cfg.ide || !cfg.projectPurpose) return null;

  return {
    ide: cfg.ide,
    projectPurpose: cfg.projectPurpose,
    keyPatterns: cfg.keyPatterns ?? "",
    gotchas: cfg.gotchas ?? "",
    generateSnapshot: cfg.generateSnapshot ?? false,
    snapshotPaths: cfg.snapshotPaths ?? [],
    stackCorrections: cfg.stackCorrections ?? "",
    generatePerPackage: cfg.generatePerPackage ?? false,
  };
}

/**
 * Save project config to .context-pilot.json.
 */
export async function saveConfig(
  rootDir: string,
  answers: UserAnswers,
): Promise<void> {
  const configPath = path.join(rootDir, CONFIG_FILENAME);
  const cfg: ConfigFile = {
    _version: CONFIG_VERSION,
    ide: answers.ide,
    projectPurpose: answers.projectPurpose,
    keyPatterns: answers.keyPatterns,
    gotchas: answers.gotchas,
    generateSnapshot: answers.generateSnapshot,
    snapshotPaths: answers.snapshotPaths,
    stackCorrections: answers.stackCorrections,
    generatePerPackage: answers.generatePerPackage,
  };
  await writeFileSafe(configPath, JSON.stringify(cfg, null, 2) + "\n");
}

/**
 * Convert a loaded ProjectConfig into UserAnswers (filling in defaults
 * for fields that only come from the interactive prompts).
 */
export function configToAnswers(config: ProjectConfig): UserAnswers {
  return {
    ide: config.ide,
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
