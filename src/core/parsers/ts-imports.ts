import type { Node } from "web-tree-sitter";
import type { RawImport } from "../types/parser";

export function parseJsImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];
  const importSpecifiers = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      const imp = parseJsImportStatement(node);
      if (imp) {
        imports.push(imp);
        importSpecifiers.add(imp.specifier);
      }
    } else if (node.type === "export_statement") {
      // Re-exports: export { Foo } from './module' or export * from './module'
      const source = node.childForFieldName("source");
      if (source) {
        const imp = parseJsExportReexport(node, source);
        if (imp) {
          imports.push(imp);
          importSpecifiers.add(imp.specifier);
        }
      }
    }
  }

  // Scan all call_expression nodes for dynamic import() and require() at any nesting depth
  const allCalls = root.descendantsOfType("call_expression");
  for (const call of allCalls) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    if (fn.type === "import") {
      // Dynamic import('...')
      const args = call.childForFieldName("arguments");
      if (!args) continue;
      const firstArg = args.namedChildren[0];
      if (!firstArg) continue;
      const spec = extractStringContent(firstArg);
      if (spec && !importSpecifiers.has(spec)) {
        importSpecifiers.add(spec);
        imports.push({ specifier: spec, importedNames: [], isDynamic: true });
      }
    } else if (fn.type === "identifier" && fn.text === "require") {
      // require('...')
      const args = call.childForFieldName("arguments");
      if (!args) continue;
      const firstArg = args.namedChildren[0];
      if (!firstArg) continue;
      const spec = extractStringContent(firstArg);
      if (spec && !importSpecifiers.has(spec)) {
        importSpecifiers.add(spec);
        const names = extractRequireDestructuring(call);
        imports.push({ specifier: spec, importedNames: names });
      }
    }
  }

  return imports;
}

function parseJsImportStatement(node: Node): RawImport | null {
  const source = node.childForFieldName("source");
  if (!source) return null;

  const specifier = extractStringContent(source);
  if (!specifier) return null;

  // Check for `type` keyword (import type { ... })
  const isTypeOnly = node.children.some((c) => c.type === "type" && !c.isNamed);

  // Side-effect import: import './style.css' (no import_clause)
  const importClause = node.namedChildren.find((c) => c.type === "import_clause");
  if (!importClause) {
    return { specifier, importedNames: [], isTypeOnly };
  }

  const names: string[] = [];
  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      // Default import: import Foo from '...'
      names.push(child.text);
    } else if (child.type === "named_imports") {
      // Named imports: import { foo, bar } from '...'
      for (const spec of child.namedChildren) {
        if (spec.type === "import_specifier") {
          const name = spec.childForFieldName("name");
          if (name) names.push(name.text);
        }
      }
    } else if (child.type === "namespace_import") {
      // import * as ns from '...' — store alias in "* as ns" format so
      // resolution can match callSite.objectName against the alias
      const aliasNode = child.namedChildren.find((c) => c.type === "identifier");
      names.push(aliasNode ? `* as ${aliasNode.text}` : "*");
    }
  }

  return { specifier, importedNames: names, isTypeOnly };
}

function parseJsExportReexport(exportNode: Node, source: Node): RawImport | null {
  const specifier = extractStringContent(source);
  if (!specifier) return null;

  const isTypeOnly = exportNode.children.some((c) => c.type === "type" && !c.isNamed);
  const names: string[] = [];

  // export * as ns from '...' — namespace re-export (TS 3.8+)
  const nsExport = exportNode.namedChildren.find((c) => c.type === "namespace_export");
  if (nsExport) {
    return { specifier, importedNames: ["*"], isTypeOnly };
  }

  const exportClause = exportNode.namedChildren.find((c) => c.type === "export_clause");
  if (exportClause) {
    for (const spec of exportClause.namedChildren) {
      if (spec.type === "export_specifier") {
        const name = spec.childForFieldName("name");
        if (name) names.push(name.text);
      }
    }
  }

  return { specifier, importedNames: names, isTypeOnly };
}

/** Extract destructured names from `const { foo, bar } = require('...')` */
function extractRequireDestructuring(callNode: Node): string[] {
  // call_expression -> variable_declarator -> name: object_pattern
  const declarator = callNode.parent;
  if (!declarator || declarator.type !== "variable_declarator") return [];

  const name = declarator.childForFieldName("name");
  if (!name || name.type !== "object_pattern") return [];

  const names: string[] = [];
  for (const child of name.namedChildren) {
    if (child.type === "shorthand_property_identifier_pattern") {
      names.push(child.text);
    } else if (child.type === "pair_pattern") {
      const value = child.childForFieldName("value");
      if (value) names.push(value.text);
    }
  }
  return names;
}

export function extractStringContent(node: Node): string | null {
  // String nodes have a string_fragment child with the actual content
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment" || c.type === "string_content");
  if (fragment) return fragment.text;

  // For some grammars the text is the full quoted string — unescape common sequences
  const text = node.text;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }

  return null;
}
