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
  // Verbs that also serve as discriminative function-name stems are left to
  // IDF rather than hard-stopped (parse, read, write, wrap, skip removed).
  "join",
  "split",
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
// PATH_WEIGHT > SYMBOL_WEIGHT: path tokens have higher precision (3-5 tokens identify
// file identity vs 50+ symbol tokens each less unique).
const PATH_WEIGHT = 1.5;
const SYMBOL_WEIGHT = 1.0;
const EXPANSION_FACTOR = 0.3;
const COUPLING_FACTOR = 0.4;
const TEST_PROXY_FACTOR = 0.6;
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

type FieldData = { tokens: string[]; termFreq: Map<string, number> };
type FileDoc = {
  path: FieldData;
  symbols: FieldData;
  allTerms: Set<string>; // union of both fields; prevents double-counting in df
};

/** Score a single document against query terms using BM25F. */
function scoreBM25F(
  doc: FileDoc,
  queryTerms: string[],
  df: Map<string, number>,
  N: number,
  avgdlPath: number,
  avgdlSymbols: number,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const docFreq = df.get(term) ?? 1;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    const tfPath = doc.path.termFreq.get(term) ?? 0;
    const tfSymbol = doc.symbols.termFreq.get(term) ?? 0;

    let fieldScore = 0;
    if (tfPath > 0) {
      const norm = tfPath + BM25_K1 * (1 - BM25_B + BM25_B * (doc.path.tokens.length / avgdlPath));
      fieldScore += (PATH_WEIGHT * (tfPath * (BM25_K1 + 1))) / norm;
    }
    if (tfSymbol > 0) {
      const norm = tfSymbol + BM25_K1 * (1 - BM25_B + BM25_B * (doc.symbols.tokens.length / avgdlSymbols));
      fieldScore += (SYMBOL_WEIGHT * (tfSymbol * (BM25_K1 + 1))) / norm;
    }

    score += idf * fieldScore;
  }
  return score;
}

/** Build a BM25F document from a file path and its merged symbol list. */
function buildDocument(filePath: string, symbols: string[]): FileDoc {
  const pathTokens = filePath.split(/[/\\.]/).flatMap((seg) => tokenizeIdentifier(seg));
  const symbolTokens = symbols.flatMap((name) => tokenizeIdentifier(name));

  const pathTermFreq = new Map<string, number>();
  for (const t of pathTokens) pathTermFreq.set(t, (pathTermFreq.get(t) ?? 0) + 1);

  const symbolTermFreq = new Map<string, number>();
  for (const t of symbolTokens) symbolTermFreq.set(t, (symbolTermFreq.get(t) ?? 0) + 1);

  const allTerms = new Set<string>([...pathTermFreq.keys(), ...symbolTermFreq.keys()]);

  return {
    path: { tokens: pathTokens, termFreq: pathTermFreq },
    symbols: { tokens: symbolTokens, termFreq: symbolTermFreq },
    allTerms,
  };
}

/**
 * Resolve likely edit targets from a task description using the persisted graph.
 *
 * Algorithm:
 * 1. Tokenize query (camelCase-aware, stop-word filtered)
 * 2. Build BM25F documents: path field + symbols field (exported names from edges, deduped with AST-defined symbolNames)
 * 3. Score each file with BM25F (per-field avgdl normalization, unified IDF)
 * 4. Expand: add 1-hop import neighbors at EXPANSION_FACTOR of the seed's score
 * 5. Add co-change partners above confidence threshold at COUPLING_FACTOR of seed score
 * 6. Sort by score descending, return top N
 */
