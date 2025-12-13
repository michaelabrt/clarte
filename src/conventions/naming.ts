import type { InferredConventions } from "../types.js";

const CAMEL_CASE = /^[a-z][a-zA-Z0-9]*$/;
const PASCAL_CASE = /^[A-Z][a-zA-Z0-9]*$/;
const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const UPPER_SNAKE_CASE = /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/;
const KEBAB_CASE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;

export type NamingStyle = "camelCase" | "PascalCase" | "snake_case" | "UPPER_SNAKE_CASE" | "mixed";

export function classifyName(name: string): NamingStyle | null {
  if (UPPER_SNAKE_CASE.test(name)) return "UPPER_SNAKE_CASE";
  if (PASCAL_CASE.test(name)) return "PascalCase";
  if (SNAKE_CASE.test(name)) return "snake_case";
  if (CAMEL_CASE.test(name)) return "camelCase";
  return null;
}

export function classifyFilename(name: string): string | null {
  const base = name.replace(/\.[^.]+$/, "");
  if (!base || base.length < 2) return null;
  if (KEBAB_CASE.test(base)) return "kebab-case";
  if (SNAKE_CASE.test(base)) return "snake_case";
  if (PASCAL_CASE.test(base)) return "PascalCase";
  if (CAMEL_CASE.test(base)) return "camelCase";
  return null;
}

export function majorityStyle(counts: Map<string, number>, threshold = 0.6): string {
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

const EXPORT_FUNCTION = /^export\s+(?:async\s+)?function\s+(\w+)/gm;
const EXPORT_CONST_FN = /^export\s+const\s+(\w+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[a-zA-Z_$]\w*)\s*(?:=>|:\s*\w)/gm;
const EXPORT_TYPE = /^export\s+(?:type|interface|enum)\s+(\w+)/gm;
const EXPORT_CONST = /^export\s+const\s+(\w+)\s*(?::\s*\w+\s*)?=/gm;

export interface IdentifierSample {
  functions: string[];
  types: string[];
  constants: string[];
}

export function extractExportedIdentifiers(content: string): IdentifierSample {
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

export function detectNamingPrefixes(functions: string[]): InferredConventions["namingPrefixes"] {
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

export function detectDirectoryOverrides(
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
    dirIdentifiers.get(dir)!.files.push(...names);
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
      const dirStyle = majorityStyle(counts, 0.8);
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
      const dirStyle = majorityStyle(counts, 0.8);
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
      const dirStyle = majorityStyle(counts, 0.8);
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
      const dirStyle = majorityStyle(counts, 0.8);
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
