import type { Language as ClarteLanguage, SnapshotEntry } from "../types";
import { withParsedTree } from "./init";
import { extractJsSnapshot } from "./snapshot-ts";
import { extractPythonSnapshot } from "./snapshot-python";
import { extractGoSnapshot } from "./snapshot-go";
import { extractRustSnapshot } from "./snapshot-rust";
import { extractJavaSnapshot } from "./snapshot-java";

/**
 * Extract snapshot entries from source code using tree-sitter AST.
 */
export function extractSnapshotAst(
  content: string,
  relPath: string,
  lang: ClarteLanguage,
  filePath?: string,
): SnapshotEntry[] {
  return withParsedTree(content, lang, filePath, (root) => {
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
  });
}
