import type { Node } from "web-tree-sitter";
import type { SnapshotEntry } from "../types.js";

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
        const block = extractJavaBlock(node, content);
        entries.push({ file: relPath, category: "interface", signature: block });
        break;
      }
      case "enum_declaration": {
        const block = extractJavaBlock(node, content);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }
      case "record_declaration": {
        const sig = extractJavaRecordSig(node, content);
        entries.push({ file: relPath, category: "type", signature: sig });
        break;
      }
      case "class_declaration": {
        // Extract class header
        const header = extractJavaClassHeader(node, content);
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
  return modifiers.namedChildren.some(
    (c) => (c.type === "marker_annotation" || c.type === "annotation") && c.text.includes(name),
  );
}

function extractJavaBlock(node: Node, content: string): string {
  // Include annotations from modifiers
  const text = node.text.split("\n").map((l) => l.trimStart());
  if (text.length > 30) return text.slice(0, 30).join("\n").trim();
  return text.join("\n").trim();
}

function extractJavaClassHeader(node: Node, content: string): string {
  const body = node.childForFieldName("body");
  if (body) {
    return content.slice(node.startIndex, body.startIndex).trim();
  }
  return node.text.split("{")[0].trim();
}

function extractJavaRecordSig(node: Node, content: string): string {
  const body = node.childForFieldName("body");
  if (body) {
    return content.slice(node.startIndex, body.startIndex).trim();
  }
  return node.text.split("{")[0].trim();
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
        const annName = c.text.replace(/^@/, "").split("(")[0];
        return JAVA_SIGNIFICANT_FIELD_ANNOTATIONS.has(annName);
      });
      if (hasSignificant) {
        entries.push({ file: relPath, category: "type", signature: child.text.trimStart() });
      }
    }
  }
}

function extractJavaMethodSig(node: Node): string {
  // Get annotations from modifiers
  const modifiers = node.namedChildren.find((c) => c.type === "modifiers");
  const annotations: string[] = [];
  if (modifiers) {
    for (const child of modifiers.namedChildren) {
      if (child.type === "marker_annotation" || child.type === "annotation") {
        annotations.push(child.text);
      }
    }
  }

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
