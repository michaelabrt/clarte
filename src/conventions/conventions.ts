import path from "node:path";
import { isTestFile, readFileOr } from "../utils.js";
import type { ConfigConstraints, ImportGraph, InferredConventions } from "../types.js";
import { detectImportOrderingDetailed } from "./imports.js";
import { MAJORITY_THRESHOLD, STRONG_MAJORITY_THRESHOLD } from "../config/thresholds.js";

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
  const base = name.replace(/\.[^.]+$/, "");
  if (!base || base.length < 2) return null;
  if (KEBAB_CASE.test(base)) return "kebab-case";
  if (SNAKE_CASE.test(base)) return "snake_case";
  if (PASCAL_CASE.test(base)) return "PascalCase";
  if (CAMEL_CASE.test(base)) return "camelCase";
  return null;
}

function majorityStyle(counts: Map<string, number>, threshold = MAJORITY_THRESHOLD): string {
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
  // Require threshold dominance to report a convention
  if (total > 0 && bestCount / total < threshold) return "mixed";
  return best;
}

const EXPORT_DEFAULT = /^export\s+default\s/m;
const NAMED_EXPORT = /^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+/m;
const RE_EXPORT = /^export\s+(?:\{[^}]*\}\s+from|type\s+\{[^}]*\}\s+from|\*\s+from)\s+['"][^'"]+['"]/m;

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

  for (const m of content.matchAll(EXPORT_TYPE)) {
    types.push(m[1]);
  }

  for (const m of content.matchAll(EXPORT_CONST)) {
    if (!seenFunctions.has(m[1])) {
      constants.push(m[1]);
    }
  }

  return { functions, types, constants };
}

interface PrefixPattern {
  prefix: string;
  label: string;
  regex: RegExp;
}

const PREFIX_PATTERNS: PrefixPattern[] = [
  { prefix: "use", label: "hooks", regex: /^use[A-Z]/ },
  { prefix: "is", label: "boolean predicates", regex: /^is[A-Z]/ },
  { prefix: "has", label: "boolean predicates", regex: /^has[A-Z]/ },
  { prefix: "get", label: "accessors", regex: /^get[A-Z]/ },
  { prefix: "set", label: "accessors", regex: /^set[A-Z]/ },
  { prefix: "handle", label: "event handlers", regex: /^handle[A-Z]/ },
  { prefix: "on", label: "callbacks", regex: /^on[A-Z]/ },
  { prefix: "create", label: "factory functions", regex: /^create[A-Z]/ },
  { prefix: "make", label: "factory functions", regex: /^make[A-Z]/ },
];

function detectNamingPrefixes(functions: string[]): InferredConventions["namingPrefixes"] {
  if (functions.length === 0) return undefined;

  const results: Array<{ prefix: string; count: number; example: string }> = [];

  for (const pattern of PREFIX_PATTERNS) {
    const matches = functions.filter((f) => pattern.regex.test(f));
    if (matches.length >= 3) {
      results.push({
        prefix: pattern.prefix,
        count: matches.length,
        example: matches[0],
      });
    }
  }

  if (results.length === 0) return undefined;

  // Sort by count descending, alphabetical tiebreaker for determinism
  results.sort((a, b) => b.count - a.count || a.prefix.localeCompare(b.prefix));
  return results;
}

interface DirectoryIdentifiers {
  functions: string[];
  types: string[];
  constants: string[];
  files: string[];
}

/**
 * Get the top-level directory for a file path (up to 2 directory segments).
 * e.g., "src/components/Button.tsx" -> "src/components"
 *       "src/theme.ts" -> "src"
 */
function getTopLevelDir(filePath: string): string {
  const parts = filePath.split("/");
  const dirParts = parts.slice(0, -1);
  if (dirParts.length === 0) return ".";
  return dirParts.slice(0, 2).join("/");
}

