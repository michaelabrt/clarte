import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types";
import { extractNodeBlock, extractSignatureBeforeBody } from "./snapshot-utils";

export function extractRustSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "mod_item") {
      // Check if preceded by #[cfg(test)]
      const prev = node.previousNamedSibling;
      if (prev?.type === "attribute_item" && prev.text.includes("cfg(test)")) continue;
    }

    // Only process pub items
    const hasPub = node.namedChildren.some((c) => c.type === "visibility_modifier");
    if (!hasPub && node.type !== "impl_item") continue;

    switch (node.type) {
      case "struct_item": {
        const body = node.namedChildren.find((c) => c.type === "field_declaration_list");
        if (body) {
          const block = extractNodeBlock(node);
          entries.push({ file: relPath, category: "type", signature: block });
        } else {
          // Tuple or unit struct
          entries.push({ file: relPath, category: "type", signature: node.text.replace(/;$/, "").trim() });
        }
        break;
      }
      case "enum_item": {
        const block = extractNodeBlock(node);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }
      case "trait_item": {
        const block = extractNodeBlock(node);
        entries.push({ file: relPath, category: "interface", signature: block });
        break;
      }
      case "type_item": {
        // pub type Foo = ...
        entries.push({ file: relPath, category: "type", signature: node.text.replace(/;$/, "").trim() });
        break;
      }
      case "function_item": {
        const sig = extractSignatureBeforeBody(node, content);
        entries.push({ file: relPath, category: "function", signature: sig });
        break;
      }
      case "impl_item": {
        // Extract pub fn from impl blocks
        const body = node.namedChildren.find((c) => c.type === "declaration_list");
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === "function_item") {
              const hasPubFn = child.namedChildren.some((c) => c.type === "visibility_modifier");
              if (hasPubFn) {
                const sig = extractSignatureBeforeBody(child, content);
                entries.push({ file: relPath, category: "function", signature: sig });
              }
            }
          }
        }
        break;
      }
    }
  }

  return entries;
}
