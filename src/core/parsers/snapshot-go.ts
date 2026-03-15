import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types.js";
import { extractNodeBlock, extractSignatureBeforeBody } from "./snapshot-utils.js";

export function extractGoSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  // Check for generated file: first comment contains "Code generated"
  const firstComment = root.namedChildren.find((c) => c.type === "comment");
  if (firstComment && /Code generated/.test(firstComment.text)) return [];

  for (const node of root.namedChildren) {
    if (node.type === "type_declaration") {
      const specs = node.namedChildren.filter((c) => c.type === "type_spec");
      for (const spec of specs) {
        const name = spec.childForFieldName("name")?.text ?? "";
        // Only exported (uppercase)
        if (!name || name[0] !== name[0].toUpperCase()) continue;

        const typeNode = spec.childForFieldName("type");
        if (!typeNode) continue;

        if (typeNode.type === "struct_type" || typeNode.type === "interface_type") {
          const category: SnapshotEntry["category"] = typeNode.type === "interface_type" ? "interface" : "type";
          const block = extractNodeBlock(spec);
          entries.push({ file: relPath, category, signature: `type ${block}` });
        } else {
          // Type alias or named type
          entries.push({ file: relPath, category: "type", signature: `type ${spec.text.trimStart()}` });
        }
      }
    } else if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (!name || name[0] !== name[0].toUpperCase()) continue;

      const sig = extractSignatureBeforeBody(node, content);
      entries.push({ file: relPath, category: "function", signature: sig });
    } else if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (!name || name[0] !== name[0].toUpperCase()) continue;

      const sig = extractGoMethodSig(node, content);
      entries.push({ file: relPath, category: "function", signature: sig });
    } else if (node.type === "const_declaration") {
      // Const blocks with exported names (enum-like iota patterns)
      const hasExported = node.descendantsOfType("const_spec").some((spec) => {
        const name = spec.childForFieldName("name")?.text ?? "";
        return name && name[0] === name[0].toUpperCase();
      });
      if (hasExported) {
        const block = extractNodeBlock(node);
        entries.push({ file: relPath, category: "type", signature: block });
      }
    }
  }

  return entries;
}

function extractGoMethodSig(node: Node, content: string): string {
  const sig = extractSignatureBeforeBody(node, content);

  // Rewrite method receivers: func (r *Type) Method(... -> (Type).Method(...
  const receiverMatch = sig.match(/^func\s*\(\w+\s+\*?(\w+(?:\[[^\]]+\])?)\)\s*(\w+)\((.*)$/);
  if (receiverMatch) {
    const [, receiverType, methodName, rest] = receiverMatch;
    return `(${receiverType}).${methodName}(${rest}`;
  }

  return sig;
}