function detectDirectoryOverrides(
  fileIdentifiers: Map<string, IdentifierSample>,
  fileNames: Map<string, string[]>,
  globalNaming: InferredConventions["naming"],
): InferredConventions["directoryOverrides"] {
  const dirIdentifiers = new Map<string, DirectoryIdentifiers>();

  for (const [file, sample] of fileIdentifiers) {
    const dir = getTopLevelDir(file);
    if (!dirIdentifiers.has(dir)) {
      dirIdentifiers.set(dir, { functions: [], types: [], constants: [], files: [] });
    }
    const d = dirIdentifiers.get(dir)!;
    d.functions.push(...sample.functions);
    d.types.push(...sample.types);
    d.constants.push(...sample.constants);
  }

  for (const [file, names] of fileNames) {
    const dir = getTopLevelDir(file);
    if (!dirIdentifiers.has(dir)) {
      dirIdentifiers.set(dir, { functions: [], types: [], constants: [], files: [] });
    }
    dirIdentifiers.get(dir)?.files.push(...names);
  }

  const overrides: Array<{
    directory: string;
    naming: { functions?: string; types?: string; constants?: string; files?: string };
  }> = [];

  for (const [dir, ids] of dirIdentifiers) {
    // Require 5+ files' worth of identifiers to be meaningful
    const totalSamples = ids.functions.length + ids.types.length + ids.constants.length + ids.files.length;
    if (totalSamples < 5) continue;

    const naming: { functions?: string; types?: string; constants?: string; files?: string } = {};
    let hasOverride = false;

    // Check each naming category at >80% threshold
    if (ids.functions.length >= 3) {
      const counts = new Map<string, number>();
      for (const name of ids.functions) {
        const style = classifyName(name);
        if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
      }
      const dirStyle = majorityStyle(counts, STRONG_MAJORITY_THRESHOLD);
      if (dirStyle !== "mixed" && dirStyle !== globalNaming.functions) {
        naming.functions = dirStyle;
        hasOverride = true;
      }
    }

    if (ids.types.length >= 3) {
      const counts = new Map<string, number>();
      for (const name of ids.types) {
        const style = classifyName(name);
        if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
      }
      const dirStyle = majorityStyle(counts, STRONG_MAJORITY_THRESHOLD);
      if (dirStyle !== "mixed" && dirStyle !== globalNaming.types) {
        naming.types = dirStyle;
        hasOverride = true;
      }
    }

    if (ids.constants.length >= 3) {
      const counts = new Map<string, number>();
      for (const name of ids.constants) {
        const style = classifyName(name);
        if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
      }
      const dirStyle = majorityStyle(counts, STRONG_MAJORITY_THRESHOLD);
      if (dirStyle !== "mixed" && dirStyle !== globalNaming.constants) {
        naming.constants = dirStyle;
        hasOverride = true;
      }
    }

    if (ids.files.length >= 3) {
      const counts = new Map<string, number>();
      for (const name of ids.files) {
        const style = classifyFilename(name);
        if (style) counts.set(style, (counts.get(style) ?? 0) + 1);
      }
      const dirStyle = majorityStyle(counts, STRONG_MAJORITY_THRESHOLD);
      if (dirStyle !== "mixed" && dirStyle !== globalNaming.files) {
        naming.files = dirStyle;
        hasOverride = true;
      }
    }

    if (hasOverride) {
      overrides.push({ directory: dir, naming });
    }
  }

  return overrides.length > 0 ? overrides : undefined;
}

/**
 * Infer coding conventions by sampling source files from the import graph.
 * Skips conventions already enforced by config constraints.
 */
