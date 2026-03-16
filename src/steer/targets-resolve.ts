import type { PersistedGraph } from "../core/types/persisted-graph.js";
import { isTestFile } from "../core/utils.js";

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
  // IDF rather than hard-stopped (parse, read, write, wrap, skip, split, join removed).
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

/**
 * Programming synonym groups. Each array is a bidirectional synonym cluster.
 * When a query contains any term in a group, all other terms in that group
 * are added as expansion terms with reduced weight (via IDF dilution).
 */
// SYNC: generate-hooks.ts PROMPT_SCRIPT SYN_GROUPS (S3: split overly broad groups)
const SYNONYM_GROUPS: string[][] = [
  ["auth", "authenticate", "authentication", "authenticator", "authorize", "authorization"],
  ["jwt", "jsonwebtoken", "token"],
  ["session", "cookie", "credential"],
  ["db", "database"],
  ["datastore", "persistence"],
  ["sql", "sqlite", "postgres", "mysql", "mariadb"],
  ["orm", "repository", "entity", "migration"],
  ["api", "endpoint"],
  ["route", "handler", "middleware"],
  ["http", "request", "response", "fetch"],
  ["ws", "websocket", "socket"],
  ["msg", "message"],
  ["event", "signal"],
  ["err", "error", "exception", "fault"],
  ["log", "logger", "logging"],
  ["cache", "memoize", "memo"],
  ["queue", "worker", "job"],
  ["pub", "publish"],
  ["subscribe", "subscription", "subscriber"],
  ["env", "environment", "dotenv"],
  ["cfg", "config", "configure", "configuration", "settings"],
  ["cmd", "command", "cli"],
  ["fs", "filesystem", "directory"],
  ["fmt", "format", "formatter"],
  ["lint", "linter", "eslint"],
  ["pkg", "package", "module"],
  ["dep", "dependency", "dependencies"],
  ["tpl", "template"],
  ["render", "renderer"],
  ["jsx", "tsx", "component", "react"],
  ["css", "style", "stylesheet", "tailwind"],
  ["nav", "navigation"],
  ["router", "routing"],
  ["i18n", "locale", "translation", "intl"],
  ["tz", "timezone", "datetime"],
  ["url", "uri", "href", "link"],
  ["regex", "regexp", "pattern"],
  ["json", "serialize", "serialization", "serializer", "deserialize", "deserialization", "marshal"],
  ["schema", "validate", "validation", "validator"],
  ["interceptor", "guard", "filter"],
  ["mock", "stub", "fake", "spy"],
  ["async", "promise", "await"],
  ["stream", "pipe", "transform"],
  ["readable", "writable"],
  ["crypto", "encrypt", "decrypt"],
  ["hash", "hmac"],
  ["cert", "certificate", "tls", "ssl"],
  ["verify", "verification"],
  ["param", "parameter", "arg", "argument"],
  ["init", "initialize", "initialization", "initializer", "bootstrap"],
  ["delete", "remove", "destroy"],
  ["send", "emit", "dispatch"],
  ["retry", "backoff"],
  ["timeout", "deadline"],
  ["throttle", "debounce", "ratelimit"],
  ["hook", "callback", "listener"],
  ["plugin", "extension", "addon"],
  ["permission", "access", "acl"],
  ["parse", "parser", "parsing"],
  ["upload", "download", "transfer"],
  ["cron", "schedule", "timer"],
  // Verb/noun/agent triads for morphological bridging
  ["compile", "compilation", "compiler"],
  ["generate", "generation", "generator"],
  ["migrate", "migration"],
  ["connect", "connection"],
  ["execute", "execution", "executor"],
  ["resolve", "resolution", "resolver"],
  ["register", "registration"],
];

/** Build a lookup from term → expanded synonyms (excluding the term itself). */
const SYNONYM_MAP: Map<string, string[]> = (() => {
  const map = new Map<string, string[]>();
  for (const group of SYNONYM_GROUPS) {
    for (const term of group) {
      const others = group.filter((t) => t !== term);
      const existing = map.get(term) ?? [];
      map.set(term, [...new Set([...existing, ...others])]);
    }
  }
  return map;
})();

