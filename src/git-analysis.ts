import { execSync } from "node:child_process";
import type { ChangeCoupling, GitAnalysis, ProgressCallback } from "./types.js";

/**
 * Analyze git activity in the repository to identify recently active files.
 * Returns null if not a git repo or git is unavailable.
 */
export function analyzeGitActivity(
  rootDir: string,
  onProgress?: ProgressCallback,
): GitAnalysis | null {
  try {
    onProgress?.("Analyzing git history (last 90 days)...");

    // Get file change counts for the last 90 days
    const logOutput = execSync(
      'git log --since="90 days ago" --name-only --pretty=format:""',
      { cwd: rootDir, encoding: "utf-8", timeout: 10000 },
    );

    const commitCounts = new Map<string, number>();
    for (const line of logOutput.split("\n")) {
      const file = line.trim();
      if (file && !file.startsWith("commit ")) {
        commitCounts.set(file, (commitCounts.get(file) ?? 0) + 1);
      }
    }

    if (commitCounts.size === 0) {
      return null;
    }

    onProgress?.(`Found activity in ${commitCounts.size} files`);

    // Get last changed date for top files
    const sorted = [...commitCounts.entries()].sort((a, b) => b[1] - a[1]);
    const hotFiles: GitAnalysis["hotFiles"] = [];

    for (const [filePath, commits] of sorted.slice(0, 15)) {
      let lastChanged = "";
      try {
        lastChanged = execSync(
          `git log -1 --format="%ar" -- "${filePath}"`,
          { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
        ).trim();
      } catch {
        // Skip if can't get date
      }
      hotFiles.push({ path: filePath, commits, lastChanged });
    }

    // Analyze change coupling
    onProgress?.("Analyzing change coupling...");
    const changeCoupling = analyzeChangeCoupling(rootDir);

    return { commitCounts, hotFiles, changeCoupling };
  } catch {
    // Not a git repo, git not available, or command failed
    return null;
  }
}

/**
 * Analyze change coupling: files that frequently change together in commits.
 * Uses co-occurrence analysis over the last 90 days of git history.
 */
export function analyzeChangeCoupling(rootDir: string): ChangeCoupling[] {
  try {
    // Get commit hashes from last 90 days
    const hashOutput = execSync(
      'git log --format="%H" --since="90 days ago"',
      { cwd: rootDir, encoding: "utf-8", timeout: 10000 },
    ).trim();

    if (!hashOutput) return [];

    const hashes = hashOutput.split("\n").filter(Boolean);
    if (hashes.length === 0) return [];

    // Get files per commit (batch for efficiency)
    const filesPerCommit: string[][] = [];
    const commitCountPerFile = new Map<string, number>();

    for (const hash of hashes) {
      try {
        const filesOutput = execSync(
          `git show --name-only --format="" ${hash}`,
          { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
        ).trim();

        const files = filesOutput
          .split("\n")
          .map((f) => f.trim())
          .filter(Boolean);

        if (files.length >= 2 && files.length <= 20) {
          // Skip huge commits (merges) and single-file commits
          filesPerCommit.push(files);
          for (const file of files) {
            commitCountPerFile.set(file, (commitCountPerFile.get(file) ?? 0) + 1);
          }
        }
      } catch {
        // Skip individual commit errors
      }
    }

    // Build co-occurrence matrix
    const coChanges = new Map<string, number>();
    for (const files of filesPerCommit) {
      for (let i = 0; i < files.length; i++) {
        for (let j = i + 1; j < files.length; j++) {
          const key = [files[i], files[j]].sort().join("||");
          coChanges.set(key, (coChanges.get(key) ?? 0) + 1);
        }
      }
    }

    // Compute coupling metrics
    const results: ChangeCoupling[] = [];
    const totalCommits = filesPerCommit.length;

    for (const [key, coChangeCount] of coChanges) {
      if (coChangeCount < 3) continue; // Minimum threshold

      const [fileA, fileB] = key.split("||");
      const commitsA = commitCountPerFile.get(fileA) ?? 0;
      const commitsB = commitCountPerFile.get(fileB) ?? 0;
      const confidence = coChangeCount / Math.max(commitsA, commitsB);
      const support = coChangeCount / totalCommits;

      if (confidence >= 0.5) {
        results.push({ fileA, fileB, coChangeCount, support, confidence });
      }
    }

    // Sort by confidence descending, return top 10
    results.sort((a, b) => b.confidence - a.confidence);
    return results.slice(0, 10);
  } catch {
    return [];
  }
}