export async function inferConventions(
  rootDir: string,
  graph: ImportGraph,
  configConstraints?: ConfigConstraints,
): Promise<InferredConventions | null> {
  const internalFiles = new Set<string>();
  for (const [file] of graph.inDegree) {
    internalFiles.add(file);
  }

  if (internalFiles.size === 0) return null;

  const sortedFiles = [...internalFiles]
    .filter((f) => !isTestFile(f) && !isConfigFile(f))
    .sort((a, b) => (graph.centrality.get(b) ?? 0) - (graph.centrality.get(a) ?? 0) || a.localeCompare(b))
    .slice(0, 50);

  if (sortedFiles.length === 0) return null;

  const allFunctions: string[] = [];
  const allTypes: string[] = [];
  const allConstants: string[] = [];
  let defaultExportCount = 0;
  let namedExportCount = 0;
  let barrelFileCount = 0;

  const importOrderingSamples: string[] = [];

  const fileIdentifiers = new Map<string, IdentifierSample>();

  for (const file of sortedFiles) {
    const absPath = path.join(rootDir, file);
    const content = await readFileOr(absPath);
    if (!content) continue;

    const identifiers = extractExportedIdentifiers(content);
    allFunctions.push(...identifiers.functions);
    allTypes.push(...identifiers.types);
    allConstants.push(...identifiers.constants);

    fileIdentifiers.set(file, identifiers);

    if (EXPORT_DEFAULT.test(content)) defaultExportCount++;
    if (NAMED_EXPORT.test(content)) namedExportCount++;

    if (isBarrelFile(content)) barrelFileCount++;

    if (importOrderingSamples.length < 20) {
      importOrderingSamples.push(content);
    }
  }

  const totalIdentifiers = allFunctions.length + allTypes.length + allConstants.length;
  if (totalIdentifiers === 0) return null;

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

  const fileCounts = new Map<string, number>();
  const fileNamesByFile = new Map<string, string[]>();
  for (const file of internalFiles) {
    if (isTestFile(file) || isConfigFile(file)) continue;
    const basename = path.basename(file);
    const style = classifyFilename(basename);
    if (style) {
      fileCounts.set(style, (fileCounts.get(style) ?? 0) + 1);
      if (!fileNamesByFile.has(file)) fileNamesByFile.set(file, []);
      fileNamesByFile.get(file)?.push(basename);
    }
  }

  const totalExportFiles = defaultExportCount + namedExportCount;
  const defaultPercent = totalExportFiles > 0 ? Math.round((defaultExportCount / totalExportFiles) * 100) : 0;

  const orderingCounts = new Map<string, number>();
  let alphabeticalCount = 0;
  let nodeBuiltinSepCount = 0;
  let orderingSamplesWithResult = 0;

  for (const content of importOrderingSamples) {
    const result = detectImportOrderingDetailed(content);
    if (result.ordering) {
      orderingCounts.set(result.ordering, (orderingCounts.get(result.ordering) ?? 0) + 1);
      orderingSamplesWithResult++;
      if (result.alphabetical) alphabeticalCount++;
      if (result.nodeBuiltinSeparated) nodeBuiltinSepCount++;
    }
  }

  let importOrdering = orderingCounts.size > 0 ? majorityStyle(orderingCounts) : undefined;

  // Enhance ordering string with alphabetical and node-builtin info
  if (importOrdering && importOrdering !== "mixed") {
    const parts = [importOrdering];
    if (orderingSamplesWithResult > 0 && alphabeticalCount / orderingSamplesWithResult > 0.7) {
      parts.push("alphabetical within groups");
    }
    if (orderingSamplesWithResult > 0 && nodeBuiltinSepCount / orderingSamplesWithResult > 0.7) {
      parts.push("node: builtins separated");
    }
    importOrdering = parts.join(", ");
  }

  const globalNaming = {
    functions: majorityStyle(functionCounts),
    types: majorityStyle(typeCounts),
    constants: majorityStyle(constantCounts),
    files: majorityStyle(fileCounts),
  };

  const directoryOverrides = detectDirectoryOverrides(fileIdentifiers, fileNamesByFile, globalNaming);

  const namingPrefixes = detectNamingPrefixes(allFunctions);

  const conventions: InferredConventions = {
    naming: globalNaming,
    exportStyle: {
      preferNamed: defaultPercent < 50,
      defaultExportPercent: defaultPercent,
      barrelFileCount,
    },
    importOrdering: importOrdering === "mixed" ? undefined : importOrdering,
    directoryOverrides,
    namingPrefixes,
  };

  return filterCoveredConventions(conventions, configConstraints);
}

/**
 * Render inferred conventions as a markdown section with directives.
 */
