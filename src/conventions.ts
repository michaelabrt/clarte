import path from "node:path";
import { readFileOr } from "./utils.js";
import type { ConfigConstraints, ImportEdge, ImportGraph, InferredConventions } from "./types.js";

// ── Naming pattern classifiers ─────────────────────────────────────────

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const UPPER_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "UPPER_SNAKE_CASE" | "mixed";

function classifyName(name: string): NamingStyle | null {
  if (UPPER_SNAKE_CASE.test(name)) return "UPPER_SNAKE_CASE";
  if (PASCAL_CASE.test(name)) return "PascalCase";
  if (SNAKE_CASE.test(name)) return "snake_case";
  if (CAMEL_CASE.test(name)) return "camelCase";
  return null;
}

function classifyFilename(name: string): string | null {
  // Strip extension
  const base = name.replace(/\.[^.]+$/, "");
  if (!base || base.length < 2) return null;
  if (KEBAB_CASE.test(base)) return "kebab-case";
  if (SNAKE_CASE.test(base)) return "snake_case";
  if (PASCAL_CASE.test(base)) return "PascalCase";
  if (CAMEL_CASE.test(base)) return "camelCase";
  return null;
}

function majorityStyle(counts: Map<string, number>): string {
  let best = "mixed";
  let bestCount = 0;
  let total = 0;
  for (const [style, count] of counts) {
    total += count;
    if (count > bestCount) {
      bestCount = count;
      best = style;
    }
  }
  // Require >60% dominance to report a convention
  if (total > 0 && bestCount / total < 0.6) return "mixed";
  return best;
}

// ── Export patterns ────────────────────────────────────────────────────

/** Regex to match export default */
const EXPORT_DEFAULT = /^export\s+default\s/m;
/** Regex to match named exports */
const NAMED_EXPORT = /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+/m;
/** Regex to detect barrel/re-export files */
const RE_EXPORT = /^export\s+(?:\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from|\*\s+from)\s+['"][^'"]+['"]/m;

// ── Exported identifier extraction ─────────────────────────────────────

/** Regexes for extracting exported identifiers by category */
const EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
const EXPORT_CONST_FN = /^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*(?:=>|:\s*\w)/gm;
const EXPORT_TYPE = /^export\s+(?:type|interface|enum)\s+(\w+)/gm;
const EXPORT_CONST = /^export\s+const\s+(\w+)\s*(?::\s*\w+\s*)?=/gm;

interface IdentifierSample {
  functions: string[];
  types: string[];
  constants: string[];
}

function extractExportedIdentifiers(content: string): IdentifierSample {
  const functions: string[] = [];
  const types: string[] = [];
  const constants: string[] = [];
  const seenFunctions = new Set<string>();

  // Extract function names
  for (const m of content.matchAll(EXPORT_FUNCTION)) {
    functions.push(m[1]);
    seenFunctions.add(m[1]);
  }
  for (const m of content.matchAll(EXPORT_CONST_FN)) {
    if (!seenFunctions.has(m[1])) {
      functions.push(m[1]);
      seenFunctions.add(m[1]);
    }
  }

  // Extract type/interface/enum names
  for (const m of content.matchAll(EXPORT_TYPE)) {
    types.push(m[1]);
  }

  // Extract const names (excluding those already captured as functions)
  for (const m of content.matchAll(EXPORT_CONST)) {
    if (!seenFunctions.has(m[1])) {
      constants.push(m[1]);
    }
  }

  return { functions, types, constants };
}

// ── Import ordering detection ──────────────────────────────────────────

type ImportGroupKind = "external" | "internal" | "relative";

interface ImportLine {
  kind: ImportGroupKind;
  blankBefore: boolean;
}

function classifyImportKind(specifier: string): ImportGroupKind {
  if (specifier.startsWith("./") || specifier.startsWith("../")) return "relative";
  if (specifier.startsWith("node:")) return "external";
  if (specifier.startsWith("@/") || specifier.startsWith("~/")) return "internal";
  // Bare specifiers without dots are external packages
  if (!specifier.startsWith(".")) return "external";
  return "relative";
}

