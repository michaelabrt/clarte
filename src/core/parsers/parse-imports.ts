import type { Node } from "web-tree-sitter";
import type { Language as ClarteLanguage } from "../types";
import type { RawImport } from "../types/parser";
import { withParsedTree } from "./init";
import { parseJsImportsAst } from "./ts-imports";
import { parsePythonImportsAst } from "./python-imports";
import { parseGoImportsAst } from "./go-imports";
import { parseRustImportsAst } from "./rust-imports";
import { parseJavaImportsAst } from "./java-imports";

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
  return withParsedTree(content, lang, filePath, (root) => parseImportsAstFromRoot(root, lang));
}
