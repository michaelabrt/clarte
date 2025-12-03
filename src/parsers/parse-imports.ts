import type { Language as ClarteLanguage } from "../types.js";
import type { RawImport } from "./types.js";
import { parseSource } from "./init.js";
import { parseJsImportsAst } from "./ts-imports.js";
import { parsePythonImportsAst } from "./python-imports.js";
import { parseGoImportsAst } from "./go-imports.js";
import { parseRustImportsAst } from "./rust-imports.js";
import { parseJavaImportsAst } from "./java-imports.js";

/**
 * Parse imports from source code using tree-sitter AST.
 */
export function parseImportsAst(content: string, lang: ClarteLanguage, filePath?: string): RawImport[] {
  const root = parseSource(content, lang, filePath);

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
      return parseJsImportsAst(root);
  }
}
