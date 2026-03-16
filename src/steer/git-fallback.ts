import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

const GIT_K1 = 1.5;
const GIT_B = 0.75;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

export interface GitFallbackResult {
  files: string[];
  commitMessage: string;
}

/**
 * Resolve edit targets from git commit history using BM25.
 * Finds the most similar past commit message and returns the files it touched
 * along with the matched commit message.
 * Side-effecting: shells out to git.
 */
export function resolveTargetsFromHistory(query: string, rootDir: string, maxTargets = 5): GitFallbackResult | null {
  let logOutput: string;
  try {
    logOutput = execSync("git log --format=%H|%s --max-count=500", {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const commits = logOutput
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("|");
      return sep === -1 ? null : { sha: line.slice(0, sep), message: line.slice(sep + 1) };
    })
    .filter((c): c is { sha: string; message: string } => c !== null);

  if (commits.length === 0) return null;

  const docs = commits.map((c) => tokenize(c.message));
  const avgdl = docs.reduce((s, d) => s + d.length, 0) / docs.length || 1;
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const t of new Set(doc)) df.set(t, (df.get(t) ?? 0) + 1);
  }

  const queryTokens = tokenize(query);
  const N = docs.length;

  let bestScore = 0;
  let bestCommit: { sha: string; message: string } | null = null;
  for (let i = 0; i < commits.length; i++) {
    const doc = docs[i];
    const dl = doc.length;
    const tf = new Map<string, number>();
    for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);
    let score = 0;
    for (const term of queryTokens) {
      const f = tf.get(term) ?? 0;
      if (!f) continue;
      const dfv = df.get(term) ?? 0;
      const idf = Math.log((N - dfv + 0.5) / (dfv + 0.5) + 1);
      score += (idf * (f * (GIT_K1 + 1))) / (f + GIT_K1 * (1 - GIT_B + (GIT_B * dl) / avgdl));
    }
    if (score > bestScore) {
      bestScore = score;
      bestCommit = commits[i];
    }
  }

  if (!bestCommit || bestScore === 0) return null;

  let diffOutput: string;
  try {
    diffOutput = execSync(`git diff-tree --no-commit-id -r --name-only ${bestCommit.sha}`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return null;
  }

  const files = diffOutput
    .trim()
    .split("\n")
    .filter(Boolean)
    .filter((f) => {
      const parts = f.split("/");
      const isTest = parts.some(
        (p) => p === "test" || p === "tests" || p === "spec" || p === "__tests__" || p === "fixtures",
      );
      return !isTest && existsSync(resolve(rootDir, f));
    })
    .slice(0, maxTargets);

  if (files.length === 0) return null;
  return { files, commitMessage: bestCommit.message };
}
