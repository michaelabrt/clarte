import type { Node } from "web-tree-sitter";
import type { RawImport } from "../types/parser.js";

export function parseRustImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) {
        parseRustUsePath(arg, imports);
      }
    } else if (node.type === "mod_item") {
      const name = node.childForFieldName("name");
      const body = node.namedChildren.find((c) => c.type === "declaration_list");
      if (name && !body) {
        // External mod declaration (mod foo;)
        imports.push({ specifier: `mod::${name.text}`, importedNames: [] });
      } else if (body && name?.text !== "tests") {
        // Inline non-test mod block: scan for use declarations
        for (const child of body.namedChildren) {
          if (child.type === "use_declaration") {
            const arg = child.childForFieldName("argument");
            if (arg) parseRustUsePath(arg, imports);
          }
        }
      }
    }
  }

  return imports;
}

function parseRustUsePath(node: Node, imports: RawImport[]): void {
  if (node.type === "scoped_use_list") {
    // use crate::types::{Language, HubFile}
    const pathNode = node.childForFieldName("path");
    const list = node.childForFieldName("list");
    if (pathNode && list) {
      const basePath = pathNode.text;
      const names: string[] = [];
      for (const child of list.namedChildren) {
        if (child.type === "identifier" || child.type === "self") {
          names.push(child.text);
        } else if (child.type === "scoped_identifier") {
          names.push(child.text);
        } else if (child.type === "use_wildcard" || child.text === "*") {
          names.push("*");
        } else if (child.type === "scoped_use_list") {
          parseRustUsePath(child, imports);
        }
      }
      imports.push({ specifier: `${basePath}::{${names.join(", ")}}`, importedNames: names });
    }
  } else if (node.type === "scoped_identifier") {
    // use crate::graph::ImportGraph
    const specifier = node.text;
    const name = node.childForFieldName("name");
    imports.push({
      specifier,
      importedNames: name ? [name.text] : [],
    });
  } else if (node.type === "use_wildcard") {
    // use crate::prelude::*
    imports.push({ specifier: node.text, importedNames: [] });
  } else if (node.type === "identifier") {
    imports.push({ specifier: node.text, importedNames: [node.text] });
  }
}
