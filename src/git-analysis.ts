import { execSync } from "node:child_process";
import type { ChangeCoupling, GitAnalysis, ProgressCallback } from "./types.js";

/**
 * Structured representation of a single commit from git log.
 * Used internally for both commit counting and coupling analysis.
 */
export interface ParsedCommit {
  hash: string;
  date: string;
  relativeDate: string;
  message: string;
  files: string[];
}

/**
 * Parse the output of a single git log call into structured commits.
 * Uses a custom separator to split commits efficiently.
 */
function parseGitLog(rootDir: string): ParsedCommit[] {
  const SEP = "---CLARTE_COMMIT_SEP---";

  // Single git log call with all data:
  // - --no-merges: exclude merge commits (inflates counts and creates spurious coupling)
  // - --diff-filter=ACDMRT: only Added/Copied/Deleted/Modified/Renamed/Type-changed (skip old paths from renames)
  // - --name-only: list changed files
  // - format: hash, ISO date, relative date, subject line
  const output = execSync(
    `git log --no-merges --since="90 days ago" --diff-filter=ACDMRT --name-only --format="${SEP}%H|%aI|%ar|%s"`,
    { cwd: rootDir, encoding: "utf-8", timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
  ).trim();

  if (!output) return [];

  const commits: ParsedCommit[] = [];
  const chunks = output.split(SEP).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    // First line: hash|isoDate|relDate|subject
    const headerLine = lines[0];
    const pipeIdx1 = headerLine.indexOf("|");
    const pipeIdx2 = headerLine.indexOf("|", pipeIdx1 + 1);
    const pipeIdx3 = headerLine.indexOf("|", pipeIdx2 + 1);

    if (pipeIdx1 < 0 || pipeIdx2 < 0 || pipeIdx3 < 0) continue;

    const hash = headerLine.slice(0, pipeIdx1);
    const date = headerLine.slice(pipeIdx1 + 1, pipeIdx2);
    const relativeDate = headerLine.slice(pipeIdx2 + 1, pipeIdx3);
    const message = headerLine.slice(pipeIdx3 + 1);

    // Remaining lines are file paths
    const files = lines.slice(1).map((f) => f.trim()).filter(Boolean);

    if (files.length > 0) {
      commits.push({ hash, date, relativeDate, message, files });
    }
  }

  return commits;
}

/**
 * Analyze git activity in the repository to identify recently active files.
 * Returns null if not a git repo or git is unavailable.
 *
 * Uses a single git log call for both commit counting and coupling analysis.
 */
export function analyzeGitActivity(
  rootDir: string,
  onProgress?: ProgressCallback,
): GitAnalysis | null {
  try {
    onProgress?.("Analyzing git history (last 90 days)...");

    const commits = parseGitLog(rootDir);
    if (commits.length === 0) return null;

    onProgress?.(`Parsed ${commits.length} commits`);

    // Build commit counts and last-changed dates from the single parse
    const commitCounts = new Map<string, number>();
    const lastChanged = new Map<string, string>();

    for (const commit of commits) {
      for (const file of commit.files) {
        commitCounts.set(file, (commitCounts.get(file) ?? 0) + 1);
        // First seen commit is the most recent (git log outputs newest first)
        if (!lastChanged.has(file)) {
          lastChanged.set(file, commit.relativeDate);
        }
      }
    }

    if (commitCounts.size === 0) return null;

    onProgress?.(`Found activity in ${commitCounts.size} files`);

    // Build hot files list (top 15 by commit count)
    const sorted = [...commitCounts.entries()].sort((a, b) => b[1] - a[1]);
    const hotFiles: GitAnalysis["hotFiles"] = sorted
      .slice(0, 15)
      .map(([filePath, commitCount]) => ({
        path: filePath,
        commits: commitCount,
        lastChanged: lastChanged.get(filePath) ?? "",
      }));

    for (const [filePath, commits] of sorted.slice(0, 15)) {
      let lastChanged = "";
      try {
        lastChanged = execSync(
          `git log -1 --format="%ar" -- "${filePath}"`,
          { cwd: rootDir, encoding: "utf-8", timeout: 5000 },
        ).trim();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        onProgress?.(`Warning: could not get last change date for ${filePath}: ${msg}`);
      }
      hotFiles.push({ path: filePath, commits, lastChanged });
    }

    // Analyze change coupling
    onProgress?.("Analyzing change coupling...");
    const changeCoupling = analyzeChangeCoupling(rootDir, onProgress);

    return { commitCounts, hotFiles, changeCoupling };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Warning: git analysis failed: ${msg}`);
    return null;
  }
}

/** Noise patterns: commits matching these get discounted in coupling weight. */
const NOISE_PATTERNS: Array<{ pattern: RegExp; discount: number }> = [
  { pattern: /\b(lint|format|prettier|eslint|style|biome)\b/i, discount: 0.1 },
  { pattern: /\b(merge|bump|release|changelog|version)\b/i, discount: 0.2 },
  { pattern: /\b(refactor|rename|move)\b/i, discount: 0.5 },
];

/**
 * Compute the noise discount for a commit based on its message.
 * Returns 1.0 for normal commits, lower values for noisy commits.
 */
export function analyzeChangeCoupling(rootDir: string, onProgress?: ProgressCallback): ChangeCoupling[] {
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
    let skippedCommits = 0;

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
        skippedCommits++;
      }
    }

    if (skippedCommits > 0) {
      onProgress?.(`Warning: skipped ${skippedCommits} commit${skippedCommits === 1 ? "" : "s"} due to errors`);
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
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Warning: change coupling analysis failed: ${msg}`);
    return [];
  }
  return 1.0;
}