/**
 * Expand query terms with programming synonyms.
 * Returns original terms plus synonym expansions (deduplicated).
 */
function expandQuerySynonyms(terms: string[]): { original: string[]; expanded: string[] } {
  const expanded = new Set<string>();
  for (const term of terms) {
    const synonyms = SYNONYM_MAP.get(term);
    if (synonyms) {
      for (const syn of synonyms) {
        if (!terms.includes(syn) && !STOP_WORDS.has(syn)) expanded.add(syn);
      }
    }
  }
  return { original: terms, expanded: [...expanded] };
}

const BM25_K1 = 1.2;
// Per-field b: different field lengths need different normalization strength.
// Path tokens (3-5) barely need normalization; symbols (5-50) moderate; imports (10-100+) stronger.
// Literature (Clinchant & Gaussier 2010) recommends b=0.3-0.5 for short docs.
const BM25_B_PATH = 0.3;
const BM25_B_SYMBOLS = 0.4;
const BM25_B_IMPORTS = 0.5;
// PATH_WEIGHT > SYMBOL_WEIGHT: path tokens have higher precision (3-5 tokens identify
// file identity vs 50+ symbol tokens each less unique). Ratio 2:1 validated via grid
// search across 12 synthetic + 4 integration benchmarks (MRR 0.917 -> 0.958, zero regressions).
const PATH_WEIGHT = 2.0;
const SYMBOL_WEIGHT = 1.0;
// Directional expansion: consumers (importers) of a BM25 match get a larger boost
// than providers (imports). Bug reports describe symptoms at call sites, so files
// that USE a matched function are more likely edit targets than files that DEFINE it.
const IMPORTER_EXPANSION = 0.4;
const IMPORT_EXPANSION = 0.2;
const COUPLING_FACTOR = 0.4;
const TEST_PROXY_FACTOR = 0.6;
const SYNONYM_DISCOUNT = 0.3;
const DEFAULT_MAX_TARGETS = 5;
const MIN_COUPLING_CONFIDENCE = 0.5;
// Minimum average document length for symbol/import fields. Prevents near-zero avgdl
// when most files have few symbols, which would over-penalize files with moderate
// symbol count via the BM25 length normalization term.
const MIN_AVGDL = 5;

/**
 * Split camelCase/PascalCase on lowercase-uppercase and UPPERCASE-Uppercase boundaries.
 * "AbstractSqlite" -> ["Abstract", "Sqlite"], "SQLiteDB" -> ["SQLite", "DB"],
 * "HTTPSServer" -> ["HTTPS", "Server"], "JSONValue" -> ["JSON", "Value"].
 */
function splitCamelCase(s: string): string[] {
  return s
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(" ")
    .filter(Boolean);
}

/**
 * Tokenize an identifier into lowercase terms, splitting on non-alphanumeric
 * characters and camelCase/PascalCase boundaries.
 * "AbstractSqliteQueryRunner" → ["abstract", "sqlite", "query", "runner"]
 *
 * Compound preservation: when camelCase splitting removes signal via stop words
 * (e.g. "useContext" → "use" stopped, only "context" survives), the joined
 * compound "usecontext" is emitted as an additional high-IDF token. This lets
 * queries like "useContext" match files that export that exact symbol.
 */
function tokenizeIdentifier(id: string): string[] {
  const result: string[] = [];
  for (const part of id.split(/[^a-zA-Z0-9]+/)) {
    const camelParts = splitCamelCase(part);
    const lowered = camelParts.map((t) => t.toLowerCase());
    const validParts = lowered.filter((t) => t.length >= 2);
    const filtered = validParts.filter((t) => !STOP_WORDS.has(t));
    result.push(...filtered);

    // Preserve compound when stop words remove part of a camelCase term.
    // "useContext" → "use" stopped → emit "usecontext" alongside "context".
    // Requires >= 4 chars to avoid trivial compounds.
    if (camelParts.length > 1 && filtered.length < validParts.length) {
      const compound = part.toLowerCase();
      if (compound.length >= 4 && !STOP_WORDS.has(compound)) {
        result.push(compound);
      }
    }
  }
  return result;
}

/**
 * Tokenize a query into keywords suitable for BM25 matching.
 * Applies camelCase-aware splitting and strips stop words.
 */