function detectImportOrdering(content: string): string | null {
  const lines = content.split("\n");
  const importLines: ImportLine[] = [];
  let lastWasBlank = false;
  let lastWasImport = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "") {
      if (lastWasImport) lastWasBlank = true;
      continue;
    }

    const importMatch = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/);
    const importSideEffect = trimmed.match(/^import\s+['"]([^'"]+)['"]/);
    const specifier = importMatch?.[1] ?? importSideEffect?.[1];

    if (specifier) {
      importLines.push({
        kind: classifyImportKind(specifier),
        blankBefore: lastWasBlank && lastWasImport,
      });
      lastWasBlank = false;
      lastWasImport = true;
    } else if (lastWasImport && !trimmed.startsWith("import")) {
      // Past the import block
      break;
    }
  }

  if (importLines.length < 3) return null;

  // Check if external imports come before internal/relative
  const firstExternal = importLines.findIndex((l) => l.kind === "external");
  const firstRelative = importLines.findIndex((l) => l.kind === "relative");

  const externalFirst = firstExternal !== -1 && (firstRelative === -1 || firstExternal < firstRelative);

  // Check for blank-line separation between groups
  const hasBlankSep = importLines.some((l) => l.blankBefore);

  if (externalFirst && hasBlankSep) {
    return "external-first, blank-line separated";
  }
  if (externalFirst) {
    return "external-first";
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────

/**
 * Infer coding conventions by sampling source files from the import graph.
 * Skips conventions already enforced by config constraints.
 */
export async function inferConventions(
  rootDir: string,
  graph: ImportGraph,
  configConstraints?: ConfigConstraints,
): Promise<InferredConventions | null> {
  // Collect all internal files from the graph
  const internalFiles = new Set<string>();
  for (const [file] of graph.inDegree) {
    internalFiles.add(file);
  }

  if (internalFiles.size === 0) return null;

  // Sample up to 50 files for identifier analysis, preferring high-centrality files
  const sortedFiles = [...internalFiles]
    .filter((f) => !isTestFile(f) && !isConfigFile(f))
    .sort((a, b) => (graph.centrality.get(b) ?? 0) - (graph.centrality.get(a) ?? 0))
    .slice(0, 50);

  if (sortedFiles.length === 0) return null;

  // Collect identifiers from sampled files
  const allFunctions: string[] = [];
  const allTypes: string[] = [];
  const allConstants: string[] = [];
  let defaultExportCount = 0;
  let namedExportCount = 0;
  let barrelFileCount = 0;

  // Import ordering: sample up to 20 files
  const importOrderingSamples: string[] = [];

  for (const file of sortedFiles) {
    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const identifiers = extractExportedIdentifiers(content);
    allFunctions.push(...identifiers.functions);
    allTypes.push(...identifiers.types);
    allConstants.push(...identifiers.constants);

    // Count export styles
    if (EXPORT_DEFAULT.test(content)) defaultExportCount++;
    if (NAMED_EXPORT.test(content)) namedExportCount++;

    // Count barrel files (>50% of non-empty lines are re-exports)
    if (isBarrelFile(content)) barrelFileCount++;

    // Collect import ordering samples
    if (importOrderingSamples.length < 20) {
      importOrderingSamples.push(content);
    }
  }

  const totalIdentifiers = allFunctions.length + allTypes.length + allConstants.length;
  if (totalIdentifiers === 0) return null;

  // Classify naming patterns
  const functionCounts = new Map<string, number>();
  for (const name of allFunctions) {
    const style = classifyName(name);
    if (style) functionCounts.set(style, (functionCounts.get(style) ?? 0) + 1);
  }

  const typeCounts = new Map<string, number>();
  for (const name of allTypes) {
    const style = classifyName(name);
    if (style) typeCounts.set(style, (typeCounts.get(style) ?? 0) + 1);
  }

  const constantCounts = new Map<string, number>();
  for (const name of allConstants) {
    const style = classifyName(name);
    if (style) constantCounts.set(style, (constantCounts.get(style) ?? 0) + 1);
  }

  // File naming: extract basenames from all internal files
  const fileCounts = new Map<string, number>();
  for (const file of internalFiles) {
    if (isTestFile(file) || isConfigFile(file)) continue;
    const basename = path.basename(file);
    const style = classifyFilename(basename);
    if (style) fileCounts.set(style, (fileCounts.get(style) ?? 0) + 1);
  }

  // Export style
  const totalExportFiles = defaultExportCount + namedExportCount;
  const defaultPercent = totalExportFiles > 0
    ? Math.round((defaultExportCount / totalExportFiles) * 100)
    : 0;

  // Import ordering (majority vote across sampled files)
  const orderingCounts = new Map<string, number>();
  for (const content of importOrderingSamples) {
    const ordering = detectImportOrdering(content);
    if (ordering) {
      orderingCounts.set(ordering, (orderingCounts.get(ordering) ?? 0) + 1);
    }
  }
  const importOrdering = orderingCounts.size > 0
    ? majorityStyle(orderingCounts)
    : undefined;

  const conventions: InferredConventions = {
    naming: {
      functions: majorityStyle(functionCounts),
      types: majorityStyle(typeCounts),
      constants: majorityStyle(constantCounts),
      files: majorityStyle(fileCounts),
    },
    exportStyle: {
      preferNamed: defaultPercent < 50,
      defaultExportPercent: defaultPercent,
      barrelFileCount,
    },
    importOrdering: importOrdering === "mixed" ? undefined : importOrdering,
  };

  // Filter out conventions already covered by config constraints
  return filterCoveredConventions(conventions, configConstraints);
}

// ── Rendering ─────────────────────────────────────────────────────────

/**
 * Render inferred conventions as a markdown section with directives.
 */
export function renderConventionsSection(conventions: InferredConventions): string | null {
  const lines: string[] = [];

  // Naming conventions
  const namingParts: string[] = [];
  if (conventions.naming.functions !== "mixed") {
    namingParts.push(`${conventions.naming.functions} for functions`);
  }
  if (conventions.naming.types !== "mixed") {
    namingParts.push(`${conventions.naming.types} for types`);
  }
  if (conventions.naming.constants !== "mixed") {
    namingParts.push(`${conventions.naming.constants} for constants`);
  }
  if (conventions.naming.files !== "mixed") {
    namingParts.push(`${conventions.naming.files} for files`);
  }

  if (namingParts.length > 0) {
    lines.push(`- **Prefer**: ${namingParts.join(", ")}`);
  }

  // Export style
  if (conventions.exportStyle.defaultExportPercent <= 10) {
    lines.push("- **Prefer**: Named exports (no default exports)");
  } else if (conventions.exportStyle.preferNamed) {
    lines.push(`- **Prefer**: Named exports (${100 - conventions.exportStyle.defaultExportPercent}% named, ${conventions.exportStyle.defaultExportPercent}% default)`);
  }
  if (conventions.exportStyle.barrelFileCount > 0) {
    lines.push(`- **Style**: Uses barrel files (${conventions.exportStyle.barrelFileCount} index re-export files)`);
  }

  // Import ordering
  if (conventions.importOrdering) {
    lines.push(`- **Style**: Import ordering: ${conventions.importOrdering}`);
  }

  if (lines.length === 0) return null;

  return "## Inferred Conventions\n\n" + lines.join("\n");
}

// ── Helpers ───────────────────────────────────────────────────────────

function isTestFile(filePath: string): boolean {
  return /\.(test|spec)\.[jt]sx?$/.test(filePath) || filePath.includes("__tests__/");
}

function isConfigFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return /\.(config|rc)\.[jt]sx?$/.test(basename)
    || basename.startsWith(".")
    || basename === "jest.setup.ts"
    || basename === "vitest.config.ts";
}

