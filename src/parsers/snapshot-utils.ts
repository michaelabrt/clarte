import type { Node } from "web-tree-sitter";

const BLOCK_LINE_CAP = 30;

/**
 * Extract text from an AST node, trimming per-line indentation and capping at 30 lines.
 * Used by multiple language snapshot parsers.
 */
export function extractNodeBlock(node: Node): string {
  const text = node.text.split("\n").map((l) => l.trimStart());
  if (text.length > BLOCK_LINE_CAP) return text.slice(0, BLOCK_LINE_CAP).join("\n").trim();
  return text.join("\n").trim();
}

/**
 * Extract a function/class signature by slicing content from startNode to the body opening.
 * Falls back to splitting on "{" if no body node is found.
 * Shared across Go, Rust, Java, and TypeScript snapshot parsers.
 */
export function extractSignatureBeforeBody(node: Node, content: string, startNode?: Node): string {
  const start = startNode ?? node;
  const body = node.childForFieldName("body");
  if (body) {
    return content.slice(start.startIndex, body.startIndex).trim();
  }
  const text = content.slice(start.startIndex, node.endIndex);
  const braceIdx = text.indexOf("{");
  if (braceIdx >= 0) return text.slice(0, braceIdx).trim();
  return text.trim();
}

/**
 * Strip the leading `@` and trailing `(args)` from an annotation/decorator text node.
 * e.g. `@Column(name = "id")` -> `Column`
 */
export function stripAnnotationName(text: string): string {
  return text.replace(/^@/, "").split("(")[0].trim();
}