export function tokenizeQuery(query: string): string[] {
  return [...new Set(tokenizeIdentifier(query))];
}

// IMPORT_WEIGHT < SYMBOL_WEIGHT: import paths/names are indirect signal (what this
// file consumes, not what it defines). Helps zero-overlap cases where a file's
// own path/symbols don't match the query but its imports reveal domain membership.
const IMPORT_WEIGHT = 0.5;
// Ceiling for import-only scores: best import-only file gets at most this fraction
// of the lowest path/symbol score. Fixes the score cliff where inflated import-only
// BM25F scores could exceed weak path/symbol matches. BM25F relative ordering among
// import-only files is preserved (uniform scaling), so IDF discrimination still works.
const IMPORT_CEILING = 0.5;

type FieldData = { tokens: string[]; termFreq: Map<string, number> };
type FileDoc = {
  path: FieldData;
  symbols: FieldData;
  imports: FieldData;
  allTerms: Set<string>; // union of all fields; prevents double-counting in df
};

/**
 * Score a single document against query terms using true BM25F (Robertson et al. 2004).
 *
 * Combines weighted pseudo-term-frequencies across three fields (path, symbols, imports)
 * before applying saturation, rather than applying BM25 saturation independently per field.
 * This avoids double saturation credit when a term appears in multiple fields.
 */
/**
 * @param includeImports When true, includes the imports field in scoring.
 *   Enabled by default so imports always contribute. IMPORT_CEILING prevents
 *   import-only files from outranking direct path/symbol matches.
 */
function scoreBM25F(
  doc: FileDoc,
  queryTerms: string[],
  df: Map<string, number>,
  N: number,
  avgdlPath: number,
  avgdlSymbols: number,
  avgdlImports: number,
  includeImports = true,
): number {
  let score = 0;
  for (const term of queryTerms) {
    const docFreq = df.get(term) ?? 1;
    const idf = Math.log((N - docFreq + 0.5) / (docFreq + 0.5) + 1);

    const tfPath = doc.path.termFreq.get(term) ?? 0;
    const tfSymbol = doc.symbols.termFreq.get(term) ?? 0;

    // True BM25F: compute weighted pseudo-tf across fields, then apply saturation once
    let pseudoTf = 0;
    if (tfPath > 0) {
      pseudoTf +=
        (PATH_WEIGHT * tfPath) / (1 - BM25_B_PATH + BM25_B_PATH * (doc.path.tokens.length / avgdlPath));
    }
    if (tfSymbol > 0) {
      pseudoTf +=
        (SYMBOL_WEIGHT * tfSymbol) / (1 - BM25_B_SYMBOLS + BM25_B_SYMBOLS * (doc.symbols.tokens.length / avgdlSymbols));
    }
    if (includeImports) {
      const tfImport = doc.imports.termFreq.get(term) ?? 0;
      if (tfImport > 0) {
        pseudoTf +=
          (IMPORT_WEIGHT * tfImport) / (1 - BM25_B_IMPORTS + BM25_B_IMPORTS * (doc.imports.tokens.length / avgdlImports));
      }
    }

    if (pseudoTf > 0) {
      score += idf * ((pseudoTf * (BM25_K1 + 1)) / (pseudoTf + BM25_K1));
    }
  }
  return score;
}

/** Corpus statistics needed for BM25F scoring. */
type CorpusStats = {
  docs: Map<string, FileDoc>;
  N: number;
  avgdlPath: number;
  avgdlSymbols: number;
  avgdlImports: number;
  df: Map<string, number>;
};

/** Edge metadata extracted from the graph, indexed per file. */
type EdgeMetadata = {
  exportedNames: Map<string, string[]>;
  fileImportPaths: Map<string, string[]>;
  fileImportedNames: Map<string, string[]>;
};

