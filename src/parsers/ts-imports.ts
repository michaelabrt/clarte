import type { Node } from "web-tree-sitter";
import type { RawImport } from "./types.js";

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
    } else if (node.type === "expression_statement" || node.type === "lexical_declaration") {
      // Dynamic import() and require()
      collectDynamicImports(node, imports);
    }
  }

  // require() via AST: find all call_expression with callee "require"
  const requireCalls = root.descendantsOfType("call_expression");
  for (const call of requireCalls) {
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier" || fn.text !== "require") continue;
    const args = call.childForFieldName("arguments");
    if (!args) continue;
    const firstArg = args.namedChildren[0];
    if (!firstArg) continue;
    const spec = extractStringContent(firstArg);
    if (spec && !importSpecifiers.has(spec)) {
      importSpecifiers.add(spec);
      imports.push({ specifier: spec, importedNames: [] });
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
    }
    // namespace_import: import * as utils from '...' -> no named imports
  }

  return { specifier, importedNames: names, isTypeOnly };
}

function parseJsExportReexport(exportNode: Node, source: Node): RawImport | null {
  const specifier = extractStringContent(source);
  if (!specifier) return null;

  const isTypeOnly = exportNode.children.some((c) => c.type === "type" && !c.isNamed);
  const names: string[] = [];

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

function collectDynamicImports(node: Node, imports: RawImport[]): void {
  // Walk descendants looking for dynamic import() calls
  const calls = node.descendantsOfType("call_expression");
  for (const call of calls) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    if (fn.type === "import") {
      // dynamic import('...')
      const args = call.childForFieldName("arguments");
      if (args) {
        const firstArg = args.namedChildren[0];
        if (firstArg) {
          const spec = extractStringContent(firstArg);
          if (spec) {
            imports.push({ specifier: spec, importedNames: [], isDynamic: true });
          }
        }
      }
    }
  }
}

export function extractStringContent(node: Node): string | null {
  // String nodes have a string_fragment child with the actual content
  const fragment = node.namedChildren.find((c) => c.type === "string_fragment" || c.type === "string_content");
  if (fragment) return fragment.text;

  // For some grammars the text is the full quoted string
  const text = node.text;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }

  return null;
}
