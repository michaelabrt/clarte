import { withParsedTree } from "./init.js";
import type { Language } from "../types/detection.js";
import type { Node } from "web-tree-sitter";

/** Single-pass descendantsOfType for multiple node types. */
function collectNames(root: Node, types: string[], minLen = 2): string[] {
  const names: string[] = [];
  for (const node of root.descendantsOfType(types)) {
    const name = node.childForFieldName("name")?.text;
    if (name && name.length >= minLen && !name.startsWith("_")) names.push(name);
  }
  return names;
}

function extractTsSymbols(root: Node): string[] {
  const names = collectNames(root, ["function_declaration", "method_definition", "class_declaration"]);

  // Top-level const arrow functions: export const foo = (...) => ...
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement" && node.type !== "lexical_declaration") continue;
    const decl = node.type === "export_statement" ? node.childForFieldName("declaration") : node;
    if (!decl || decl.type !== "lexical_declaration") continue;
    for (const declarator of decl.namedChildren) {
      if (declarator.type !== "variable_declarator") continue;
      const name = declarator.childForFieldName("name")?.text;
      const value = declarator.childForFieldName("value");
      if (
        name &&
        name.length > 1 &&
        value &&
        (value.type === "arrow_function" || value.type === "function_expression")
      ) {
        names.push(name);
      }
    }
  }

  // CommonJS exports: module.exports = { ... }, module.exports.foo = ..., exports.foo = ...
  for (const node of root.namedChildren) {
    if (node.type !== "expression_statement") continue;
    const expr = node.namedChildren[0];
    if (!expr || expr.type !== "assignment_expression") continue;

    const left = expr.childForFieldName("left");
    if (!left || left.type !== "member_expression") continue;

    const obj = left.childForFieldName("object");
    const prop = left.childForFieldName("property");
    if (!obj || !prop) continue;

    if (obj.type === "identifier" && obj.text === "module" && prop.text === "exports") {
      // module.exports = { foo, bar } or module.exports = { foo: fn }
      const right = expr.childForFieldName("right");
      if (right?.type === "object") {
        for (const child of right.namedChildren) {
          if (child.type === "shorthand_property_identifier") {
            if (child.text.length > 1) names.push(child.text);
          } else if (child.type === "pair") {
            const key = child.childForFieldName("key");
            if (key && (key.type === "property_identifier" || key.type === "string") && key.text.length > 1) {
              names.push(key.text);
            }
          }
        }
      }
    } else if (obj.type === "member_expression") {
      // module.exports.foo = ...
      const innerObj = obj.childForFieldName("object");
      const innerProp = obj.childForFieldName("property");
      if (innerObj?.type === "identifier" && innerObj.text === "module" && innerProp?.text === "exports") {
        if (prop.type === "property_identifier" && prop.text.length > 1) {
          names.push(prop.text);
        }
      }
    } else if (obj.type === "identifier" && obj.text === "exports") {
      // exports.foo = ...
      if (prop.type === "property_identifier" && prop.text.length > 1) {
        names.push(prop.text);
      }
    }
  }

  return names;
}

function extractPythonSymbols(root: Node): string[] {
  // decorated_definition wraps function/class with @decorator; the inner
  // definition's name is extracted by collectNames via the "name" field.
  return collectNames(root, ["function_definition", "class_definition", "decorated_definition"]);
}

function extractGoSymbols(root: Node): string[] {
  // Go allows single-char exported names (e.g., interface T, type R)
  const names = collectNames(root, ["function_declaration", "method_declaration", "type_spec"], 1);
  // Extract receiver types from method declarations
  for (const node of root.descendantsOfType(["method_declaration"])) {
    const params = node.childForFieldName("parameters");
    if (params) {
      const firstParam = params.namedChildren[0];
      if (firstParam) {
        const typeNode = firstParam.childForFieldName("type");
        const typeName = typeNode?.type === "pointer_type" ? typeNode.namedChildren[0]?.text : typeNode?.text;
        if (typeName && typeName.length >= 1 && !typeName.startsWith("_") && !names.includes(typeName)) {
          names.push(typeName);
        }
      }
    }
  }
  return names;
}

