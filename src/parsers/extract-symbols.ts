import { parseSource } from "./init.js";
import type { Language } from "../types/detection.js";
import type { Node } from "web-tree-sitter";

/** Collect non-empty names from descendantsOfType, filtering out short/private names. */
function collectNames(root: Node, ...types: string[]): string[] {
  const names: string[] = [];
  for (const type of types) {
    for (const node of root.descendantsOfType(type)) {
      const name = node.childForFieldName("name")?.text;
      if (name && name.length > 1 && !name.startsWith("_")) names.push(name);
    }
  }
  return names;
}

function extractTsSymbols(root: Node): string[] {
  const names = collectNames(root, "function_declaration", "method_definition", "class_declaration");

  // Top-level const arrow functions: export const foo = (...) => ...
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement" && node.type !== "lexical_declaration") continue;
    const decl = node.type === "export_statement" ? node.childForFieldName("declaration") : node;
    if (!decl || decl.type !== "lexical_declaration") continue;
    for (const declarator of decl.descendantsOfType("variable_declarator")) {
      const name = declarator.childForFieldName("name")?.text;
      const value = declarator.childForFieldName("value");
      if (name && name.length > 1 && value &&
          (value.type === "arrow_function" || value.type === "function_expression")) {
        names.push(name);
      }
    }
  }

  return names;
}

function extractPythonSymbols(root: Node): string[] {
  return collectNames(root, "function_definition", "class_definition");
}

function extractGoSymbols(root: Node): string[] {
  return collectNames(root, "function_declaration", "method_declaration", "type_spec");
}

function extractRustSymbols(root: Node): string[] {
  return collectNames(root, "function_item", "struct_item", "enum_item", "trait_item", "impl_item");
}

function extractJavaSymbols(root: Node): string[] {
  return collectNames(root, "method_declaration", "class_declaration", "interface_declaration");
}

/**
 * Extract all function, method and class names from a source file.
 * Returns an array of raw identifier names (not tokenized).
 */
export function extractSymbolNames(content: string, language: Language, filePath?: string): string[] {
  try {
    const root = parseSource(content, language, filePath);
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
  } catch {
    return [];
  }
}
