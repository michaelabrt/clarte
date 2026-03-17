import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types";
import { extractNodeBlock, extractSignatureBeforeBody, stripAnnotationName } from "./snapshot-utils";

/** JPA/Spring annotations that indicate a field is structurally significant */
const JAVA_SIGNIFICANT_FIELD_ANNOTATIONS = new Set([
  "ManyToOne",
  "OneToMany",
  "ManyToMany",
  "OneToOne",
  "Column",
  "JoinColumn",
  "JoinTable",
  "Id",
  "EmbeddedId",
  "Embedded",
  "ElementCollection",
]);

export function extractJavaSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  for (const node of root.namedChildren) {
    // Skip non-public top-level declarations
    if (!isJavaPublic(node)) continue;

    // Check for @Generated annotation
    if (hasJavaAnnotation(node, "Generated")) continue;

    switch (node.type) {
      case "interface_declaration": {
        const block = extractNodeBlock(node);
        entries.push({ file: relPath, category: "interface", signature: block });
        break;
      }
      case "enum_declaration": {
        const block = extractNodeBlock(node);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }
      case "record_declaration": {
        const sig = extractSignatureBeforeBody(node, content);
        entries.push({ file: relPath, category: "type", signature: sig });
        break;
      }
      case "class_declaration": {
        // Extract class header
        const header = extractSignatureBeforeBody(node, content);
        entries.push({ file: relPath, category: "type", signature: header });

        // Extract public methods
        const body = node.childForFieldName("body");
        if (body) {
          extractJavaClassMethods(body, relPath, entries);
        }
        break;
      }
    }
  }

  return entries;
}

function isJavaPublic(node: Node): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.text.includes("public");
}

function hasJavaAnnotation(node: Node, name: string): boolean {
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.namedChildren.some((c) => {
    if (c.type !== "marker_annotation" && c.type !== "annotation") return false;
    return stripAnnotationName(c.text) === name;
  });
}

function extractJavaClassMethods(body: Node, relPath: string, entries: SnapshotEntry[]): void {
  for (const child of body.namedChildren) {
    if (child.type === "method_declaration") {
      if (!isJavaPublic(child)) continue;
      if (hasJavaAnnotation(child, "Generated")) continue;
      const sig = extractJavaMethodSig(child);
      entries.push({ file: relPath, category: "function", signature: sig });
    } else if (child.type === "field_declaration") {
      // Extract public fields with significant annotations (JPA, etc.)
      if (!isJavaPublic(child)) continue;
      const modifiers = child.namedChildren.find((c) => c.type === "modifiers");
      if (!modifiers) continue;
      const hasSignificant = modifiers.namedChildren.some((c) => {
        if (c.type !== "marker_annotation" && c.type !== "annotation") return false;
        return JAVA_SIGNIFICANT_FIELD_ANNOTATIONS.has(stripAnnotationName(c.text));
      });
      if (hasSignificant) {
        entries.push({ file: relPath, category: "type", signature: child.text.trimStart() });
      }
    }
  }
}

function extractJavaMethodSig(node: Node): string {
  const body = node.childForFieldName("body");
  let sig: string;
  if (body) {
    sig = node.text.slice(0, body.startIndex - node.startIndex).trim();
  } else {
    // Abstract methods end with ;
    sig = node.text.replace(/;$/, "").trim();
  }

  // The sig already includes modifiers/annotations from the node text,
  // so we don't need to prepend them separately
  return sig;
}
