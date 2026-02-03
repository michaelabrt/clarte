import type { PersistedGraph } from "../types/persisted-graph.js";

const STOP_WORDS = new Set([
  // Articles, prepositions, conjunctions
  "a",
  "an",
  "the",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "and",
  "or",
  "is",
  "it",
  "be",
  "are",
  "was",
  "has",
  "have",
  "do",
  "does",
  "did",
  "will",
  "can",
  "if",
  "so",
  "no",
  "as",
  "by",
  // Bug report verbs/actions
  "fix",
  "bug",
  "add",
  "update",
  "change",
  "make",
  "set",
  "get",
  "use",
  "run",
  "call",
  "skip",
  "join",
  "wrap",
  "split",
  "read",
  "write",
  "parse",
  // Pronouns and determiners
  "that",
  "this",
  "with",
  "from",
  "not",
  "but",
  "should",
  "when",
  "what",
  "how",
  "why",
  "like",
  "also",
  "only",
  "each",
  "more",
  "some",
  "just",
  "into",
  // Common programming terms that match too many files
  "true",
  "false",
  "null",
  "type",
  "values",
  "value",
  "default",
  "string",
  "strings",
  "array",
  "arrays",
  "number",
  "object",
  "function",
  "class",
  "file",
  "files",
  "test",
  "tests",
  "column",
  "columns",
  "options",
  "config",
  "index",
  "generated",
  "stored",
  "against",
  "individual",
  "quoted",
  "numeric",
  "serialized",
  "deserialized",
  "validated",
  "validates",
  "generation",
  "three",
  "bugs",
  "comma-joined",
  "comma-separated",
  "commas",
]);

const TEST_FILE_RE = /(?:^|\/)(?:test|spec|__tests__|__mocks__)\/|\.(?:test|spec)\.[jt]sx?$/;

const BM25_K1 = 1.2;
const BM25_B = 0.75;
const EXPANSION_FACTOR = 0.3;
const COUPLING_FACTOR = 0.4;
const DEFAULT_MAX_TARGETS = 5;
const MIN_COUPLING_CONFIDENCE = 0.5;

/**
 * Split camelCase/PascalCase on lowercase→uppercase boundaries.
 * "AbstractSqlite" → ["Abstract", "Sqlite"], "SQLite" → ["SQLite"] (treated as one word).
 */
function splitCamelCase(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
}

/**
 * Tokenize an identifier into lowercase terms, splitting on non-alphanumeric
 * characters and camelCase/PascalCase boundaries.
 * "AbstractSqliteQueryRunner" → ["abstract", "sqlite", "query", "runner"]
 */
function tokenizeIdentifier(id: string): string[] {
  return id
    .split(/[^a-zA-Z0-9]+/)
    .flatMap((part) => splitCamelCase(part))
    .map((t) => t.toLowerCase())
    .filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
}

/**
 * Tokenize a query into keywords suitable for BM25 matching.
 * Applies camelCase-aware splitting and strips stop words.
 */
export function tokenizeQuery(query: string): string[] {
  return [...new Set(tokenizeIdentifier(query))];
}

type FileDoc = { tokens: string[]; termFreq: Map<string, number> };

/** Build a BM25 document from a file path, its exported symbol names and all defined symbols. */
function buildDocument(filePath: string, exportedNames: string[], definedSymbols: string[]): FileDoc {
  const pathTokens = filePath.split(/[/\\.]/).flatMap((seg) => tokenizeIdentifier(seg));
  const symbolTokens = [...exportedNames, ...definedSymbols].flatMap((name) => tokenizeIdentifier(name));
  const tokens = [...pathTokens, ...symbolTokens];
  const termFreq = new Map<string, number>();
  for (const t of tokens) {
    termFreq.set(t, (termFreq.get(t) ?? 0) + 1);
  }
  return { tokens, termFreq };
}

/**
 * Resolve likely edit targets from a task description using the persisted graph.
 *
 * Algorithm:
 * 1. Tokenize query (camelCase-aware, stop-word filtered)
 * 2. Build BM25 documents: file path tokens + exported symbol names (from importedNames on edges)
 * 3. Score each file with BM25
 * 4. Expand: add 1-hop import neighbors at EXPANSION_FACTOR of the seed's score
 * 5. Add co-change partners above confidence threshold at COUPLING_FACTOR of seed score
 * 6. Sort by score descending, return top N
 */
export function resolveEditTargets(
  query: string,
  graph: PersistedGraph,
  maxTargets = DEFAULT_MAX_TARGETS,
): string[] {
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];

  const filePaths = Object.keys(graph.files).filter((fp) => !TEST_FILE_RE.test(fp));
  if (filePaths.length === 0) return [];

  // Collect exported symbol names per file: symbols other files import from it
  const exportedNames = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!exportedNames.has(edge.to)) exportedNames.set(edge.to, []);
    exportedNames.get(edge.to)!.push(...edge.importedNames);
  }

  // Build BM25 documents
  const docs = new Map<string, FileDoc>(
    filePaths.map((fp) => [fp, buildDocument(fp, exportedNames.get(fp) ?? [], graph.files[fp]?.symbolNames ?? [])]),
  );

  // Compute IDF inputs
  const N = docs.size;
  const avgdl = Math.max(1, [...docs.values()].reduce((sum, d) => sum + d.tokens.length, 0) / N);
  const df = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const term of doc.termFreq.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // BM25 scoring
  const scores = new Map<string, number>();
  for (const [fp, doc] of docs) {
    let score = 0;
    const dl = doc.tokens.length;
    for (const term of queryTerms) {
      const tf = doc.termFreq.get(term) ?? 0;
      if (tf === 0) continue;
      const docFreq = df.get(term) ?? 1;
      const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);
      const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (dl / avgdl)));
      score += idf * tfNorm;
    }
    if (score > 0) scores.set(fp, score);
  }

  if (scores.size === 0) return [];

  const directMatches = new Set(scores.keys());

  // Import graph expansion: 1-hop neighbors (both importers and imports).
  // Uses max so neighbors that already have a BM25 score can still be boosted.
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, []);
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, []);
    neighbors.get(edge.from)!.push(edge.to);
    neighbors.get(edge.to)!.push(edge.from);
  }
  for (const [file, score] of [...scores.entries()]) {
    if (!directMatches.has(file)) continue;
    const expandedScore = score * EXPANSION_FACTOR;
    for (const neighbor of neighbors.get(file) ?? []) {
      if (expandedScore > (scores.get(neighbor) ?? 0)) {
        scores.set(neighbor, expandedScore);
      }
    }
  }

  // Co-change coupling: add partners of direct matches
  for (const coupling of graph.changeCoupling) {
    if (coupling.confidence < MIN_COUPLING_CONFIDENCE) continue;
    if (directMatches.has(coupling.fileA) && !scores.has(coupling.fileB) && graph.files[coupling.fileB]) {
      scores.set(coupling.fileB, (scores.get(coupling.fileA) ?? 1) * COUPLING_FACTOR);
    }
    if (directMatches.has(coupling.fileB) && !scores.has(coupling.fileA) && graph.files[coupling.fileA]) {
      scores.set(coupling.fileA, (scores.get(coupling.fileB) ?? 1) * COUPLING_FACTOR);
    }
  }

  // Sort by score descending, then path for stability
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, maxTargets)
    .map(([fp]) => fp);
}