function extractRustSymbols(root: Node): string[] {
  return collectNames(root, ["function_item", "struct_item", "enum_item", "trait_item"]);
}

function extractJavaSymbols(root: Node): string[] {
  return collectNames(root, ["method_declaration", "class_declaration", "interface_declaration"]);
}

/** Extract symbol names from an already-parsed tree-sitter root node. */
export function extractSymbolNamesFromRoot(root: Node, language: Language): string[] {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsSymbols(root);
    case "python":
      return extractPythonSymbols(root);
    case "go":
      return extractGoSymbols(root);
    case "rust":
      return extractRustSymbols(root);
    case "java":
      return extractJavaSymbols(root);
    default:
      return [];
  }
}

/**
 * Extract all function, method and class names from a source file.
 * Returns raw identifier names (not tokenized).
 */
export function extractSymbolNames(content: string, language: Language, filePath?: string): string[] {
  try {
    return withParsedTree(content, language, filePath, (root) => extractSymbolNamesFromRoot(root, language));
  } catch {
    return [];
  }
}

// ── Body token extraction ────────────────────────────────────────────────────
// Extracts deduped identifier tokens from function bodies for symbol-level BM25.
// No stop words: tree-sitter identifiers are already meaningful (not keywords).
// IDF handles corpus-wide frequency discrimination.

/** CamelCase split + lowercase + length filter. No stop words. */
export function tokenizeBody(id: string): string[] {
  const tokens: string[] = [];
  for (const part of id.split(/[^a-zA-Z0-9]+/).filter(Boolean)) {
    for (const seg of part
      .replace(/([a-z])([A-Z])/g, "$1\0$2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1\0$2")
      .split("\0")) {
      const lower = seg.toLowerCase();
      if (lower.length >= 2) tokens.push(lower);
    }
  }
  return tokens;
}

/** Identifier node types to collect from function bodies (per language). */
const TS_BODY_IDENT_TYPES = [
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "string_fragment",
  "template_string",
];

const PY_BODY_IDENT_TYPES = ["identifier"];

const GO_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];

const RUST_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];

const JAVA_BODY_IDENT_TYPES = ["identifier", "type_identifier"];

/**
 * Function node types that have a direct `name` field.
 * Used for TS/JS body/line/call extraction.
 */
const TS_NAMED_FN_TYPES = [
  "function_declaration",
  "generator_function_declaration",
  "method_definition",
  "class_declaration",
];

/**
 * Function expression types where the name comes from the parent
 * (variable_declarator or assignment_expression).
 */
const TS_EXPR_FN_TYPES = ["arrow_function", "function", "function_expression", "generator_function"];

// ── Local helpers (duplicated from build-call-graph.ts to avoid heavy import chain) ──

function extractCalleeName(node: Node): string | null {
  switch (node.type) {
    case "identifier":
      return node.text;
    case "property_identifier":
      return node.text;
    case "member_expression": {
      const prop = node.childForFieldName("property");
      return prop?.text ?? null;
    }
    default:
      return null;
  }
}

function getEnclosingFnName(node: Node): string {
  let current: Node | null = node.parent;
  while (current) {
    switch (current.type) {
      case "function_declaration":
      case "generator_function_declaration": {
        return current.childForFieldName("name")?.text ?? "";
      }
      case "method_definition": {
        return current.childForFieldName("name")?.text ?? "";
      }
      case "arrow_function":
      case "function":
      case "function_expression":
      case "generator_function": {
        const parent = current.parent;
        if (parent?.type === "variable_declarator") {
          return parent.childForFieldName("name")?.text ?? "";
        }
        if (parent?.type === "assignment_expression") {
          const left = parent.childForFieldName("left");
          return left?.type === "identifier" ? (left.text ?? "") : "";
        }
        return "";
      }
    }
    current = current.parent;
  }
  return "";
}

/**
 * Get the name of a named function node (function_declaration, method_definition, etc.).
 * Filters computed property names (I4) and names starting with _.
 */
function getFnNodeName(node: Node): string | null {
  const nameNode = node.childForFieldName("name");
  if (!nameNode) return null;
  // Filter computed property names like [Symbol.iterator]()
  if (nameNode.type === "computed_property_name") return null;
  const name = nameNode.text;
  if (!name || name.length <= 1 || name.startsWith("_")) return null;
  return name;
}

