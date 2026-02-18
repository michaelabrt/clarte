import { parseSource } from "./init.js";
import type { Language } from "../types/detection.js";
import type { Node } from "web-tree-sitter";

/** Single-pass descendantsOfType for multiple node types. */
function collectNames(root: Node, types: string[]): string[] {
  const names: string[] = [];
  for (const node of root.descendantsOfType(types)) {
    const name = node.childForFieldName("name")?.text;
    if (name && name.length > 1 && !name.startsWith("_")) names.push(name);
  }
  return names;
}

function extractTsSymbols(root: Node): string[] {
  const names = collectNames(root, ["function_declaration", "method_definition", "class_declaration"]);

  // Top-level const arrow functions: export const foo = (...) => ...
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement" && node.type !== "lexical_declaration") continue;
    const decl = node.type === "export_statement" ? node.childForFieldName("declaration") : node;
    if (!decl || decl.type !== "lexical_declaration") continue;
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name")?.text;
      const value = declarator.childForFieldName("value");
      if (
        name &&
        name.length > 1 &&
        value &&
        (value.type === "arrow_function" || value.type === "function_expression")
      ) {
        names.push(name);
      }
    }
  }

  // CommonJS exports: module.exports = { ... }, module.exports.foo = ..., exports.foo = ...
  for (const node of root.namedChildren) {
    if (node.type !== "expression_statement") continue;
    const expr = node.namedChildren[0];
    if (!expr || expr.type !== "assignment_expression") continue;

    const left = expr.childForFieldName("left");
    if (!left || left.type !== "member_expression") continue;

    const obj = left.childForFieldName("object");
    const prop = left.childForFieldName("property");
    if (!obj || !prop) continue;

    if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
      // module.exports = { foo, bar } or module.exports = { foo: fn }
      const right = expr.childForFieldName("right");
      if (right?.type === "object") {
        for (const child of right.namedChildren) {
          if (child.type === "shorthand_property_identifier") {
            if (child.text.length > 1) names.push(child.text);
          } else if (child.type === "pair") {
            const key = child.childForFieldName("key");
            if (key && (key.type === "property_identifier" || key.type === "string") && key.text.length > 1) {
              names.push(key.text);
            }
          }
        }
      }
    } else if (obj.type === "member_expression") {
      // module.exports.foo = ...
      const innerObj = obj.childForFieldName("object");
      const innerProp = obj.childForFieldName("property");
      if (innerObj?.type === "identifier" && innerObj.text === "module" && innerProp?.text === "exports") {
        if (prop.type === "property_identifier" && prop.text.length > 1) {
          names.push(prop.text);
        }
      }
    } else if (obj.type === "identifier" && obj.text === "exports") {
      // exports.foo = ...
      if (prop.type === "property_identifier" && prop.text.length > 1) {
        names.push(prop.text);
      }
    }
  }

  return names;
}

function extractPythonSymbols(root: Node): string[] {
  return collectNames(root, ["function_definition", "class_definition"]);
}

function extractGoSymbols(root: Node): string[] {
  return collectNames(root, ["function_declaration", "method_declaration", "type_spec"]);
}

function extractRustSymbols(root: Node): string[] {
  return collectNames(root, ["function_item", "struct_item", "enum_item", "trait_item"]);
}

function extractJavaSymbols(root: Node): string[] {
  return collectNames(root, ["method_declaration", "class_declaration", "interface_declaration"]);
}

/** Extract symbol names from an already-parsed tree-sitter root node. */
export function extractSymbolNamesFromRoot(root: Node, language: Language): string[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsSymbols(root);
    case "python":
      return extractPythonSymbols(root);
    case "go":
      return extractGoSymbols(root);
    case "rust":
      return extractRustSymbols(root);
    case "java":
      return extractJavaSymbols(root);
    default:
      return [];
  }
}

/**
 * Extract all function, method and class names from a source file.
 * Returns raw identifier names (not tokenized).
 */
export function extractSymbolNames(content: string, language: Language, filePath?: string): string[] {
  try {
    const root = parseSource(content, language, filePath);
    return extractSymbolNamesFromRoot(root, language);
  } catch {
    return [];
  }
}
