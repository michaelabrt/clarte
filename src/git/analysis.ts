import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ChangeCoupling, GitAnalysis, LagCoupling, ProgressCallback } from "../types.js";
import { gitExec } from "./git.js";

const execFileAsync = promisify(execFile);

/**
 * Adaptive decay half-lives (in decay-constant units, where halfLife = decayConst * ln(2)).
 *
 * Rationale: temporal decay ensures recent co-changes outweigh stale ones. The decay
 * constant adapts to repository velocity so that fast-moving projects don't drown in
 * old coupling signals while slow-moving projects retain enough history for meaningful
 * coupling detection.
 */
const DECAY = {
  /**
   * Fast repos (>30 commits/month): ~20-day half-life.
   * Rationale: 29 / ln(2) ≈ 20 days. In active repos, coupling from 3+ weeks ago
   * is likely stale due to rapid iteration.
   */
  FAST: 29,
  /**
   * Moderate repos: ~31-day half-life.
   * Rationale: 45 / ln(2) ≈ 31 days. Default cadence where monthly coupling
   * patterns are the most relevant signal.
   */
  MODERATE: 45,
  /**
   * Slow repos (<5 commits/month): ~60-day half-life.
   * Rationale: 87 / ln(2) ≈ 60 days. Slow repos need a longer memory to accumulate
   * enough data points for statistically meaningful coupling.
   */
  SLOW: 87,
  /**
   * Commits/month threshold for "fast" repos.
   * Rationale: 30 commits/month ≈ 1+/day is typical for actively developed projects.
   */
  FAST_THRESHOLD: 30,
  /**
   * Commits/month threshold for "slow" repos.
   * Rationale: <5 commits/month means roughly weekly commits; coupling analysis
   * needs a wider window to compensate for sparse data.
   */
  SLOW_THRESHOLD: 5,
} as const;

/**
 * Coupling detection thresholds.
 *
 * Rationale: these values control the precision/recall tradeoff for change coupling.
 * Lower thresholds surface more pairs but increase noise; higher thresholds miss
 * real coupling. Values were tuned against 8 open-source projects to minimize
 * false positives while catching all known co-change pairs from code review history.
 */
const COUPLING = {
  /**
   * Maximum files in a commit before it's considered a mass rename (excluded).
   * Rationale: commits touching 30+ files are usually bulk operations (renames,
   * linter runs, dependency bumps) that create spurious coupling between unrelated files.
   */
  MAX_FILES_PER_COMMIT: 30,
  /**
   * Minimum Jaccard confidence to report a coupling pair.
   * Rationale: Jaccard < 0.3 means files share fewer than 30% of their commits,
   * which is too weak to be actionable. 0.3 was the lowest value that consistently
   * excluded coincidental co-changes in evaluation projects.
   */
  MIN_CONFIDENCE: 0.3,
  /**
   * Minimum co-changes for low-activity repos (<=20 multi-file commits).
   * Rationale: with few commits, even 2 co-changes can indicate a real pattern.
   * Requiring 3 would filter out genuine coupling in young or slow-moving repos.
   */
  MIN_CO_CHANGES_LOW: 2,
  /**
   * Minimum co-changes for active repos (>20 multi-file commits).
   * Rationale: in active repos, 2 co-changes out of 100+ commits is likely noise.
   * 3 provides a slightly higher bar to maintain precision.
   */
  MIN_CO_CHANGES_HIGH: 3,
  /**
   * Multi-file commit count threshold for switching min co-changes.
   * Rationale: 20 multi-file commits is roughly 2 months of weekly multi-file
   * changes. Below this, the repo doesn't have enough data for the stricter threshold.
   */
  ACTIVITY_THRESHOLD: 20,
  /**
   * Maximum lag (in commits) to check for lagged co-change patterns.
   * Rationale: lag > 3 commits usually means the changes are unrelated (developer
   * moved on to a different task). 1-3 commits captures "I changed A, then realized
   * B needs updating" patterns.
   */
  MAX_LAG: 3,
} as const;

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

/** Time window specification: either a number of days or a git ref for range-based analysis */
export type TimeWindow = { days: number } | { ref: string };

/**
 * Parse the output of a single git log call into structured commits.
 * Uses a custom separator to split commits efficiently.
 *
 * Accepts a TimeWindow to control the analysis range:
 * - { days: N } uses --since="N days ago" (default: 90)
 * - { ref: "main" } uses ref..HEAD for branch-specific analysis
 */
function parseGitLog(rootDir: string, window: TimeWindow = { days: 90 }): ParsedCommit[] {
  const args = buildGitLogArgs(window);
  const output = gitExec(args, { cwd: rootDir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 });
  return parseGitLogOutput(output);
}

