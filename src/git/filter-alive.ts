import path from "node:path";
import { fileExists } from "../utils.js";
import type { GitAnalysis } from "../types.js";

/**
 * Filter git activity entries to only files that still exist on disk.
 * Removes deleted files from hotFiles, changeCoupling and lagCouplings.
 *
 * Shared by watch mode and generate mode analysis pipelines.
 */
export async function filterAliveGitActivity(rootDir: string, gitActivity: GitAnalysis): Promise<void> {
  const filesToCheck = new Set<string>();
  for (const h of gitActivity.hotFiles) filesToCheck.add(h.path);
  for (const c of gitActivity.changeCoupling) {
    filesToCheck.add(c.fileA);
    filesToCheck.add(c.fileB);
  }
  if (gitActivity.lagCouplings) {
    for (const c of gitActivity.lagCouplings) {
      filesToCheck.add(c.fileA);
      filesToCheck.add(c.fileB);
    }
  }

  const checks = await Promise.all(
    [...filesToCheck].map(async (f) => [f, await fileExists(path.join(rootDir, f))] as const),
  );
  const alive = new Set(checks.filter(([, ok]) => ok).map(([f]) => f));

  gitActivity.hotFiles = gitActivity.hotFiles.filter((h) => alive.has(h.path));
  gitActivity.changeCoupling = gitActivity.changeCoupling.filter((c) => alive.has(c.fileA) && alive.has(c.fileB));
  if (gitActivity.lagCouplings) {
    gitActivity.lagCouplings = gitActivity.lagCouplings.filter((c) => alive.has(c.fileA) && alive.has(c.fileB));
  }
}