/**
 * Get the name of a function expression/arrow assigned to a variable or property.
 */
function getExprFnName(node: Node): string | null {
  const parent = node.parent;
  if (parent?.type === "variable_declarator") {
    const name = parent.childForFieldName("name")?.text;
    if (name && name.length > 1 && !name.startsWith("_")) return name;
  }
  if (parent?.type === "assignment_expression") {
    const left = parent.childForFieldName("left");
    if (left?.type === "identifier") {
      const name = left.text;
      if (name && name.length > 1 && !name.startsWith("_")) return name;
    }
  }
  return null;
}

/**
 * Collect deduped body tokens from descendant identifier nodes.
 * Includes string_fragment with length 4-60 (S4).
 */
function collectBodyTokens(bodyNodes: Node[], identTypes: string[]): string[] {
  const tokenSet = new Set<string>();
  for (const bodyNode of bodyNodes) {
    for (const ident of bodyNode.descendantsOfType(identTypes)) {
      const text = ident.text;
      // S4: string_fragment length filter
      if (ident.type === "string_fragment") {
        if (text.length < 4 || text.length > 60) continue;
      }
      for (const tok of tokenizeBody(text)) {
        tokenSet.add(tok);
      }
    }
  }
  return [...tokenSet];
}

// ── TS/JS body extraction ────────────────────────────────────────────────────

function extractTsBodies(root: Node): Map<string, string[]> {
  const result = new Map<string, string[]>();

  // Named function types (function_declaration, method_definition, class_declaration, etc.)
  for (const node of root.descendantsOfType(TS_NAMED_FN_TYPES)) {
    const name = getFnNodeName(node);
    if (!name) continue;

    if (node.type === "class_declaration") {
      // Collect tokens from all method bodies within the class
      const bodyNodes: Node[] = [];
      const classBody = node.childForFieldName("body");
      if (classBody) {
        for (const member of classBody.descendantsOfType(["method_definition"])) {
          const mb = member.childForFieldName("body");
          if (mb) bodyNodes.push(mb);
          // S5: parameter/return type annotations
          const params = member.childForFieldName("parameters");
          if (params) bodyNodes.push(params);
          const retType = member.childForFieldName("return_type");
          if (retType) bodyNodes.push(retType);
        }
      }
      if (bodyNodes.length > 0) {
        result.set(name, collectBodyTokens(bodyNodes, TS_BODY_IDENT_TYPES));
      }
      continue;
    }

    // Regular function/method
    const bodyNodes: Node[] = [];
    const body = node.childForFieldName("body");
    if (body) bodyNodes.push(body);
    // S5: parameter/return type annotations
    const params = node.childForFieldName("parameters");
    if (params) bodyNodes.push(params);
    const retType = node.childForFieldName("return_type");
    if (retType) bodyNodes.push(retType);

    if (bodyNodes.length > 0) {
      result.set(name, collectBodyTokens(bodyNodes, TS_BODY_IDENT_TYPES));
    }
  }

  // Expression function types (arrow_function, function, function_expression, generator_function)
  for (const node of root.descendantsOfType(TS_EXPR_FN_TYPES)) {
    const name = getExprFnName(node);
    if (!name) continue;
    if (result.has(name)) continue; // Already captured via named type

    const bodyNodes: Node[] = [];
    const body = node.childForFieldName("body");
    if (body) bodyNodes.push(body);
    const params = node.childForFieldName("parameters");
    if (params) bodyNodes.push(params);
    const retType = node.childForFieldName("return_type");
    if (retType) bodyNodes.push(retType);

    if (bodyNodes.length > 0) {
      result.set(name, collectBodyTokens(bodyNodes, TS_BODY_IDENT_TYPES));
    }
  }

  return result;
}

function extractGenericBodies(root: Node, fnTypes: string[], identTypes: string[]): Map<string, string[]> {
  const result = new Map<string, string[]>();
  for (const node of root.descendantsOfType(fnTypes)) {
    const name = getFnNodeName(node);
    if (!name) continue;

    const bodyNodes: Node[] = [];
    const body = node.childForFieldName("body");
    if (body) bodyNodes.push(body);
    const params = node.childForFieldName("parameters");
    if (params) bodyNodes.push(params);
    const retType = node.childForFieldName("return_type");
    if (retType) bodyNodes.push(retType);

    if (bodyNodes.length > 0) {
      result.set(name, collectBodyTokens(bodyNodes, identTypes));
    }
  }
  return result;
}