/** Collect exported names and import edges per file from graph edges. */
function collectEdgeMetadata(edges: PersistedGraph["edges"]): EdgeMetadata {
  const exportedNames = new Map<string, string[]>();
  const fileImportPaths = new Map<string, string[]>();
  const fileImportedNames = new Map<string, string[]>();
  for (const edge of edges) {
    if (!exportedNames.has(edge.to)) exportedNames.set(edge.to, []);
    exportedNames.get(edge.to)?.push(...edge.importedNames);
    if (!fileImportPaths.has(edge.from)) fileImportPaths.set(edge.from, []);
    fileImportPaths.get(edge.from)?.push(edge.to);
    if (!fileImportedNames.has(edge.from)) fileImportedNames.set(edge.from, []);
    fileImportedNames.get(edge.from)?.push(...edge.importedNames);
  }
  return { exportedNames, fileImportPaths, fileImportedNames };
}

/** Build BM25F corpus: per-file documents, avgdl stats, and unified df. */
function buildCorpus(filePaths: string[], graph: PersistedGraph, meta: EdgeMetadata): CorpusStats {
  const docs = new Map<string, FileDoc>(
    filePaths.map((fp) => {
      const allSymbols = [...new Set([...(meta.exportedNames.get(fp) ?? []), ...(graph.files[fp]?.symbolNames ?? [])])];
      return [
        fp,
        buildDocument(fp, allSymbols, meta.fileImportPaths.get(fp) ?? [], meta.fileImportedNames.get(fp) ?? []),
      ];
    }),
  );

  const N = docs.size;
  const docValues = [...docs.values()];
  const avgdlPath = Math.max(1, docValues.reduce((s, d) => s + d.path.tokens.length, 0) / N);
  const symbolDocs = docValues.filter((d) => d.symbols.tokens.length > 0);
  const avgdlSymbols =
    symbolDocs.length > 0
      ? Math.max(MIN_AVGDL, symbolDocs.reduce((s, d) => s + d.symbols.tokens.length, 0) / symbolDocs.length)
      : MIN_AVGDL;
  const importDocs = docValues.filter((d) => d.imports.tokens.length > 0);
  const avgdlImports =
    importDocs.length > 0
      ? Math.max(MIN_AVGDL, importDocs.reduce((s, d) => s + d.imports.tokens.length, 0) / importDocs.length)
      : MIN_AVGDL;

  const df = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const term of doc.allTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  return { docs, N, avgdlPath, avgdlSymbols, avgdlImports, df };
}

/**
 * Scale import-only scores so the highest sits at IMPORT_CEILING * min path/symbol score.
 * Preserves BM25F relative ordering among import-only files.
 */
function applyImportCeiling(scores: Map<string, number>, importOnlyFiles: Set<string>): void {
  if (importOnlyFiles.size === 0) return;
  const pathSymbolScores: number[] = [];
  for (const [fp, s] of scores) {
    if (!importOnlyFiles.has(fp)) pathSymbolScores.push(s);
  }
  if (pathSymbolScores.length === 0) return;
  const minDirect = Math.min(...pathSymbolScores);
  let maxImport = 0;
  for (const fp of importOnlyFiles) {
    const s = scores.get(fp) ?? 0;
    if (s > maxImport) maxImport = s;
  }
  const ceiling = IMPORT_CEILING * minDirect;
  if (maxImport > ceiling) {
    const scale = ceiling / maxImport;
    for (const fp of importOnlyFiles) {
      scores.set(fp, (scores.get(fp) ?? 0) * scale);
    }
  }
}

/**
 * Score test files and transfer scores to their source files as proxy signals.
 * Test file paths encode what they test (e.g. "test/sqlite-query-runner.test.ts"),
 * so they match queries that the source file's path alone might miss.
 */
