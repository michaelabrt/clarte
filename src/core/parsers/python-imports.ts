import type { Node } from "web-tree-sitter";
import type { RawImport } from "../types/parser";

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
        scanBlockForImports(node.childForFieldName("consequence"), imports, true);
      }
    } else if (node.type === "try_statement") {
      // try/except conditional imports (e.g., try: import ujson as json)
      scanBlockForImports(node, imports, false);
    }
  }

  return imports;
}

/** Scan a block node (try body, if body, etc.) for import statements. */
function scanBlockForImports(block: Node | null, imports: RawImport[], isTypeOnly: boolean): void {
  if (!block) return;
  for (const child of block.descendantsOfType(["import_statement", "import_from_statement"])) {
    if (child.type === "import_statement") {
      parsePythonImportStmt(child, imports, isTypeOnly);
    } else {
      parsePythonFromImportStmt(child, imports, isTypeOnly);
    }
  }
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
