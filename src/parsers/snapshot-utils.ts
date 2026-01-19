import type { Node } from "web-tree-sitter";

/**
 * Extract text from an AST node, trimming per-line indentation and capping at 30 lines.
 * Used by multiple language snapshot parsers.
 */
export function extractNodeBlock(node: Node): string {
  const text = node.text.split("\n").map((l) => l.trimStart());
  if (text.length > 30) return text.slice(0, 30).join("\n").trim();
  return text.join("\n").trim();
}
