import type { Language as ClarteLanguage, SnapshotEntry } from "../types.js";
import { parseSource } from "./init.js";
import { extractJsSnapshot } from "./snapshot-ts.js";
import { extractPythonSnapshot } from "./snapshot-python.js";
import { extractGoSnapshot } from "./snapshot-go.js";
import { extractRustSnapshot } from "./snapshot-rust.js";
import { extractJavaSnapshot } from "./snapshot-java.js";

/**
 * Extract snapshot entries from source code using tree-sitter AST.
 */
export function extractSnapshotAst(
  content: string,
  relPath: string,
  lang: ClarteLanguage,
  filePath?: string,
): SnapshotEntry[] {
  const root = parseSource(content, lang, filePath);

  switch (lang) {
    case "typescript":
    case "javascript":
      return extractJsSnapshot(root, content, relPath);
    case "python":
      return extractPythonSnapshot(root, content, relPath);
    case "go":
      return extractGoSnapshot(root, content, relPath);
    case "rust":
      return extractRustSnapshot(root, content, relPath);
    case "java":
      return extractJavaSnapshot(root, content, relPath);
    default:
      return extractJsSnapshot(root, content, relPath);
  }
}
