import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { formatScope, formatFunction, formatImpact } from "./format.js";
import type { ServerState } from "./server.js";

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

function ok(text: string): ToolResult {
  return { content: [{ type: "text", text }] };
}

function err(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const CONTENTS_LINES = 150;
const IMPORTER_SNIPPET_LINES = 30;
const MAX_IMPORTER_SNIPPETS = 3;

function readSnippet(absPath: string, maxLines: number): string | null {
  try {
    const raw = fs.readFileSync(absPath, "utf-8");
    const lines = raw.split("\n");
    if (lines.length <= maxLines) return raw;
    return lines.slice(0, maxLines).join("\n") + "\n[...truncated]";
  } catch {
    return null;
  }
}

export function handleScope(args: Record<string, unknown>, state: ServerState): ToolResult {
  const filePath = args.path;
  if (typeof filePath !== "string" || !filePath) {
    return err("path parameter is required");
  }
  if (!state.graph) {
    return err("graph not loaded: run clarte generate first");
  }

  const graphText = formatScope(filePath, state.graph, state.edgesByTarget);

  const parts: string[] = [graphText];

  const absPath = path.resolve(state.rootDir, filePath);
  const contents = readSnippet(absPath, CONTENTS_LINES);
  if (contents !== null) {
    parts.push(`\nCONTENTS:\n${contents}`);
  }

  const importers = (state.edgesByTarget.get(filePath) ?? []).map((e) => e.from).slice(0, MAX_IMPORTER_SNIPPETS);

  if (importers.length > 0) {
    const snippetLines: string[] = ["\nIMPORTER_SNIPPETS:"];
    for (const imp of importers) {
      const impAbs = path.resolve(state.rootDir, imp);
      const snippet = readSnippet(impAbs, IMPORTER_SNIPPET_LINES);
      if (snippet !== null) {
        snippetLines.push(`--- ${imp} ---\n${snippet}`);
      }
    }
    if (snippetLines.length > 1) {
      parts.push(snippetLines.join("\n"));
    }
  }

  return ok(parts.join(""));
}

export function handleFunction(args: Record<string, unknown>, state: ServerState): ToolResult {
  const name = args.name;
  if (typeof name !== "string" || !name) {
    return err("name parameter is required");
  }
  if (!state.callGraph) {
    return ok("call graph not available (run clarte generate to build it)");
  }
  const filePath = typeof args.path === "string" ? args.path : undefined;
  const text = formatFunction(name, filePath, state.callerIndex, state.fileCallIndex);
  return ok(text);
}

export function handleImpact(args: Record<string, unknown>, state: ServerState): ToolResult {
  const filePath = args.path;
  if (typeof filePath !== "string" || !filePath) {
    return err("path parameter is required");
  }
  if (!state.graph) {
    return err("graph not loaded: run clarte generate first");
  }
  const depth = typeof args.depth === "number" ? args.depth : undefined;
  const text = formatImpact(filePath, state.graph, state.edgesByTarget, depth);
  return ok(text);
}

// ---------------------------------------------------------------------------
// BM25 implementation
// ---------------------------------------------------------------------------

const BM25_K1 = 1.5;
const BM25_B = 0.75;
const ROUTE_CONTENTS_LINES = 100;
const ROUTE_MAX_COMMITS = 500;
const ROUTE_CO_CHANGE_THRESHOLD = 0.7;
const ROUTE_TEST_PATTERN = /\/(test|tests|spec|__tests__|fixtures)\//;

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

interface Corpus {
  docs: string[][];
  avgdl: number;
  df: Map<string, number>;
}

function buildCorpus(messages: string[]): Corpus {
  const docs = messages.map(tokenize);
  const totalLen = docs.reduce((sum, d) => sum + d.length, 0);
  const avgdl = docs.length === 0 ? 1 : totalLen / docs.length;

  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return { docs, avgdl, df };
}

function bm25Score(queryTokens: string[], doc: string[], corpus: Corpus): number {
  const N = corpus.docs.length;
  const dl = doc.length;

  // Term frequency map for this doc
  const tf = new Map<string, number>();
  for (const t of doc) tf.set(t, (tf.get(t) ?? 0) + 1);

  let score = 0;
  for (const term of queryTokens) {
    const termTf = tf.get(term) ?? 0;
    if (termTf === 0) continue;
    const dfVal = corpus.df.get(term) ?? 0;
    const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
    const tfNorm = (termTf * (BM25_K1 + 1)) / (termTf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / corpus.avgdl)));
    score += idf * tfNorm;
  }
  return score;
}

