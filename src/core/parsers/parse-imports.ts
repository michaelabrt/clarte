import type { Node } from "web-tree-sitter";
import type { Language as ClarteLanguage } from "../types.js";
import type { RawImport } from "../types/parser.js";
import { parseSource } from "./init.js";
import { parseJsImportsAst } from "./ts-imports.js";
import { parsePythonImportsAst } from "./python-imports.js";
import { parseGoImportsAst } from "./go-imports.js";
import { parseRustImportsAst } from "./rust-imports.js";
import { parseJavaImportsAst } from "./java-imports.js";

/** Parse imports from an already-parsed tree-sitter root node. */
export function parseImportsAstFromRoot(root: Node, lang: ClarteLanguage): RawImport[] {
  switch (lang) {
    case "typescript":
    case "javascript":
      return parseJsImportsAst(root);
    case "python":
      return parsePythonImportsAst(root);
    case "go":
      return parseGoImportsAst(root);
    case "rust":
      return parseRustImportsAst(root);
    case "java":
      return parseJavaImportsAst(root);
    default:
      return [];
  }
}

/**
 * Parse imports from source code using tree-sitter AST.
 */
export function parseImportsAst(content: string, lang: ClarteLanguage, filePath?: string): RawImport[] {
  const root = parseSource(content, lang, filePath);
  return parseImportsAstFromRoot(root, lang);
}
