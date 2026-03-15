import type { Node } from "web-tree-sitter";
import type { RawImport } from "../types/parser.js";

export function parseGoImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      // Single or grouped imports
      const specs = node.descendantsOfType("import_spec");
      for (const spec of specs) {
        const pathNode = spec.childForFieldName("path");
        if (pathNode) {
          // Strip quotes from interpreted_string_literal
          const content = pathNode.namedChildren.find((c) => c.type === "interpreted_string_literal_content");
          const specifier = content ? content.text : pathNode.text.replace(/^"|"$/g, "");
          imports.push({ specifier, importedNames: [] });
        }
      }
    }
  }

  return imports;
}