/** Extract deduped body tokens per symbol from a parsed AST root. */
export function extractSymbolBodiesFromRoot(root: Node, language: Language): Map<string, string[]> {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsBodies(root);
    case "python":
      return extractGenericBodies(root, ["function_definition", "class_definition"], PY_BODY_IDENT_TYPES);
    case "go":
      return extractGenericBodies(root, ["function_declaration", "method_declaration"], GO_BODY_IDENT_TYPES);
    case "rust":
      return extractGenericBodies(root, ["function_item"], RUST_BODY_IDENT_TYPES);
    case "java":
      return extractGenericBodies(root, ["method_declaration", "class_declaration"], JAVA_BODY_IDENT_TYPES);
    default:
      return new Map();
  }
}

// ── Start line extraction ────────────────────────────────────────────────────

function extractTsStartLines(root: Node): Map<string, number> {
  const result = new Map<string, number>();

  for (const node of root.descendantsOfType(TS_NAMED_FN_TYPES)) {
    const name = getFnNodeName(node);
    if (name && !result.has(name)) {
      result.set(name, node.startPosition.row + 1);
    }
  }

  for (const node of root.descendantsOfType(TS_EXPR_FN_TYPES)) {
    const name = getExprFnName(node);
    if (name && !result.has(name)) {
      result.set(name, node.startPosition.row + 1);
    }
  }

  return result;
}

function extractGenericStartLines(root: Node, fnTypes: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const node of root.descendantsOfType(fnTypes)) {
    const name = getFnNodeName(node);
    if (name && !result.has(name)) {
      result.set(name, node.startPosition.row + 1);
    }
  }
  return result;
}

/** Extract 1-based start line per symbol from a parsed AST root. */
export function extractSymbolStartLines(root: Node, language: Language): Map<string, number> {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsStartLines(root);
    case "python":
      return extractGenericStartLines(root, ["function_definition", "class_definition"]);
    case "go":
      return extractGenericStartLines(root, ["function_declaration", "method_declaration", "type_spec"]);
    case "rust":
      return extractGenericStartLines(root, ["function_item", "struct_item", "enum_item", "trait_item"]);
    case "java":
      return extractGenericStartLines(root, ["method_declaration", "class_declaration", "interface_declaration"]);
    default:
      return new Map();
  }
}

// ── Intra-file call extraction ───────────────────────────────────────────────

function extractTsIntraFileCalls(root: Node, symbolNames: Set<string>): Array<{ caller: string; callee: string }> {
  const edges: Array<{ caller: string; callee: string }> = [];

  function processCallNode(node: Node, calleeNode: Node | undefined): void {
    if (!calleeNode) return;
    const callee = extractCalleeName(calleeNode);
    if (!callee || !symbolNames.has(callee)) return;

    const caller = getEnclosingFnName(node);
    if (!caller || !symbolNames.has(caller) || caller === callee) return;

    edges.push({ caller, callee });
  }

  for (const call of root.descendantsOfType("call_expression")) {
    processCallNode(call, call.childForFieldName("function") ?? undefined);
  }

  for (const newExpr of root.descendantsOfType("new_expression")) {
    processCallNode(newExpr, newExpr.childForFieldName("constructor") ?? undefined);
  }

  // Deduplicate edges
  const seen = new Set<string>();
  return edges.filter((e) => {
    const key = `${e.caller}->${e.callee}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Extract intra-file caller→callee edges where both ends are known symbols. */
export function extractIntraFileCalls(
  root: Node,
  language: Language,
  symbolNames: Set<string>,
): Array<{ caller: string; callee: string }> {
  switch (language) {
    case "typescript":
    case "javascript":
      return extractTsIntraFileCalls(root, symbolNames);
    default:
      // Other languages: same approach with call_expression only
      return extractTsIntraFileCalls(root, symbolNames);
  }
}