export function renderConventionsSection(conventions: InferredConventions): string | null {
  const lines: string[] = [];

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

  if (conventions.directoryOverrides && conventions.directoryOverrides.length > 0) {
    for (const override of conventions.directoryOverrides) {
      const overrideParts: string[] = [];
      if (override.naming.functions) {
        overrideParts.push(`${override.naming.functions} for functions`);
      }
      if (override.naming.types) {
        overrideParts.push(`${override.naming.types} for types`);
      }
      if (override.naming.constants) {
        overrideParts.push(`${override.naming.constants} for constants`);
      }
      if (override.naming.files) {
        overrideParts.push(`${override.naming.files} for files`);
      }
      if (overrideParts.length > 0) {
        const globalRef =
          conventions.naming.files !== "mixed"
            ? ` (overrides project-wide ${conventions.naming.files !== "mixed" ? conventions.naming.files : "convention"})`
            : "";
        lines.push(`- **Prefer**: In \`${override.directory}/\`, use ${overrideParts.join(", ")}${globalRef}`);
      }
    }
  }

  if (conventions.namingPrefixes && conventions.namingPrefixes.length > 0) {
    const prefixMap: Record<string, string> = {
      use: "hooks",
      is: "boolean-returning functions",
      has: "boolean-returning functions",
      get: "accessor functions",
      set: "accessor functions",
      handle: "event handlers",
      on: "callbacks",
      create: "factory functions",
      make: "factory functions",
    };

    // Group is/has together and get/set together and create/make together
    const rendered = new Set<string>();
    let prefixCount = 0;
    for (const p of conventions.namingPrefixes) {
      if (prefixCount >= 3) break;

      // Combine is/has
      if ((p.prefix === "is" || p.prefix === "has") && !rendered.has("is/has")) {
        const isEntry = conventions.namingPrefixes.find((x) => x.prefix === "is");
        const hasEntry = conventions.namingPrefixes.find((x) => x.prefix === "has");
        const examples: string[] = [];
        if (isEntry) examples.push(isEntry.example);
        if (hasEntry) examples.push(hasEntry.example);
        lines.push(
          `- **Prefer**: Use \`is\`/\`has\` prefixes for boolean-returning functions (e.g., \`${examples.join("`, `")}\`)`,
        );
        rendered.add("is/has");
        prefixCount++;
        continue;
      }
      if (rendered.has("is/has") && (p.prefix === "is" || p.prefix === "has")) continue;

      // Combine create/make
      if ((p.prefix === "create" || p.prefix === "make") && !rendered.has("create/make")) {
        const createEntry = conventions.namingPrefixes.find((x) => x.prefix === "create");
        const makeEntry = conventions.namingPrefixes.find((x) => x.prefix === "make");
        const examples: string[] = [];
        if (createEntry) examples.push(createEntry.example);
        if (makeEntry) examples.push(makeEntry.example);
        lines.push(
          `- **Prefer**: Use \`create\`/\`make\` prefixes for factory functions (e.g., \`${examples.join("`, `")}\`)`,
        );
        rendered.add("create/make");
        prefixCount++;
        continue;
      }
      if (rendered.has("create/make") && (p.prefix === "create" || p.prefix === "make")) continue;

      const label = prefixMap[p.prefix] ?? "functions";
      lines.push(`- **Prefer**: Follow the \`${p.prefix}\` prefix convention for ${label} (e.g., \`${p.example}\`)`);
      prefixCount++;
    }
  }

  if (conventions.exportStyle.defaultExportPercent <= 10) {
    lines.push("- **Prefer**: Named exports (no default exports)");
  } else if (conventions.exportStyle.preferNamed) {
    lines.push(
      `- **Prefer**: Named exports (${100 - conventions.exportStyle.defaultExportPercent}% named, ${conventions.exportStyle.defaultExportPercent}% default)`,
    );
  }
  if (conventions.exportStyle.barrelFileCount > 0) {
    lines.push(`- **Style**: Uses barrel files (${conventions.exportStyle.barrelFileCount} index re-export files)`);
  }

  if (conventions.importOrdering) {
    lines.push(`- **Style**: Import ordering: ${conventions.importOrdering}`);
  }

  if (lines.length === 0) return null;

  return "## Inferred Conventions\n\n" + lines.join("\n");
}

function isConfigFile(filePath: string): boolean {
  const basename = path.basename(filePath);
  return (
    /\.(config|rc)\.[jt]sx?$/.test(basename) ||
    basename.startsWith(".") ||
    basename === "jest.setup.ts" ||
    basename === "vitest.config.ts"
  );
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

  const hasNamingRule = configConstraints.linter?.keyRules.some((r) => r.rule.includes("naming-convention"));
  if (hasNamingRule) {
    result.naming = { functions: "mixed", types: "mixed", constants: "mixed", files: "mixed" };
    result.directoryOverrides = undefined;
  }

  const hasImportOrder = configConstraints.linter?.keyRules.some(
    (r) => r.rule.includes("import/order") || r.rule.includes("useSortedImports"),
  );
  if (hasImportOrder) {
    result.importOrdering = undefined;
  }

  const hasNaming = Object.values(result.naming).some((v) => v !== "mixed");
  const hasExport = result.exportStyle.defaultExportPercent < 90;
  const hasImport = !!result.importOrdering;
  const hasOverrides = (result.directoryOverrides?.length ?? 0) > 0;
  const hasPrefixes = (result.namingPrefixes?.length ?? 0) > 0;

  if (!hasNaming && !hasExport && !hasImport && !hasOverrides && !hasPrefixes) return null;

  return result;
}
