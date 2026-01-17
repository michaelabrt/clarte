import type { Node } from "web-tree-sitter";
import type { RawImport } from "../types/parser.js";

export function parsePythonImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      parsePythonImportStmt(node, imports, false);
    } else if (node.type === "import_from_statement") {
      parsePythonFromImportStmt(node, imports, false);
    } else if (node.type === "if_statement") {
      // TYPE_CHECKING guard
      const condition = node.childForFieldName("condition");
      if (condition && (condition.text === "TYPE_CHECKING" || condition.text === "typing.TYPE_CHECKING")) {
        const consequence = node.childForFieldName("consequence");
        if (consequence) {
          for (const child of consequence.namedChildren) {
            if (child.type === "import_statement") {
              parsePythonImportStmt(child, imports, true);
            } else if (child.type === "import_from_statement") {
              parsePythonFromImportStmt(child, imports, true);
            }
          }
        }
      }
    }
  }

  return imports;
}

function parsePythonImportStmt(node: Node, imports: RawImport[], isTypeOnly: boolean): void {
  // import foo, bar, baz
  const names = node.childrenForFieldName("name");
  for (const name of names) {
    const specifier = name.text.split(" as ")[0].trim();
    imports.push({ specifier, importedNames: [], isTypeOnly: isTypeOnly || undefined });
  }
}

function parsePythonFromImportStmt(node: Node, imports: RawImport[], isTypeOnly: boolean): void {
  // from module import name1, name2
  const moduleName = node.childForFieldName("module_name");
  if (!moduleName) return;

  const specifier = moduleName.text;
  const nameNodes = node.childrenForFieldName("name");
  const importedNames = nameNodes.map((n) => n.text.split(" as ")[0].trim());

  imports.push({ specifier, importedNames, isTypeOnly: isTypeOnly || undefined });
}