function isBarrelFile(content: string): boolean {
  const lines = content.split("\n").filter((l) => l.trim() !== "" && !l.trim().startsWith("//"));
  if (lines.length === 0) return false;
  let reExportCount = 0;
  for (const line of lines) {
    if (RE_EXPORT.test(line)) reExportCount++;
  }
  return reExportCount > 0 && reExportCount / lines.length > 0.5;
}

/**
 * Remove conventions that are already enforced by config constraints.
 * For example, if ESLint enforces naming conventions, skip the naming section.
 * If a linter enforces import ordering, skip that.
 */
function filterCoveredConventions(
  conventions: InferredConventions,
  configConstraints?: ConfigConstraints,
): InferredConventions | null {
  if (!configConstraints) return conventions;

  const result = { ...conventions };

  // If linter enforces naming conventions, clear naming
  const hasNamingRule = configConstraints.linter?.keyRules.some(
    (r) => r.rule.includes("naming-convention"),
  );
  if (hasNamingRule) {
    result.naming = { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" };
  }

  // If linter enforces import ordering, clear import ordering
  const hasImportOrder = configConstraints.linter?.keyRules.some(
    (r) => r.rule.includes("import/order") || r.rule.includes("useSortedImports"),
  );
  if (hasImportOrder) {
    result.importOrdering = undefined;
  }

  // If linter enforces type-only imports, skip that aspect
  const hasTypeImport = configConstraints.linter?.keyRules.some(
    (r) => r.rule.includes("consistent-type-imports") || r.rule.includes("useImportType"),
  );
  // (No specific convention to clear for this, but noted for future)
  void hasTypeImport;

  // Check if anything meaningful remains
  const hasNaming = Object.values(result.naming).some((v) => v !== "mixed");
  const hasExport = result.exportStyle.defaultExportPercent < 90;
  const hasImport = !!result.importOrdering;

  if (!hasNaming && !hasExport && !hasImport) return null;

  return result;
}
