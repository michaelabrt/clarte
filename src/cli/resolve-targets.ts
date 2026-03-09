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

/**
 * Programming synonym groups. Each array is a bidirectional synonym cluster.
 * When a query contains any term in a group, all other terms in that group
 * are added as expansion terms with reduced weight (via IDF dilution).
 */
const SYNONYM_GROUPS: string[][] = [
  ["auth", "authentication", "authorize", "authorization"],
  ["jwt", "jsonwebtoken", "token"],
  ["session", "cookie", "credential"],
  ["db", "database", "datastore"],
  ["sql", "sqlite", "postgres", "mysql", "mariadb"],
  ["orm", "repository", "entity", "migration"],
  ["api", "endpoint", "route", "handler"],
  ["http", "request", "response", "fetch"],
  ["ws", "websocket", "socket"],
  ["msg", "message", "event", "signal"],
  ["err", "error", "exception", "fault"],
  ["log", "logger", "logging"],
  ["cache", "memoize", "memo"],
  ["queue", "worker", "job"],
  ["pub", "publish", "subscribe", "subscriber"],
  ["env", "environment", "dotenv"],
  ["cfg", "config", "configuration", "settings"],
  ["cmd", "command", "cli"],
  ["fs", "filesystem", "directory"],
  ["fmt", "format", "formatter", "prettier", "biome"],
  ["lint", "linter", "eslint"],
  ["pkg", "package", "module", "bundle"],
  ["dep", "dependency", "dependencies"],
  ["tpl", "template", "render", "renderer"],
  ["jsx", "tsx", "component", "react"],
  ["css", "style", "stylesheet", "tailwind"],
  ["nav", "navigation", "router", "routing"],
  ["i18n", "locale", "translation", "intl"],
  ["tz", "timezone", "datetime"],
  ["url", "uri", "href", "link"],
  ["regex", "regexp", "pattern"],
  ["json", "serialize", "deserialize", "marshal"],
  ["schema", "validate", "validator", "validation"],
  ["middleware", "interceptor", "guard", "filter"],
  ["mock", "stub", "fake", "spy"],
  ["async", "promise", "await", "concurrent"],
  ["stream", "pipe", "transform", "readable", "writable"],
  ["crypto", "encrypt", "decrypt", "hash", "hmac"],
  ["cert", "certificate", "tls", "ssl"],
  ["verify", "verification"],
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
// b=0.4: lowered from TREC default (0.75) for short documents. File paths are
// 3-5 tokens and symbol lists 5-50 tokens; b=0.75 over-penalizes naturally short
// docs. Literature (Clinchant & Gaussier 2010) recommends b=0.3-0.5 for this range.
const BM25_B = 0.4;
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
 *   Used as a fallback for files with zero path/symbol overlap (audit 3.2, 3.3).
 *   Disabled by default to prevent import-field boost from outranking direct matches.
 */
function scoreBM25F(
  doc: FileDoc,
  queryTerms: string[],
  df: Map<string, number>,
  N: number,
  avgdlPath: number,
  avgdlSymbols: number,
  avgdlImports: number,
  includeImports = false,
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
      pseudoTf += (PATH_WEIGHT * tfPath) / (1 - BM25_B + BM25_B * (doc.path.tokens.length / avgdlPath));
    }
    if (tfSymbol > 0) {
      pseudoTf += (SYMBOL_WEIGHT * tfSymbol) / (1 - BM25_B + BM25_B * (doc.symbols.tokens.length / avgdlSymbols));
    }
    if (includeImports) {
      const tfImport = doc.imports.termFreq.get(term) ?? 0;
      if (tfImport > 0) {
        pseudoTf += (IMPORT_WEIGHT * tfImport) / (1 - BM25_B + BM25_B * (doc.imports.tokens.length / avgdlImports));
      }
    }

    if (pseudoTf > 0) {
      score += idf * ((pseudoTf * (BM25_K1 + 1)) / (pseudoTf + BM25_K1));
    }
  }
  return score;
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

  const filePaths = Object.keys(graph.files).filter((fp) => !TEST_FILE_RE.test(fp));
  if (filePaths.length === 0) return [];

  // Collect exported symbol names per file: symbols other files import from it
  const exportedNames = new Map<string, string[]>();
  // Collect import edges per file: what each file imports (paths + names)
  const fileImportPaths = new Map<string, string[]>();
  const fileImportedNames = new Map<string, string[]>();
  for (const edge of graph.edges) {
    if (!exportedNames.has(edge.to)) exportedNames.set(edge.to, []);
    exportedNames.get(edge.to)?.push(...edge.importedNames);
    if (!fileImportPaths.has(edge.from)) fileImportPaths.set(edge.from, []);
    fileImportPaths.get(edge.from)?.push(edge.to);
    if (!fileImportedNames.has(edge.from)) fileImportedNames.set(edge.from, []);
    fileImportedNames.get(edge.from)?.push(...edge.importedNames);
  }

  // Build BM25F documents (dedup exported + defined symbols to avoid double-counting)
  const docs = new Map<string, FileDoc>(
    filePaths.map((fp) => {
      const allSymbols = [...new Set([...(exportedNames.get(fp) ?? []), ...(graph.files[fp]?.symbolNames ?? [])])];
      return [fp, buildDocument(fp, allSymbols, fileImportPaths.get(fp) ?? [], fileImportedNames.get(fp) ?? [])];
    }),
  );

  // Per-field avgdl for BM25F normalization
  const N = docs.size;
  const docValues = [...docs.values()];
  const avgdlPath = Math.max(1, docValues.reduce((s, d) => s + d.path.tokens.length, 0) / N);
  // Exclude zero-token docs (config files, .d.ts) to avoid deflating the average.
  // Floor at 5 (typical minimum for a non-trivial source file).
  const symbolDocs = docValues.filter((d) => d.symbols.tokens.length > 0);
  const avgdlSymbols =
    symbolDocs.length > 0
      ? Math.max(5, symbolDocs.reduce((s, d) => s + d.symbols.tokens.length, 0) / symbolDocs.length)
      : 5;
  const importDocs = docValues.filter((d) => d.imports.tokens.length > 0);
  const avgdlImports =
    importDocs.length > 0
      ? Math.max(5, importDocs.reduce((s, d) => s + d.imports.tokens.length, 0) / importDocs.length)
      : 5;

  // df increments once per document regardless of which field(s) the term appears in.
  const df = new Map<string, number>();
  for (const doc of docs.values()) {
    for (const term of doc.allTerms) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  const debugBM25 = process.env.DEBUG_BM25 === "1";

  // Synonym expansion: expand query with programming synonyms, scored at reduced weight
  const { expanded: synonymTerms } = expandQuerySynonyms(queryTerms);

  // BM25F scoring: path + symbols first, import field as fallback for zero-overlap files.
  // The import field only fires when path/symbols produce zero score, preventing
  // import-boosted files from outranking direct matches (Hono JSX context regression).
  const scores = new Map<string, number>();
  const importOnlyFiles = new Set<string>();
  for (const [fp, doc] of docs) {
    let score = scoreBM25F(doc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    if (synonymTerms.length > 0) {
      score += SYNONYM_DISCOUNT * scoreBM25F(doc, synonymTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
    }
    // Fallback: import field for files with zero path/symbol overlap (audit 3.2, 3.3)
    if (score === 0) {
      score = scoreBM25F(doc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports, true);
      if (synonymTerms.length > 0) {
        score += SYNONYM_DISCOUNT * scoreBM25F(doc, synonymTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports, true);
      }
      if (score > 0) importOnlyFiles.add(fp);
    }
    if (score > 0) scores.set(fp, score);
  }

  // Ceiling: scale import-only scores so the highest sits at IMPORT_CEILING * min
  // path/symbol score. Preserves BM25F relative ordering (IDF discrimination) among
  // import-only files while guaranteeing they rank below every path/symbol match.
  if (importOnlyFiles.size > 0) {
    const pathSymbolScores: number[] = [];
    for (const [fp, s] of scores) {
      if (!importOnlyFiles.has(fp)) pathSymbolScores.push(s);
    }
    if (pathSymbolScores.length > 0) {
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
      const testDoc = buildDocument(
        testFp,
        allSymbols,
        fileImportPaths.get(testFp) ?? [],
        fileImportedNames.get(testFp) ?? [],
      );
      let testScore = scoreBM25F(testDoc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports);
      if (testScore === 0)
        testScore = scoreBM25F(testDoc, queryTerms, df, N, avgdlPath, avgdlSymbols, avgdlImports, true);
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

  const directMatches = new Set(scores.keys());

  // Import graph expansion: 1-hop neighbors with directional asymmetry.
  // Importers (consumers) get a larger boost than imports (providers) because
  // bug reports describe symptoms at call sites.
  const importers = new Map<string, string[]>(); // file -> files that import it
  const imports = new Map<string, string[]>(); // file -> files it imports from
  for (const edge of graph.edges) {
    if (!importers.has(edge.to)) importers.set(edge.to, []);
    importers.get(edge.to)?.push(edge.from);
    if (!imports.has(edge.from)) imports.set(edge.from, []);
    imports.get(edge.from)?.push(edge.to);
  }
  for (const [file, score] of [...scores.entries()]) {
    if (!directMatches.has(file)) continue;
    // Files that import this match (consumers) get higher boost
    const importerScore = score * IMPORTER_EXPANSION;
    for (const importer of importers.get(file) ?? []) {
      if (importerScore > (scores.get(importer) ?? 0)) {
        scores.set(importer, importerScore);
      }
    }
    // Files this match imports from (providers) get lower boost
    const importScore = score * IMPORT_EXPANSION;
    for (const imp of imports.get(file) ?? []) {
      if (importScore > (scores.get(imp) ?? 0)) {
        scores.set(imp, importScore);
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

  // Semantic tiebreaker for files with identical BM25 scores.
  // When scores are tied: (1) prefer consumer over provider (import direction),
  // (2) prefer higher betweenness centrality, (3) path for determinism.
  // This disambiguates e.g. middleware/jwt/jwt.ts vs utils/jwt/jwt.ts.
  const importTargets = new Set(graph.edges.map((e) => e.to));
  const importSources = new Set(graph.edges.map((e) => e.from));

  return [...scores.entries()]
    .sort((a, b) => {
      const scoreDiff = b[1] - a[1];
      if (scoreDiff !== 0) return scoreDiff;

      // Tiebreaker 1: prefer consumers over providers among tied files.
      // A pure consumer (imports but is never imported) is most likely the bug site.
      // A file that both imports and is imported ranks between pure consumer and pure provider.
      // Score: +1 for being a consumer (imports from others), -1 for being a provider (imported by others).
      const aDir = (importSources.has(a[0]) ? 1 : 0) - (importTargets.has(a[0]) ? 1 : 0);
      const bDir = (importSources.has(b[0]) ? 1 : 0) - (importTargets.has(b[0]) ? 1 : 0);
      if (aDir !== bDir) return bDir - aDir;

      // Tiebreaker 2: prefer higher betweenness (more central in dependency paths)
      const aBetween = graph.files[a[0]]?.betweenness ?? 0;
      const bBetween = graph.files[b[0]]?.betweenness ?? 0;
      if (aBetween !== bBetween) return bBetween - aBetween;

      // Tiebreaker 3: prefer files imported by more other files
      const aImportedBy = graph.files[a[0]]?.importedByCount ?? 0;
      const bImportedBy = graph.files[b[0]]?.importedByCount ?? 0;
      if (aImportedBy !== bImportedBy) return bImportedBy - aImportedBy;

      return a[0].localeCompare(b[0]);
    })
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