/**
 * Compute age of a commit in days from its ISO date string.
 */
function commitAgeDays(isoDate: string): number {
  const commitDate = new Date(isoDate);
  const now = Date.now();
  return Math.max(0, (now - commitDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Temporal decay: recent changes matter more than old ones.
 * Half-life ~31 days (exp(-age/45)).
 */
function temporalDecay(ageDays: number): number {
  return Math.exp(-ageDays / 45);
}

/**
 * Compute change coupling from pre-parsed commits.
 * Uses the same commit data as the main analysis for consistency.
 *
 * Improvements over naive co-occurrence counting:
 * 1. Inverse-commit-size weighting: large commits contribute less per pair
 * 2. Temporal decay: recent co-changes matter more
 * 3. Noise classification: lint/merge/format commits are discounted
 * 4. Jaccard similarity for symmetric confidence metric
 */
export function computeChangeCoupling(commits: ParsedCommit[]): ChangeCoupling[] {
  // Track which commits each file appears in (for Jaccard)
  const fileCommitSets = new Map<string, Set<number>>();
  // Weighted co-change scores
  const weightedCoChanges = new Map<string, number>();
  // Raw co-change counts (for display)
  const rawCoChanges = new Map<string, number>();

  for (let ci = 0; ci < commits.length; ci++) {
    const commit = commits[ci];
    const files = commit.files;
    if (files.length < 2) continue;

    // Track file → commit set membership
    for (const file of files) {
      if (!fileCommitSets.has(file)) fileCommitSets.set(file, new Set());
      fileCommitSets.get(file)!.add(ci);
    }

    // Compute per-pair weight for this commit
    const pairWeight = 1 / (files.length - 1); // Inverse commit size
    const decay = temporalDecay(commitAgeDays(commit.date));
    const noise = noiseDiscount(commit.message);
    const weight = pairWeight * decay * noise;

    // Build co-occurrence pairs with weight
    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = [files[i], files[j]].sort().join("||");
        weightedCoChanges.set(key, (weightedCoChanges.get(key) ?? 0) + weight);
        rawCoChanges.set(key, (rawCoChanges.get(key) ?? 0) + 1);
      }
    }
  }

  // Compute coupling metrics
  const results: ChangeCoupling[] = [];
  const totalMultiFileCommits = commits.filter((c) => c.files.length >= 2).length;

  // Adaptive minimum threshold
  const minCoChanges = totalMultiFileCommits > 20 ? 3 : 2;

  for (const [key, rawCount] of rawCoChanges) {
    if (rawCount < minCoChanges) continue;

    const [fileA, fileB] = key.split("||");
    const commitsA = fileCommitSets.get(fileA);
    const commitsB = fileCommitSets.get(fileB);
    if (!commitsA || !commitsB) continue;

    // Jaccard similarity: |A ∩ B| / |A ∪ B|
    let intersection = 0;
    for (const c of commitsA) {
      if (commitsB.has(c)) intersection++;
    }
    const union = commitsA.size + commitsB.size - intersection;
    const confidence = union > 0 ? intersection / union : 0;

    const support = totalMultiFileCommits > 0 ? rawCount / totalMultiFileCommits : 0;

    if (confidence >= 0.3) {
      results.push({
        fileA,
        fileB,
        coChangeCount: rawCount,
        support,
        confidence,
      });
    }
  }

  // Sort by weighted score descending (primary), then by confidence (secondary)
  results.sort((a, b) => {
    const wA = weightedCoChanges.get([a.fileA, a.fileB].sort().join("||")) ?? 0;
    const wB = weightedCoChanges.get([b.fileA, b.fileB].sort().join("||")) ?? 0;
    return wB - wA || b.confidence - a.confidence;
  });

  return results.slice(0, 10);
}