export function resolveEditTargets(query: string, graph: PersistedGraph, maxTargets = DEFAULT_MAX_TARGETS): string[] {
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];

  const filePaths = Object.keys(graph.files).filter((fp) => !TEST_FILE_RE.test(fp));
  if (filePaths.length === 0) return [];

  // Collect exported symbol names per file: symbols other files import from it
  const exportedNames = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!exportedNames.has(edge.to)) exportedNames.set(edge.to, []);
    exportedNames.get(edge.to)?.push(...edge.importedNames);
  }

  // Build BM25F documents (dedup exported + defined symbols to avoid double-counting)
  const docs = new Map<string, FileDoc>(
    filePaths.map((fp) => {
      const allSymbols = [...new Set([...(exportedNames.get(fp) ?? []), ...(graph.files[fp]?.symbolNames ?? [])])];
      return [fp, buildDocument(fp, allSymbols)];
    }),
  );

  // Per-field avgdl for BM25F normalization
  const N = docs.size;
  const avgdlPath = Math.max(1, [...docs.values()].reduce((s, d) => s + d.path.tokens.length, 0) / N);
  // Exclude zero-symbol docs (config files, .d.ts) to avoid deflating the average.
  // Floor at 5 (typical minimum for a non-trivial source file).
  const symbolDocs = [...docs.values()].filter((d) => d.symbols.tokens.length > 0);
  const avgdlSymbols =
    symbolDocs.length > 0
      ? Math.max(5, symbolDocs.reduce((s, d) => s + d.symbols.tokens.length, 0) / symbolDocs.length)
      : 5;

  // df increments once per document regardless of which field(s) the term appears in.
  const df = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const term of doc.allTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const debugBM25 = process.env.DEBUG_BM25 === "1";

  // BM25F scoring
  const scores = new Map<string, number>();
  for (const [fp, doc] of docs) {
    const score = scoreBM25F(doc, queryTerms, df, N, avgdlPath, avgdlSymbols);
    if (score > 0) scores.set(fp, score);
  }

  // Test-file proxy: score test files using source-file IDF, transfer to source files.
  // Test file paths encode what they test (e.g. "test/sqlite-query-runner.test.ts"),
  // so they match queries that the source file's path alone might miss.
  const testMappingEntries = Object.entries(graph.testMapping);
  if (testMappingEntries.length > 0) {
    const testToSource = new Map<string, string[]>();
    for (const [source, tests] of testMappingEntries) {
      for (const test of tests) {
        if (!testToSource.has(test)) testToSource.set(test, []);
        testToSource.get(test)?.push(source);
      }
    }

    for (const [testFp, sources] of testToSource) {
      if (!graph.files[testFp]) continue;
      const allSymbols = [
        ...new Set([...(exportedNames.get(testFp) ?? []), ...(graph.files[testFp]?.symbolNames ?? [])]),
      ];
      const testDoc = buildDocument(testFp, allSymbols);
      const testScore = scoreBM25F(testDoc, queryTerms, df, N, avgdlPath, avgdlSymbols);
      if (testScore > 0) {
        const proxyScore = testScore * TEST_PROXY_FACTOR;
        for (const source of sources) {
          if (proxyScore > (scores.get(source) ?? 0)) {
            scores.set(source, proxyScore);
          }
        }
      }
    }
  }

  if (scores.size === 0) return [];

  if (debugBM25) {
    for (const [fp, score] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const doc = docs.get(fp)!;
      const matched = queryTerms.filter((t) => doc.allTerms.has(t));
      console.error(
        JSON.stringify({
          file: fp,
          score,
          matched,
          pathLen: doc.path.tokens.length,
          symLen: doc.symbols.tokens.length,
        }),
      );
    }
  }

  const directMatches = new Set(scores.keys());

  // Import graph expansion: 1-hop neighbors (both importers and imports).
  // Uses max so neighbors that already have a BM25 score can still be boosted.
  const neighbors = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!neighbors.has(edge.from)) neighbors.set(edge.from, []);
    if (!neighbors.has(edge.to)) neighbors.set(edge.to, []);
    neighbors.get(edge.from)?.push(edge.to);
    neighbors.get(edge.to)?.push(edge.from);
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

/**
 * Check whether the prompt already mentions any of the resolved targets.
 * When true, the agent can self-localize and pre-flight adds no value.
 */
export function promptMentionsTargets(query: string, targets: string[]): boolean {
  return targets.some((t) => query.includes(t));
}