function applyTestProxy(
  scores: Map<string, number>,
  graph: PersistedGraph,
  meta: EdgeMetadata,
  corpus: CorpusStats,
  queryTerms: string[],
): void {
  const testMappingEntries = Object.entries(graph.testMapping);
  if (testMappingEntries.length === 0) return;

  const testToSource = new Map<string, string[]>();
  for (const [source, tests] of testMappingEntries) {
    for (const test of tests) {
      if (!testToSource.has(test)) testToSource.set(test, []);
      testToSource.get(test)?.push(source);
    }
  }

  const { N, avgdlPath, avgdlSymbols, avgdlImports, df } = corpus;
  for (const [testFp, sources] of testToSource) {
    if (!graph.files[testFp]) continue;
    const allSymbols = [
      ...new Set([...(meta.exportedNames.get(testFp) ?? []), ...(graph.files[testFp]?.symbolNames ?? [])]),
    ];
    const testDoc = buildDocument(
      testFp,
      allSymbols,
      meta.fileImportPaths.get(testFp) ?? [],
      meta.fileImportedNames.get(testFp) ?? [],
    );
    const testScore = scoreBM25F(testDoc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
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

/**
 * Expand scores to 1-hop import neighbors with directional asymmetry.
 * Importers (consumers) get a larger boost than imports (providers).
 * Also adds co-change coupling partners of direct matches.
 */
function expandNeighbors(scores: Map<string, number>, directMatches: Set<string>, graph: PersistedGraph): void {
  const importers = new Map<string, string[]>();
  const imports = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!importers.has(edge.to)) importers.set(edge.to, []);
    importers.get(edge.to)?.push(edge.from);
    if (!imports.has(edge.from)) imports.set(edge.from, []);
    imports.get(edge.from)?.push(edge.to);
  }
  for (const [file, score] of [...scores.entries()]) {
    if (!directMatches.has(file)) continue;
    const importerScore = score * IMPORTER_EXPANSION;
    for (const importer of importers.get(file) ?? []) {
      if (importerScore > (scores.get(importer) ?? 0)) {
        scores.set(importer, importerScore);
      }
    }
    const importScore = score * IMPORT_EXPANSION;
    for (const imp of imports.get(file) ?? []) {
      if (importScore > (scores.get(imp) ?? 0)) {
        scores.set(imp, importScore);
      }
    }
  }

  // Co-change coupling: scale factor by confidence (0.5 -> 0.2x, 0.9 -> 0.36x, 1.0 -> 0.4x).
  // Uses max-update pattern (matching import expansion above) so coupling can boost
  // files that already have a weak BM25 score rather than only adding new ones.
  for (const coupling of graph.changeCoupling) {
    if (coupling.confidence < MIN_COUPLING_CONFIDENCE) continue;
    const scaledFactor = COUPLING_FACTOR * coupling.confidence;
    if (directMatches.has(coupling.fileA) && graph.files[coupling.fileB]) {
      const couplingScore = (scores.get(coupling.fileA) ?? 1) * scaledFactor;
      if (couplingScore > (scores.get(coupling.fileB) ?? 0)) {
        scores.set(coupling.fileB, couplingScore);
      }
    }
    if (directMatches.has(coupling.fileB) && graph.files[coupling.fileA]) {
      const couplingScore = (scores.get(coupling.fileB) ?? 1) * scaledFactor;
      if (couplingScore > (scores.get(coupling.fileA) ?? 0)) {
        scores.set(coupling.fileA, couplingScore);
      }
    }
  }
}

/** Build a BM25F document from a file path, its merged symbol list and its import edges. */
function buildDocument(filePath: string, symbols: string[], importPaths: string[], importedNames: string[]): FileDoc {
  const pathTokens = filePath.split(/[/\\.]/).flatMap((seg) => tokenizeIdentifier(seg));
  const symbolTokens = symbols.flatMap((name) => tokenizeIdentifier(name));
  const importTokens = [
    ...importPaths.flatMap((p) => p.split(/[/\\.]/).flatMap((seg) => tokenizeIdentifier(seg))),
    ...importedNames.flatMap((name) => tokenizeIdentifier(name)),
  ];

  const pathTermFreq = new Map<string, number>();
  for (const t of pathTokens) pathTermFreq.set(t, (pathTermFreq.get(t) ?? 0) + 1);

  const symbolTermFreq = new Map<string, number>();
  for (const t of symbolTokens) symbolTermFreq.set(t, (symbolTermFreq.get(t) ?? 0) + 1);

  const importTermFreq = new Map<string, number>();
  for (const t of importTokens) importTermFreq.set(t, (importTermFreq.get(t) ?? 0) + 1);

  // allTerms drives df (document frequency) calculation. Import field terms are excluded
  // to prevent df inflation: when many files import from the same module, they'd all
  // increment df for that module's path tokens, deflating IDF and hurting direct matches.
  const allTerms = new Set<string>([...pathTermFreq.keys(), ...symbolTermFreq.keys()]);

  return {
    path: { tokens: pathTokens, termFreq: pathTermFreq },
    symbols: { tokens: symbolTokens, termFreq: symbolTermFreq },
    imports: { tokens: importTokens, termFreq: importTermFreq },
    allTerms,
  };
}

/**
 * Resolve likely edit targets from a task description using the persisted graph.
 *
 * Algorithm:
 * 1. Tokenize query (camelCase-aware, stop-word filtered)
 * 2. Build BM25F documents: path + symbols + imports fields (exported names, import edges)
 * 3. Score each file with BM25F (per-field avgdl normalization, unified IDF)
 * 4. Expand: add 1-hop import neighbors at EXPANSION_FACTOR of the seed's score
 * 5. Add co-change partners above confidence threshold at COUPLING_FACTOR of seed score
 * 6. Sort by score descending, return top N
 */
export function resolveEditTargets(query: string, graph: PersistedGraph, maxTargets = DEFAULT_MAX_TARGETS): string[] {
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];

  const filePaths = Object.keys(graph.files).filter((fp) => !isTestFile(fp));
  if (filePaths.length === 0) return [];

  // Stage 1: collect edge metadata and build BM25F corpus
  const meta = collectEdgeMetadata(graph.edges);
  const corpus = buildCorpus(filePaths, graph, meta);
  const { docs, N, avgdlPath, avgdlSymbols, avgdlImports, df } = corpus;

  const debugBM25 = process.env.DEBUG_BM25 === "1";
  const { expanded: synonymTerms } = expandQuerySynonyms(queryTerms);

  // Stage 2: BM25F scoring (all three fields always active; IMPORT_CEILING prevents import-dominated rankings)
  const scores = new Map<string, number>();
  const importOnlyFiles = new Set<string>();
  for (const [fp, doc] of docs) {
    let score = scoreBM25F(doc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    if (synonymTerms.length > 0) {
      score += SYNONYM_DISCOUNT * scoreBM25F(doc, synonymTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    }
    if (score > 0) {
      // Check if score comes only from imports (no path/symbol overlap)
      const hasPathSymbol =
        queryTerms.some((t) => doc.path.termFreq.has(t) || doc.symbols.termFreq.has(t)) ||
        (synonymTerms.length > 0 && synonymTerms.some((t) => doc.path.termFreq.has(t) || doc.symbols.termFreq.has(t)));
      if (!hasPathSymbol) importOnlyFiles.add(fp);
      scores.set(fp, score);
    }
  }

  // Stage 3: cap import-only scores below path/symbol matches
  applyImportCeiling(scores, importOnlyFiles);

  // Stage 4: test-file proxy transfer
  applyTestProxy(scores, graph, meta, corpus, queryTerms);

  if (scores.size === 0) return [];

  if (debugBM25) {
    for (const [fp, score] of [...scores.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)) {
      const doc = docs.get(fp);
      if (!doc) continue;
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

  // Stage 5: 1-hop neighbor expansion + co-change coupling
  const directMatches = new Set(scores.keys());
  expandNeighbors(scores, directMatches, graph);

  // Sort by score with semantic tiebreakers
  const importTargets = new Set(graph.edges.map((e) => e.to));
  const importSources = new Set(graph.edges.map((e) => e.from));

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) return scoreDiff;

      const aDir = (importSources.has(a[0]) ? 1 : 0) - (importTargets.has(a[0]) ? 1 : 0);
      const bDir = (importSources.has(b[0]) ? 1 : 0) - (importTargets.has(b[0]) ? 1 : 0);
      if (aDir !== bDir) return bDir - aDir;

      const aBetween = graph.files[a[0]]?.betweenness ?? 0;
      const bBetween = graph.files[b[0]]?.betweenness ?? 0;
      if (aBetween !== bBetween) return bBetween - aBetween;

      const aImportedBy = graph.files[a[0]]?.importedByCount ?? 0;
      const bImportedBy = graph.files[b[0]]?.importedByCount ?? 0;
      if (aImportedBy !== bImportedBy) return bImportedBy - aImportedBy;

      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxTargets)
    .map(([fp]) => fp);
}

export type TargetMatch = {
  file: string;
  rank: number;
  matchType: "direct" | "import-only" | "coupling" | "proxy" | "neighbor";
};

/**
 * Resolve edit targets with confidence metadata.
 * Returns ranked targets annotated with match type for task-context rendering.
 */
export function resolveEditTargetsWithMeta(
  query: string,
  graph: PersistedGraph,
  maxTargets = DEFAULT_MAX_TARGETS,
): TargetMatch[] {
  const queryTerms = tokenizeQuery(query);
  if (queryTerms.length === 0) return [];

  const filePaths = Object.keys(graph.files).filter((fp) => !isTestFile(fp));
  if (filePaths.length === 0) return [];

  const meta = collectEdgeMetadata(graph.edges);
  const corpus = buildCorpus(filePaths, graph, meta);
  const { docs, N, avgdlPath, avgdlSymbols, avgdlImports, df } = corpus;

  const { expanded: synonymTerms } = expandQuerySynonyms(queryTerms);

  const scores = new Map<string, number>();
  const matchTypes = new Map<string, TargetMatch["matchType"]>();
  const importOnlyFiles = new Set<string>();

  for (const [fp, doc] of docs) {
    let score = scoreBM25F(doc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    if (synonymTerms.length > 0) {
      score += SYNONYM_DISCOUNT * scoreBM25F(doc, synonymTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    }
    if (score > 0) {
      const hasPathSymbol =
        queryTerms.some((t) => doc.path.termFreq.has(t) || doc.symbols.termFreq.has(t)) ||
        (synonymTerms.length > 0 && synonymTerms.some((t) => doc.path.termFreq.has(t) || doc.symbols.termFreq.has(t)));
      if (!hasPathSymbol) {
        importOnlyFiles.add(fp);
        matchTypes.set(fp, "import-only");
      }
      scores.set(fp, score);
      if (!matchTypes.has(fp)) matchTypes.set(fp, "direct");
    }
  }

  applyImportCeiling(scores, importOnlyFiles);
  applyTestProxy(scores, graph, meta, corpus, queryTerms);

  // Mark proxy-transferred files
  for (const [fp] of scores) {
    if (!matchTypes.has(fp)) matchTypes.set(fp, "proxy");
  }

  if (scores.size === 0) return [];

  const directMatches = new Set(scores.keys());
  expandNeighbors(scores, directMatches, graph);

  // Mark expansion-added files
  for (const [fp] of scores) {
    if (!matchTypes.has(fp)) {
      // Determine if it was added by coupling or import neighbor
      const isCoupled = graph.changeCoupling.some(
        (c) =>
          c.confidence >= MIN_COUPLING_CONFIDENCE &&
          ((directMatches.has(c.fileA) && c.fileB === fp) || (directMatches.has(c.fileB) && c.fileA === fp)),
      );
      matchTypes.set(fp, isCoupled ? "coupling" : "neighbor");
    }
  }

  const importTargets = new Set(graph.edges.map((e) => e.to));
  const importSources = new Set(graph.edges.map((e) => e.from));

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) return scoreDiff;
      const aDir = (importSources.has(a[0]) ? 1 : 0) - (importTargets.has(a[0]) ? 1 : 0);
      const bDir = (importSources.has(b[0]) ? 1 : 0) - (importTargets.has(b[0]) ? 1 : 0);
      if (aDir !== bDir) return bDir - aDir;
      const aBetween = graph.files[a[0]]?.betweenness ?? 0;
      const bBetween = graph.files[b[0]]?.betweenness ?? 0;
      if (aBetween !== bBetween) return bBetween - aBetween;
      const aImportedBy = graph.files[a[0]]?.importedByCount ?? 0;
      const bImportedBy = graph.files[b[0]]?.importedByCount ?? 0;
      if (aImportedBy !== bImportedBy) return bImportedBy - aImportedBy;
      return a[0].localeCompare(b[0]);
    })
    .slice(0, maxTargets)
    .map(([fp], i) => ({
      file: fp,
      rank: i + 1,
      matchType: matchTypes.get(fp) ?? "direct",
    }));
}

/**
 * Check whether the prompt already mentions any of the resolved targets.
 * When true, the agent can self-localize and pre-flight adds no value.
 */
export function promptMentionsTargets(query: string, targets: string[]): boolean {
  return targets.some((t) => query.includes(t));
}
