import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types";
import { extractSignatureBeforeBody } from "./snapshot-utils";

export function extractJsSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  // Category hints from path (same as regex version)
  const isStore = /stores?[/\\]/.test(relPath);
  const isHook = /hooks?[/\\]/.test(relPath) || relPath.includes("use");
  const isComponent = /components?[/\\]/.test(relPath);

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;

    const declaration = node.childForFieldName("declaration");
    if (!declaration) continue;

    const isDefault = node.children.some((c) => c.type === "default" && !c.isNamed);

    switch (declaration.type) {
      case "interface_declaration": {
        const name = declaration.childForFieldName("name");
        const category = name?.text.endsWith("Slice")
          ? "store"
          : name?.text.endsWith("Props")
            ? "component"
            : ("interface" as const);
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category, signature: block });
        break;
      }

      case "type_alias_declaration": {
        const name = declaration.childForFieldName("name");
        const category = name?.text.endsWith("Slice")
          ? "store"
          : name?.text.endsWith("Props")
            ? "component"
            : ("type" as const);
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category, signature: block });
        break;
      }

      case "enum_declaration": {
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }

      case "function_declaration": {
        const name = declaration.childForFieldName("name")?.text ?? "";

        if (isDefault) {
          let category: SnapshotEntry["category"] = "function";
          if (isHook || name.startsWith("use")) category = "hook";
          else if (isComponent && name[0] === name[0].toUpperCase()) category = "component";
          else if (isStore) category = "store";
          const sig = extractSignatureBeforeBody(declaration, content, node);
          entries.push({ file: relPath, category, signature: sig });
        } else {
          // Skip component function exports
          if (isComponent && name[0] === name[0].toUpperCase() && !name.startsWith("use")) break;

          let category: SnapshotEntry["category"] = "function";
          if (isHook || name.startsWith("use")) category = "hook";
          else if (isStore) category = "store";
          const sig = extractSignatureBeforeBody(declaration, content, node);
          entries.push({ file: relPath, category, signature: sig });
        }
        break;
      }

      case "lexical_declaration": {
        // export const foo = (...) => ...
        const declarator = declaration.namedChildren.find((c) => c.type === "variable_declarator");
        if (!declarator) break;

        const name = declarator.childForFieldName("name")?.text ?? "";
        const value = declarator.childForFieldName("value");

        // Only include function expressions (arrow functions, function expressions)
        if (
          !value ||
          (value.type !== "arrow_function" &&
            value.type !== "function" &&
            value.type !== "function_expression" &&
            value.type !== "call_expression")
        ) {
          break;
        }

        // For call_expression, check if it wraps a function (HOCs, etc.)
        if (value.type === "call_expression") {
          // Only include if the call returns a function-like
          const hasArrowOrFn =
            value.descendantsOfType("arrow_function").length > 0 || value.descendantsOfType("function").length > 0;
          if (!hasArrowOrFn) break;
        }

        if (isComponent && name[0] === name[0].toUpperCase() && !name.startsWith("use")) break;

        let category: SnapshotEntry["category"] = "function";
        if (isHook || name.startsWith("use")) category = "hook";
        else if (isStore) category = "store";
        const sig = extractConstFunctionSignature(node, content);
        entries.push({ file: relPath, category, signature: sig });
        break;
      }

      case "class_declaration": {
        const category = isComponent ? "component" : ("type" as const);
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category, signature: block });
        break;
      }
    }
  }

  // Non-exported Props interfaces in component files
  if (isComponent) {
    for (const node of root.namedChildren) {
      if (node.type === "interface_declaration") {
        const name = node.childForFieldName("name");
        if (name?.text.endsWith("Props")) {
          const block = extractNodeBlock(node, content);
          entries.push({ file: relPath, category: "component", signature: block });
        }
      }
    }
  }

  return entries;
}

/**
 * Extract a full block (type, interface, enum, class) from AST using node spans.
 * Caps at 30 lines to match existing behavior.
 */
function extractNodeBlock(declaration: Node, content: string, exportNode?: Node): string {
  // Include the "export" keyword if present
  const startNode = exportNode ?? declaration;
  const text = content.slice(startNode.startIndex, declaration.endIndex);

  // Cap at 30 lines
  const lines = text.split("\n");
  if (lines.length > 30) {
    return lines.slice(0, 30).join("\n").trim();
  }
  return text.trim();
}

/**
 * Extract signature for `export const foo = (...) => ...`
 * Captures from "export" to just before the arrow function body.
 */
function extractConstFunctionSignature(exportNode: Node, content: string): string {
  const declaration = exportNode.childForFieldName("declaration");
  if (!declaration) return exportNode.text.split("\n")[0];

  const declarator = declaration.namedChildren.find((c) => c.type === "variable_declarator");
  if (!declarator) return content.slice(exportNode.startIndex, declaration.endIndex).trim();

  const value = declarator.childForFieldName("value");
  if (!value) return content.slice(exportNode.startIndex, declaration.endIndex).trim();

  // For arrow functions, capture up to the body (or the => for expression bodies)
  if (value.type === "arrow_function") {
    const body = value.childForFieldName("body");
    if (body && body.type === "statement_block") {
      return content.slice(exportNode.startIndex, body.startIndex).trim();
    }
    // Expression body arrow: include the full signature including =>
    // Slice up to the body start
    if (body) {
      const arrow = value.children.find((c) => c.type === "=>" && !c.isNamed);
      if (arrow) {
        return content.slice(exportNode.startIndex, arrow.endIndex).trim();
      }
    }
  }

  // Fallback
  const fullText = content.slice(exportNode.startIndex, value.endIndex);
  const braceIdx = fullText.indexOf("{");
  if (braceIdx >= 0) return fullText.slice(0, braceIdx).trim();
  return fullText.split("\n").slice(0, 3).join(" ").trim();
}
