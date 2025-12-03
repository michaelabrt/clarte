import type { Node } from "web-tree-sitter";
import type { RawImport } from "./types.js";

export function parseJavaImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      // The import path is the full text minus "import", "static", and ";"
      const hasAsterisk = node.namedChildren.some((c) => c.type === "asterisk");
      const scopedId = node.namedChildren.find((c) => c.type === "scoped_identifier");

      if (scopedId) {
        const fullPath = hasAsterisk ? `${scopedId.text}.*` : scopedId.text;
        const parts = fullPath.split(".");
        const lastName = parts[parts.length - 1];
        const names = lastName === "*" ? [] : [lastName];
        imports.push({ specifier: fullPath, importedNames: names });
      }
    }
  }

  return imports;
}
