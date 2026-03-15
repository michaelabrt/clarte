import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types.js";
import { stripAnnotationName } from "./snapshot-utils.js";

/** Bases that indicate a "type" category */
const PY_TYPE_BASES = new Set(["BaseModel", "TypedDict", "NamedTuple", "Protocol"]);

/** Decorator names that indicate a dataclass-like */
const PY_DATACLASS_DECORATORS = new Set(["dataclass", "dataclasses.dataclass", "attrs", "attr.s", "define"]);

export function extractPythonSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "decorated_definition") {
      const decorators = node.namedChildren.filter((c) => c.type === "decorator");
      const definition = node.namedChildren.find(
        (c) => c.type === "class_definition" || c.type === "function_definition",
      );
      if (!definition) continue;

      const decoNames = decorators.map((d) => stripAnnotationName(d.text));

      if (definition.type === "class_definition") {
        extractPythonClassEntry(definition, content, relPath, entries, decoNames);
      } else if (definition.type === "function_definition") {
        extractPythonFunctionEntry(definition, content, relPath, entries, decoNames, 0);
      }
    } else if (node.type === "class_definition") {
      extractPythonClassEntry(node, content, relPath, entries, []);
    } else if (node.type === "function_definition") {
      extractPythonFunctionEntry(node, content, relPath, entries, [], 0);
    } else if (node.type === "expression_statement") {
      // Type aliases: Foo = NewType/Union/Optional/...
      const child = node.firstNamedChild;
      if (child?.type === "assignment") {
        const right = child.childForFieldName("right");
        if (right) {
          const rightText = right.text;
          if (/^(?:NewType|Union|Optional|Callable|Literal|TypeVar|Annotated)\b/.test(rightText)) {
            entries.push({ file: relPath, category: "type", signature: node.text.trimStart() });
          }
        }
      }
    }
  }

  return entries;
}

function extractPythonClassEntry(
  node: Node,
  content: string,
  relPath: string,
  entries: SnapshotEntry[],
  decorators: string[],
): void {
  // Get base classes
  const superclassNode = node.childForFieldName("superclasses");
  const baseList: string[] = [];
  if (superclassNode) {
    for (const child of superclassNode.namedChildren) {
      // Handle both simple identifiers and subscripted (Generic[T]) bases
      const baseName = child.text.split("[")[0].split("(")[0].trim();
      if (baseName) baseList.push(baseName);
    }
  }

  const isEnum = baseList.some((b) => b === "Enum" || b === "IntEnum" || b === "StrEnum");
  const isProtocol = baseList.some((b) => b === "Protocol");
  const isDatalike =
    baseList.some((b) => PY_TYPE_BASES.has(b)) || decorators.some((d) => PY_DATACLASS_DECORATORS.has(d));

  let category: SnapshotEntry["category"] = "type";
  if (isProtocol) category = "interface";

  if (isDatalike || isEnum || isProtocol) {
    // Data-like: extract full block
    const block = extractPythonBlock(node, decorators);
    entries.push({ file: relPath, category, signature: block });
  } else {
    // Non-data class: extract header + public methods
    const decoPrefix = decorators.map((d) => `@${d}`).join("\n");
    const classLine = node.text.split("\n")[0].trimStart();
    let header = decoPrefix ? `${decoPrefix}\n${classLine}` : classLine;

    // Look for docstring
    const body = node.childForFieldName("body");
    if (body) {
      const docstring = extractPythonDocstringFromBody(body);
      if (docstring) header += ` # "${docstring}"`;
    }

    entries.push({ file: relPath, category: "type", signature: header });

    // Extract public methods from the class body
    if (body) {
      for (const child of body.namedChildren) {
        let funcNode: Node | null = null;
        let methodDecos: string[] = [];

        if (child.type === "function_definition") {
          funcNode = child;
        } else if (child.type === "decorated_definition") {
          methodDecos = child.namedChildren
            .filter((c) => c.type === "decorator")
            .map((d) => stripAnnotationName(d.text));
          funcNode = child.namedChildren.find((c) => c.type === "function_definition") ?? null;
        }

        if (funcNode) {
          const methodName = funcNode.childForFieldName("name")?.text ?? "";
          // Skip private/dunder methods except __init__
          if (methodName.startsWith("_") && methodName !== "__init__") continue;
          extractPythonFunctionEntry(funcNode, content, relPath, entries, methodDecos, 1);
        }
      }
    }
  }
}

function extractPythonFunctionEntry(
  node: Node,
  content: string,
  relPath: string,
  entries: SnapshotEntry[],
  decorators: string[],
  nestLevel: number,
): void {
  const name = node.childForFieldName("name")?.text ?? "";

  // Skip private and test functions at top level
  if (nestLevel === 0 && (name.startsWith("_") || name.startsWith("test_"))) return;

  const sig = extractPythonFuncSignature(node, content, decorators);
  entries.push({ file: relPath, category: "function", signature: sig });
}

function extractPythonBlock(node: Node, decorators: string[]): string {
  const maxLines = 30;
  const decoPrefix = decorators.map((d) => `@${d}`).join("\n");

  // Get the node text and trim leading indentation from each line
  const lines = node.text.split("\n").map((l) => l.trimStart());
  if (lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    return decoPrefix ? `${decoPrefix}\n${trimmed.join("\n")}` : trimmed.join("\n");
  }

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return decoPrefix ? `${decoPrefix}\n${lines.join("\n")}` : lines.join("\n");
}

function extractPythonFuncSignature(node: Node, content: string, decorators: string[]): string {
  const parts: string[] = [];

  for (const dec of decorators) {
    parts.push(`@${dec}`);
  }

  // Build signature from the def line through the colon
  const body = node.childForFieldName("body");

  // Compute signature end: just before the body (the ":" before the block)
  let sigEnd: number;
  if (body) {
    // The colon is between the return type (or params) and the body
    sigEnd = body.startIndex;
  } else {
    sigEnd = node.endIndex;
  }

  // Get the signature text
  let sigText = content.slice(node.startIndex, sigEnd).trimStart();

  // Ensure it ends with ":"
  sigText = sigText.trimEnd();
  if (!sigText.endsWith(":")) {
    // Find the colon
    const colonIdx = sigText.lastIndexOf(":");
    if (colonIdx >= 0) {
      sigText = sigText.slice(0, colonIdx + 1);
    }
  }

  // Collapse multi-line signatures to single line
  sigText = sigText
    .split("\n")
    .map((l) => l.trim())
    .join(" ");

  parts.push(sigText);

  // Look for docstring
  if (body) {
    const docstring = extractPythonDocstringFromBody(body);
    if (docstring) {
      parts[parts.length - 1] += ` # "${docstring}"`;
    }
  }

  return parts.join("\n");
}

function extractPythonDocstringFromBody(body: Node): string | null {
  // Docstring is the first expression_statement with a string child
  const firstStmt = body.namedChildren[0];
  if (!firstStmt || firstStmt.type !== "expression_statement") return null;

  const stringNode = firstStmt.firstNamedChild;
  if (!stringNode || stringNode.type !== "string") return null;

  let text = stringNode.text;
  // Strip triple quotes
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const quote = text.slice(0, 3);
    text = text.slice(3);
    if (text.endsWith(quote)) text = text.slice(0, -3);
  } else if (text.startsWith('"') || text.startsWith("'")) {
    text = text.slice(1, -1);
  }

  text = text.trim().split("\n")[0].trim();
  if (!text) return null;

  if (text.length > 80) text = text.slice(0, 77) + "...";
  return text;
}