// ---------------------------------------------------------------------------
// clarte_route handler
// ---------------------------------------------------------------------------

export function handleRoute(args: Record<string, unknown>, state: ServerState): ToolResult {
  const task = args.task;
  if (typeof task !== "string" || !task.trim()) {
    return err("task parameter is required");
  }

  const rootDir = state.rootDir;

  // 1. Fetch recent commit log
  let logOutput: string;
  try {
    logOutput = execSync(`git log --format="%H|%s" --max-count=${ROUTE_MAX_COMMITS}`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ok(
      JSON.stringify(
        { task, files: [], matchedCommits: [], note: "git log failed - no commits or not a git repository" },
        null,
        2,
      ),
    );
  }

  const commits = logOutput
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const sep = line.indexOf("|");
      if (sep === -1) return null;
      return { sha: line.slice(0, sep), message: line.slice(sep + 1) };
    })
    .filter((c): c is { sha: string; message: string } => c !== null);

  if (commits.length === 0) {
    return ok(JSON.stringify({ task, files: [], matchedCommits: [], note: "no commits found" }, null, 2));
  }

  // 2. BM25 rank commits by task description
  const messages = commits.map((c) => c.message);
  const corpus = buildCorpus(messages);
  const queryTokens = tokenize(task);

  const scored = commits.map((c, i) => ({
    ...c,
    score: bm25Score(queryTokens, corpus.docs[i], corpus),
  }));

  const topCommits = scored
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 1);

  if (topCommits.length === 0) {
    return ok(
      JSON.stringify({ task, files: [], matchedCommits: [], note: "no commits matched the task description" }, null, 2),
    );
  }

  // 3. Get files from the highest-scored commit only
  const topCommit = topCommits[0];
  let diffOutput: string;
  try {
    diffOutput = execSync(`git diff-tree --no-commit-id -r --name-only ${topCommit.sha}`, {
      cwd: rootDir,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return ok(
      JSON.stringify({ task, files: [], matchedCommits: [topCommit.message], note: "git diff-tree failed" }, null, 2),
    );
  }

  const changedFiles = diffOutput
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // 4. Pick the single best file: first non-test src file that exists on disk,
  //    falling back to any existing file if all are test files.
  const existing = changedFiles.filter((f) => fs.existsSync(path.resolve(rootDir, f)));
  const selectedFile = existing.find((f) => !ROUTE_TEST_PATTERN.test(f)) ?? existing[0];

  if (!selectedFile) {
    return ok(
      JSON.stringify(
        { task, files: [], matchedCommits: [topCommit.message], note: "no existing files in matched commit" },
        null,
        2,
      ),
    );
  }

  const selectedFiles = [[selectedFile, topCommit.message]] as [string, string][];

  // 5. Build result
  const fileResults = selectedFiles.map(([filePath, matchedCommit]) => {
    const absPath = path.resolve(rootDir, filePath);
    const contents = readSnippet(absPath, ROUTE_CONTENTS_LINES) ?? "";

    // Graph context
    const importers = (state.edgesByTarget.get(filePath) ?? []).map((e) => e.from);

    const coChanges =
      state.graph?.changeCoupling
        .filter((c) => (c.fileA === filePath || c.fileB === filePath) && c.confidence >= ROUTE_CO_CHANGE_THRESHOLD)
        .sort((a, b) => b.coChangeCount - a.coChangeCount)
        .slice(0, 3)
        .map((c) => ({
          file: c.fileA === filePath ? c.fileB : c.fileA,
          confidence: Math.round(c.confidence * 100) / 100,
        })) ?? [];

    const graphRecord = state.graph?.files[filePath];
    const testFile = graphRecord?.testFiles && graphRecord.testFiles.length > 0 ? graphRecord.testFiles[0] : undefined;

    return {
      path: filePath,
      contents,
      importers,
      coChanges,
      ...(testFile !== undefined ? { testFile } : {}),
      matchedCommit,
    };
  });

  const result = {
    task,
    files: fileResults,
    matchedCommit: topCommit.message,
  };

  return ok(JSON.stringify(result, null, 2));
}
