/**
 * Unified single-pass file graph extraction.
 *
 * One tree-sitter parse produces: imports, symbol definitions, call sites,
 * heritage chains, decorator edges and type usage edges.
 *
 * Per-language extractors share the same FileGraphResult shape.
 */

import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type { FileGraphResult, SymbolDefinition, TypeUsageEdge } from "../graph/symbol-types";
import type { Language } from "../types/detection";
import { tokenizeBody } from "./extract-symbols";
import { parseImportsAstFromRoot } from "./parse-imports";
import { extractTsFileGraph } from "./extract-ts";
import { extractPythonFileGraph } from "./extract-python";
import { extractGoFileGraph } from "./extract-go";
import { extractJavaFileGraph } from "./extract-java";
import { extractRustFileGraph } from "./extract-rust";

// ── Public API ────────────────────────────────────────────────────────────────

export function extractFileGraph(root: Node, language: Language): FileGraphResult {
  const imports = parseImportsAstFromRoot(root, language);

  switch (language) {
    case "typescript":
    case "javascript":
      return { imports, ...extractTsFileGraph(root) };
    case "python":
      return { imports, ...extractPythonFileGraph(root) };
    case "go":
      return { imports, ...extractGoFileGraph(root) };
    case "java":
      return { imports, ...extractJavaFileGraph(root) };
    case "rust":
      return { imports, ...extractRustFileGraph(root) };
    default:
      return {
        imports,
        symbols: [],
        callSites: [],
        heritageChains: [],
        decorators: [],
        typeUsages: [],
        constructorAssignments: [],
        embeddings: [],
        implBlocks: [],
        typeAliases: [],
        semanticEdges: [],
      };
  }
}

// ── Shared helpers (used by per-language extractors) ──────────────────────────

export function hashBody(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

export function bodyTokenString(bodyNode: Node | null, identTypes: string[]): string {
  if (!bodyNode) return "";
  const tokenSet = new Set<string>();
  for (const ident of bodyNode.descendantsOfType(identTypes)) {
    const text = ident.text;
    if (ident.type === "string_fragment" && (text.length < 4 || text.length > 60)) continue;
    for (const tok of tokenizeBody(text)) tokenSet.add(tok);
  }
  const tokens = [...tokenSet];
  return tokens.slice(0, 200).join(" ");
}

export function getNodeText(node: Node): string {
  return node.text ?? "";
}

/**
 * Walk up the AST to find the enclosing function name.
 * Works across all languages by accepting the set of node types that represent
 * functions and the set of types that hold named arrow/function expressions.
 */
export function getEnclosingFunction(node: Node, fnTypes: string[], exprTypes?: string[]): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    if (fnTypes.includes(current.type)) {
      const name = current.childForFieldName("name")?.text;
      return name && name.length > 1 ? name : undefined;
    }
    if (exprTypes?.includes(current.type)) {
      const parent = current.parent;
      if (parent?.type === "variable_declarator") {
        const name = parent.childForFieldName("name")?.text;
        return name && name.length > 1 ? name : undefined;
      }
      if (parent?.type === "assignment_expression") {
        const left = parent.childForFieldName("left");
        if (left?.type === "identifier") {
          const name = left.text;
          return name && name.length > 1 ? name : undefined;
        }
      }
      return undefined;
    }
    current = current.parent;
  }
  return undefined;
}

/**
 * Check if a symbol has already been processed. If not, marks it as seen.
 * Returns true if the symbol is a duplicate.
 */
export function isDuplicateSymbol(seen: Set<string>, name: string, startRow: number): boolean {
  const key = `${name}:${startRow}`;
  if (seen.has(key)) return true;
  seen.add(key);
  return false;
}

/**
 * Extract type usages from AST type nodes, filtering primitives and deduplicating.
 * Shared across TS, Go and Rust extractors.
 */
export function extractTypeUsagesFromNodes(
  typeNodes: Node[],
  symbolName: string,
  isPrimitive: (name: string) => boolean,
  out: TypeUsageEdge[],
  resolveGeneric?: (node: Node) => string | null,
): void {
  const seen = new Set<string>();
  for (const tn of typeNodes) {
    const typeName = resolveGeneric ? (resolveGeneric(tn) ?? tn.text) : tn.text;
    if (!typeName || typeName.length <= 1 || seen.has(typeName)) continue;
    if (isPrimitive(typeName)) continue;
    seen.add(typeName);
    out.push({ symbolName, typeName, line: tn.startPosition.row + 1 });
  }
}

// ── Primitive type sets ──────────────────────────────────────────────────────

const TS_PRIMITIVES = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "null",
  "undefined",
  "never",
  "any",
  "unknown",
  "object",
]);

const GO_PRIMITIVES = new Set([
  "int",
  "int8",
  "int16",
  "int32",
  "int64",
  "uint",
  "uint8",
  "uint16",
  "uint32",
  "uint64",
  "float32",
  "float64",
  "complex64",
  "complex128",
  "string",
  "bool",
  "byte",
  "rune",
  "error",
  "uintptr",
  "any",
]);

const RUST_PRIMITIVES = new Set([
  "i8",
  "i16",
  "i32",
  "i64",
  "i128",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "u128",
  "usize",
  "f32",
  "f64",
  "bool",
  "char",
  "str",
  "String",
  "Self",
  "Option",
  "Result",
  "Vec",
  "Box",
]);

export function isTsPrimitive(name: string): boolean {
  return TS_PRIMITIVES.has(name);
}

export function isGoPrimitive(name: string): boolean {
  return GO_PRIMITIVES.has(name);
}

export function isRustPrimitive(name: string): boolean {
  return RUST_PRIMITIVES.has(name);
}

/**
 * Build a SymbolDefinition from common extraction fields.
 */
export function buildSymbol(
  name: string,
  kind: SymbolDefinition["kind"],
  node: Node,
  bodyNode: Node | null,
  identTypes: string[],
  isExported: boolean,
): SymbolDefinition {
  const bodyText = bodyNode ? getNodeText(bodyNode) : getNodeText(node);
  const tokens = bodyTokenString(bodyNode ?? node, identTypes);
  return {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
    bodyTokens: tokens,
    bodyHash: hashBody(bodyText),
    isExported,
  };
}
