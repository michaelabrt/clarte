import path from "node:path";
import { parseSource } from "./init.js";
import { extractStringContent } from "./ts-imports.js";
import { BARREL_THRESHOLD } from "../config/thresholds.js";
import type { Language } from "../types/detection.js";

/** Pick the correct grammar for a JS/TS file. JSX/TSX files need the tsx grammar. */
function barrelLang(filePath?: string): Language {
  if (!filePath) return "typescript";
  const ext = path.extname(filePath).slice(1).toLowerCase();
  return ext === "jsx" || ext === "tsx" ? "typescript" : ext === "js" || ext === "mjs" || ext === "cjs" ? "javascript" : "typescript";
}

/** Check barrel status from a pre-parsed root node (avoids re-parsing). */
export function detectBarrelFromRoot(root: import("web-tree-sitter").Node): boolean {
  let reExportCount = 0;
  let totalStatements = 0;
  for (const node of root.namedChildren) {
    if (node.type === "export_statement") {
      totalStatements++;
      if (node.childForFieldName("source")) reExportCount++;
    } else if (
      node.type === "import_statement" || node.type === "lexical_declaration" ||
      node.type === "function_declaration" || node.type === "class_declaration" ||
      node.type === "interface_declaration" || node.type === "type_alias_declaration" ||
      node.type === "enum_declaration" || node.type === "expression_statement"
    ) {
      totalStatements++;
    }
  }
  return totalStatements > 0 && reExportCount / totalStatements > BARREL_THRESHOLD;
}

/**
 * Detect if a file is a barrel file (index.ts that re-exports from other modules).
 */
export function detectBarrelAst(
  content: string,
  filePath?: string,
): {
  isBarrel: boolean;
  reExportCount: number;
  totalStatements: number;
} {
  const root = parseSource(content, barrelLang(filePath), filePath);

  let reExportCount = 0;
  let totalStatements = 0;

  for (const node of root.namedChildren) {
    if (node.type === "export_statement") {
      totalStatements++;
      // Re-export if it has a source (from '...')
      if (node.childForFieldName("source")) {
        reExportCount++;
      }
    } else if (
      node.type === "import_statement" ||
      node.type === "lexical_declaration" ||
      node.type === "function_declaration" ||
      node.type === "class_declaration" ||
      node.type === "interface_declaration" ||
      node.type === "type_alias_declaration" ||
      node.type === "enum_declaration" ||
      node.type === "expression_statement"
    ) {
      totalStatements++;
    }
  }

  return {
    isBarrel: totalStatements > 0 && reExportCount / totalStatements > BARREL_THRESHOLD,
    reExportCount,
    totalStatements,
  };
}

/**
 * Resolve barrel file re-exports to their source modules.
 */
export function resolveBarrelExportsAst(
  content: string,
  filePath?: string,
): {
  namedExports: Map<string, string>;
  starExports: Set<string>;
} {
  const root = parseSource(content, barrelLang(filePath), filePath);
  const namedExports = new Map<string, string>();
  const starExports = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;
    const source = node.childForFieldName("source");
    if (!source) continue;

    const specifier = extractStringContent(source);
    if (!specifier) continue;

    // Check for star export: export * from '...' or export * as ns from '...'
    const hasStar = node.children.some((c) => c.type === "*" && !c.isNamed);
    const hasNsExport = node.namedChildren.some((c) => c.type === "namespace_export");
    if (hasStar || hasNsExport) {
      starExports.add(specifier);
      continue;
    }

    // Named re-exports: export { Foo, Bar } from '...'
    const exportClause = node.namedChildren.find((c) => c.type === "export_clause");
    if (exportClause) {
      for (const spec of exportClause.namedChildren) {
        if (spec.type === "export_specifier") {
          const name = spec.childForFieldName("name");
          if (name) {
            namedExports.set(name.text, specifier);
          }
        }
      }
    }
  }

  return { namedExports, starExports };
}

/**
 * Extract all directly exported names from a source file (ESM only).
 * Used to resolve which names a star-exported source actually provides.
 */
export function extractExportedNamesAst(content: string, filePath?: string): Set<string> {
  const root = parseSource(content, barrelLang(filePath), filePath);
  const names = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;
    // Skip re-exports (they have a source)
    if (node.childForFieldName("source")) continue;

    // export { foo, bar }
    const exportClause = node.namedChildren.find((c) => c.type === "export_clause");
    if (exportClause) {
      for (const spec of exportClause.namedChildren) {
        if (spec.type === "export_specifier") {
          const name = spec.childForFieldName("name");
          if (name) names.add(name.text);
        }
      }
      continue;
    }

    // export function foo(), export class Bar, export enum Baz, etc.
    const decl = node.childForFieldName("declaration");
    if (decl) {
      const name = decl.childForFieldName("name")?.text;
      if (name) names.add(name);
      // export const foo = ..., export let bar = ...
      if (decl.type === "lexical_declaration") {
        for (const declarator of decl.namedChildren) {
          if (declarator.type === "variable_declarator") {
            const varName = declarator.childForFieldName("name")?.text;
            if (varName) names.add(varName);
          }
        }
      }
    }
  }

  return names;
}