/**
 * Analyze git activity in the repository to identify recently active files.
 * Returns null if not a git repo or git is unavailable.
 *
 * Uses a single git log call for both commit counting and coupling analysis.
 *
 * @param rootDir - project root directory
 * @param onProgress - optional progress callback
 * @param analysisDays - number of days to look back (default: 90, ignored when sinceRef is set)
 * @param sinceRef - git ref for range-based analysis (e.g. "main"); when set, analysisDays is ignored
 */
export function analyzeGitActivity(
  rootDir: string,
  onProgress?: ProgressCallback,
  analysisDays: number = 90,
  sinceRef?: string,
): GitAnalysis | null {
  try {
    const window: TimeWindow = sinceRef ? { ref: sinceRef } : { days: analysisDays };

    const windowLabel = sinceRef ? `since ${sinceRef}` : `last ${analysisDays} days`;
    onProgress?.(`Analyzing git history (${windowLabel})...`);

    const commits = parseGitLog(rootDir, window);
    if (commits.length === 0) return null;

    // Normalize renamed files so coupling history survives renames
    const renameMap = detectRenames(rootDir, window);
    if (renameMap.size > 0) {
      for (const commit of commits) {
        commit.files = [...new Set(commit.files.map((f) => renameMap.get(f) ?? f))];
      }
    }

    onProgress?.(`Parsed ${commits.length} commits`);
    const result = processCommits(commits, analysisDays, onProgress);
    if (!result) return null;

    const fileChurn = computeFileChurn(rootDir, window);
    return { ...result, fileChurn: fileChurn && fileChurn.size > 0 ? fileChurn : undefined };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Warning: git analysis failed: ${msg}`);
    return null;
  }
}

/**
 * Process parsed commits into hot files, coupling and lag analysis.
 * Shared between sync and async git analysis paths.
 */
function processCommits(
  commits: ParsedCommit[],
  analysisDays: number,
  onProgress?: ProgressCallback,
): Omit<GitAnalysis, "fileChurn"> | null {
  const commitCounts = new Map<string, number>();
  const lastChanged = new Map<string, string>();

  for (const commit of commits) {
    for (const file of commit.files) {
      commitCounts.set(file, (commitCounts.get(file) ?? 0) + 1);
      if (!lastChanged.has(file)) {
        lastChanged.set(file, commit.relativeDate);
      }
    }
  }

  if (commitCounts.size === 0) return null;

  onProgress?.(`Found activity in ${commitCounts.size} files`);

  const sorted = [...commitCounts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const hotFiles: GitAnalysis["hotFiles"] = sorted.slice(0, 15).map(([filePath, commitCount]) => ({
    path: filePath,
    commits: commitCount,
    lastChanged: lastChanged.get(filePath) ?? "",
  }));

  onProgress?.("Analyzing change coupling...");
  const changeCoupling = computeChangeCoupling(commits, analysisDays);
  const lagCouplings = computeLagCoupling(commits, changeCoupling);

  return {
    commitCounts,
    hotFiles,
    changeCoupling,
    lagCouplings: lagCouplings.length > 0 ? lagCouplings : undefined,
  };
}

/**
 * Compute per-file code churn by running git log --numstat.
 * Returns a map of file path to lines added/removed.
 * Returns null on failure (this is optional enrichment data).
 */
export function computeFileChurn(
  rootDir: string,
  window: TimeWindow = { days: 90 },
): Map<string, { linesAdded: number; linesRemoved: number }> | null {
  try {
    const rangeArg = "ref" in window ? `${window.ref}..HEAD` : `--since=${window.days} days ago`;
    const output = gitExec(["log", "--numstat", "--format=", rangeArg, "--no-merges"], {
      cwd: rootDir,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });

    if (!output) return null;

    return parseChurnOutput(output);
  } catch {
    return null;
  }
}

function parseChurnOutput(output: string): Map<string, { linesAdded: number; linesRemoved: number }> {
  const churn = new Map<string, { linesAdded: number; linesRemoved: number }>();

  for (const line of output.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    const parts = trimmed.split("\t");
    if (parts.length < 3) continue;

    const added = parseInt(parts[0], 10);
    const removed = parseInt(parts[1], 10);
    if (Number.isNaN(added) || Number.isNaN(removed)) continue;

    const file = parts.slice(2).join("\t");
    const existing = churn.get(file);
    if (existing) {
      existing.linesAdded += added;
      existing.linesRemoved += removed;
    } else {
      churn.set(file, { linesAdded: added, linesRemoved: removed });
    }
  }

  return churn;
}

/** Noise patterns: commits matching these get discounted in coupling weight. */
const NOISE_PATTERNS: Array<{ pattern: RegExp; discount: number }> = [
  { pattern: /\b(lint|format|prettier|eslint|style|biome)\b/i, discount: 0.1 },
  { pattern: /\b(merge|bump|release|changelog|version)\b/i, discount: 0.2 },
  { pattern: /\b(chore|ci|docs|wip|build|revert)\b/i, discount: 0.3 },
  { pattern: /\b(dependabot|renovate|greenkeeper)\b/i, discount: 0.1 },
  { pattern: /\b(refactor|rename|move)\b/i, discount: 0.5 },
];

/**
 * Compute the noise discount for a commit based on its message.
 * Returns 1.0 for normal commits, lower values for noisy commits.
 */
function noiseDiscount(message: string): number {
  for (const { pattern, discount } of NOISE_PATTERNS) {
    if (pattern.test(message)) return discount;
  }
  return 1.0;
}

/**
 * Compute age of a commit in days from its ISO date string.
 * @param referenceMs - optional fixed reference timestamp (ms since epoch) for deterministic output
 */
function commitAgeDays(isoDate: string, referenceMs?: number): number {
  const commitDate = new Date(isoDate);
  const now = referenceMs ?? Date.now();
  return Math.max(0, (now - commitDate.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Compute the decay constant based on repository velocity.
 * Fast-moving repos (>30 commits/month) use a shorter half-life (20 days),
 * slow-moving repos (<5 commits/month) use a longer half-life (60 days),
 * and moderate repos keep the default half-life of ~31 days.
 *
 * @param totalCommits - total number of commits in the analysis window
 * @param windowDays - size of the analysis window in days (default: 90)
 */
export function adaptiveDecayConstant(totalCommits: number, windowDays: number = 90): number {
  const months = Math.max(windowDays / 30, 1); // avoid division by zero
  const commitsPerMonth = totalCommits / months;
  if (commitsPerMonth > DECAY.FAST_THRESHOLD) return DECAY.FAST;
  if (commitsPerMonth < DECAY.SLOW_THRESHOLD) return DECAY.SLOW;
  return DECAY.MODERATE;
}

/**
 * Temporal decay: recent changes matter more than old ones.
 * Decay constant is adaptive based on repository velocity.
 */
function temporalDecay(ageDays: number, decayConstant: number = 45): number {
  return Math.exp(-ageDays / decayConstant);
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
export function computeChangeCoupling(
  commits: ParsedCommit[],
  windowDays: number = 90,
  referenceMs?: number,
): ChangeCoupling[] {
  const fileCommitSets = new Map<string, Set<number>>();
  const weightedCoChanges = new Map<string, number>();
  const rawCoChanges = new Map<string, number>();

  const MAX_COUPLING_FILES = COUPLING.MAX_FILES_PER_COMMIT;

  const decayConst = adaptiveDecayConstant(commits.length, windowDays);

  for (let ci = 0; ci < commits.length; ci++) {
    const commit = commits[ci];
    const files = commit.files;
    if (files.length < 2 || files.length > MAX_COUPLING_FILES) continue;

    for (const file of files) {
      if (!fileCommitSets.has(file)) fileCommitSets.set(file, new Set());
      fileCommitSets.get(file)!.add(ci);
    }

    const pairWeight = 1 / (files.length - 1); // Inverse commit size
    const decay = temporalDecay(commitAgeDays(commit.date, referenceMs), decayConst);
    const noise = noiseDiscount(commit.message);
    const weight = pairWeight * decay * noise;

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        const key = [files[i], files[j]].sort().join("||");
        weightedCoChanges.set(key, (weightedCoChanges.get(key) ?? 0) + weight);
        rawCoChanges.set(key, (rawCoChanges.get(key) ?? 0) + 1);
      }
    }
  }

  const results: ChangeCoupling[] = [];
  const totalMultiFileCommits = commits.filter((c) => c.files.length >= 2).length;

  // Adaptive minimum threshold
  const minCoChanges =
    totalMultiFileCommits > COUPLING.ACTIVITY_THRESHOLD ? COUPLING.MIN_CO_CHANGES_HIGH : COUPLING.MIN_CO_CHANGES_LOW;

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

    // Directional conditional probabilities (computed before filter)
    const confidenceAB = commitsA.size > 0 ? intersection / commitsA.size : 0;
    const confidenceBA = commitsB.size > 0 ? intersection / commitsB.size : 0;

    if (confidence >= COUPLING.MIN_CONFIDENCE || confidenceAB >= 0.6 || confidenceBA >= 0.6) {
      results.push({
        fileA,
        fileB,
        coChangeCount: rawCount,
        support,
        confidence,
        confidenceAB,
        confidenceBA,
      });
    }
  }

  // Pre-compute weighted scores to avoid allocations inside comparator
  const resultWeights = new Map<number, number>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const key = r.fileA < r.fileB ? `${r.fileA}||${r.fileB}` : `${r.fileB}||${r.fileA}`;
    resultWeights.set(i, weightedCoChanges.get(key) ?? 0);
  }

  // Sort by weighted score descending (primary), then by confidence (secondary),
  // with alphabetical tiebreaker for deterministic output
  const indices = results.map((_, i) => i);
  indices.sort(
    (a, b) =>
      resultWeights.get(b)! - resultWeights.get(a)! ||
      results[b].confidence - results[a].confidence ||
      results[a].fileA.localeCompare(results[b].fileA) ||
      results[a].fileB.localeCompare(results[b].fileB),
  );
  const sorted = indices.map((i) => results[i]);

  return sorted.slice(0, 10);
}

/**
 * Detect lag-adjusted temporal coupling: files that change within 1-3 commits
 * of each other (but NOT in the same commit). This captures reactive patterns
 * where modifying one file predictably triggers changes in another shortly after.
 *
 * Only examines pairs that already have high same-commit coupling, since those
 * are the most likely to exhibit lag patterns.
 */
export function computeLagCoupling(commits: ParsedCommit[], couplingResults: ChangeCoupling[]): LagCoupling[] {
  // Build file timeline: map each file to the commit indices it appears in
  const fileTimeline = new Map<string, number[]>();
  for (let ci = 0; ci < commits.length; ci++) {
    for (const file of commits[ci].files) {
      const timeline = fileTimeline.get(file);
      if (timeline) {
        timeline.push(ci);
      } else {
        fileTimeline.set(file, [ci]);
      }
    }
  }

  const results: LagCoupling[] = [];

  for (const pair of couplingResults) {
    const timelineA = fileTimeline.get(pair.fileA);
    const timelineB = fileTimeline.get(pair.fileB);
    if (!timelineA || !timelineB) continue;

    const setB = new Set(timelineB);

    // For each commit of fileA, check if fileB changed within 1-3 commits (not same commit)
    let lagScore = 0;
    for (const ciA of timelineA) {
      for (let lag = 1; lag <= COUPLING.MAX_LAG; lag++) {
        // Check both directions (fileB changed before or after fileA)
        if (setB.has(ciA + lag) || setB.has(ciA - lag)) {
          lagScore += 1 / lag; // Inverse lag weighting
        }
      }
    }

    // Only flag if lag coupling is significant relative to same-commit coupling
    if (lagScore > pair.coChangeCount * 0.5) {
      results.push({
        fileA: pair.fileA,
        fileB: pair.fileB,
        sameCommitCount: pair.coChangeCount,
        lagScore,
      });
    }
  }

  results.sort((a, b) => b.lagScore - a.lagScore || a.fileA.localeCompare(b.fileA) || a.fileB.localeCompare(b.fileB));

  return results;
}

/**
 * Detect file renames in git history and build a normalization map.
 * Maps old file names to their current (newest) name, resolved transitively.
 */
function detectRenames(rootDir: string, window: TimeWindow): Map<string, string> {
  try {
    const rangeArg = "ref" in window ? `${window.ref}..HEAD` : `--since=${window.days} days ago`;
    const output = gitExec(["log", "--no-merges", rangeArg, "-M", "--diff-filter=R", "--name-status", "--format="], {
      cwd: rootDir,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });
    if (!output?.trim()) return new Map();

    const renameMap = new Map<string, string>();
    for (const line of output.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length >= 3 && parts[0].startsWith("R")) {
        renameMap.set(parts[1], parts[2]);
      }
    }

    // Resolve transitive renames: A->B, B->C => A->C
    for (const [oldName] of renameMap) {
      let current = renameMap.get(oldName)!;
      const seen = new Set<string>([oldName]);
      while (renameMap.has(current) && !seen.has(current)) {
        seen.add(current);
        current = renameMap.get(current)!;
      }
      renameMap.set(oldName, current);
    }

    return renameMap;
  } catch {
    return new Map();
  }
}

async function detectRenamesAsync(rootDir: string, window: TimeWindow): Promise<Map<string, string>> {
  try {
    const rangeArg = "ref" in window ? `${window.ref}..HEAD` : `--since=${window.days} days ago`;
    const { stdout } = await execFileAsync(
      "git",
      ["log", "--no-merges", rangeArg, "-M", "--diff-filter=R", "--name-status", "--format="],
      { cwd: rootDir, timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
    );
    if (!stdout?.trim()) return new Map();

    const renameMap = new Map<string, string>();
    for (const line of stdout.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const parts = trimmed.split("\t");
      if (parts.length >= 3 && parts[0].startsWith("R")) {
        renameMap.set(parts[1], parts[2]);
      }
    }

    for (const [oldName] of renameMap) {
      let current = renameMap.get(oldName)!;
      const seen = new Set<string>([oldName]);
      while (renameMap.has(current) && !seen.has(current)) {
        seen.add(current);
        current = renameMap.get(current)!;
      }
      renameMap.set(oldName, current);
    }

    return renameMap;
  } catch {
    return new Map();
  }
}

// --- Async variants for watch mode (non-blocking event loop) ---

function buildGitLogArgs(window: TimeWindow): string[] {
  const SEP = "---CLARTE_COMMIT_SEP---";
  const US = "\x1f";
  const rangeArg = "ref" in window ? `${window.ref}..HEAD` : `--since=${window.days} days ago`;
  return [
    "log",
    "--no-merges",
    rangeArg,
    "--diff-filter=ACMRT",
    "--name-only",
    `--format=${SEP}%H${US}%aI${US}%ar${US}%s`,
  ];
}

function parseGitLogOutput(output: string): ParsedCommit[] {
  const SEP = "---CLARTE_COMMIT_SEP---";
  if (!output.trim()) return [];

  const commits: ParsedCommit[] = [];
  const chunks = output.split(SEP).filter(Boolean);

  for (const chunk of chunks) {
    const lines = chunk.split("\n").filter(Boolean);
    if (lines.length === 0) continue;

    const headerLine = lines[0];
    const parts = headerLine.split("\x1f");
    if (parts.length < 4) continue;

    const hash = parts[0];
    const date = parts[1];
    const relativeDate = parts[2];
    const message = parts.slice(3).join("\x1f");

    const files = [
      ...new Set(
        lines
          .slice(1)
          .map((f) => f.trim())
          .filter(Boolean),
      ),
    ];

    if (files.length > 0) {
      commits.push({ hash, date, relativeDate, message, files });
    }
  }

  return commits;
}

async function parseGitLogAsync(rootDir: string, window: TimeWindow = { days: 90 }): Promise<ParsedCommit[]> {
  const args = buildGitLogArgs(window);
  const { stdout } = await execFileAsync("git", args, {
    cwd: rootDir,
    timeout: 15000,
    maxBuffer: 10 * 1024 * 1024,
  });
  return parseGitLogOutput(stdout);
}

async function computeFileChurnAsync(
  rootDir: string,
  window: TimeWindow = { days: 90 },
): Promise<Map<string, { linesAdded: number; linesRemoved: number }> | null> {
  try {
    const rangeArg = "ref" in window ? `${window.ref}..HEAD` : `--since=${window.days} days ago`;
    const { stdout } = await execFileAsync("git", ["log", "--numstat", "--format=", rangeArg, "--no-merges"], {
      cwd: rootDir,
      timeout: 15000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const output = stdout.trim();
    if (!output) return null;

    return parseChurnOutput(output);
  } catch {
    return null;
  }
}

/**
 * Async version of analyzeGitActivity for watch mode.
 * Uses non-blocking child_process.execFile instead of execSync.
 */
export async function analyzeGitActivityAsync(
  rootDir: string,
  onProgress?: ProgressCallback,
  analysisDays: number = 90,
  sinceRef?: string,
): Promise<GitAnalysis | null> {
  try {
    const window: TimeWindow = sinceRef ? { ref: sinceRef } : { days: analysisDays };

    const windowLabel = sinceRef ? `since ${sinceRef}` : `last ${analysisDays} days`;
    onProgress?.(`Analyzing git history (${windowLabel})...`);

    const commits = await parseGitLogAsync(rootDir, window);
    if (commits.length === 0) return null;

    const renameMap = await detectRenamesAsync(rootDir, window);
    if (renameMap.size > 0) {
      for (const commit of commits) {
        commit.files = [...new Set(commit.files.map((f) => renameMap.get(f) ?? f))];
      }
    }

    onProgress?.(`Parsed ${commits.length} commits`);
    const result = processCommits(commits, analysisDays, onProgress);
    if (!result) return null;

    const fileChurn = await computeFileChurnAsync(rootDir, window);
    return { ...result, fileChurn: fileChurn && fileChurn.size > 0 ? fileChurn : undefined };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    onProgress?.(`Warning: git analysis failed: ${msg}`);
    return null;
  }
}
