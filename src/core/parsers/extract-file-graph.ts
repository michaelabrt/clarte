/**
 * Unified single-pass file graph extraction (RFC §2.1-2.3).
 *
 * One tree-sitter parse produces: imports, symbol definitions, call sites,
 * heritage chains, decorator edges and type usage edges.
 *
 * Per-language extractors share the same FileGraphResult shape.
 */

import { createHash } from "node:crypto";
import type { Node } from "web-tree-sitter";
import type {
  ConstructorAssignment,
  DecoratorEdge,
  EmbeddingEdge,
  FileGraphResult,
  HeritageEdge,
  ImplBlock,
  RawCallSite,
  SymbolDefinition,
  SymbolKind,
  SemanticEdge,
  TypeAlias,
  TypeUsageEdge,
} from "../graph/symbol-types";
import type { Language } from "../types/detection";
import { tokenizeBody } from "./extract-symbols";
import { parseImportsAstFromRoot } from "./parse-imports";

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

// ── Shared helpers ────────────────────────────────────────────────────────────

function hashBody(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 16);
}

function bodyTokenString(bodyNode: Node | null, identTypes: string[]): string {
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

function getNodeText(node: Node): string {
  return node.text ?? "";
}

// ── TS/JS extraction ──────────────────────────────────────────────────────────

const TS_BODY_IDENT_TYPES = [
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "string_fragment",
  "template_string",
];

interface TsExtraction {
  symbols: SymbolDefinition[];
  callSites: RawCallSite[];
  heritageChains: HeritageEdge[];
  decorators: DecoratorEdge[];
  typeUsages: TypeUsageEdge[];
  constructorAssignments: ConstructorAssignment[];
  embeddings: EmbeddingEdge[];
  implBlocks: ImplBlock[];
  typeAliases: TypeAlias[];
  semanticEdges: SemanticEdge[];
}

function extractTsFileGraph(root: Node): TsExtraction {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const typeUsages: TypeUsageEdge[] = [];
  const seenSymbols = new Set<string>();

  // Track export context for top-level symbols
  const exportedNames = collectTsExportedNames(root);

  // Extract symbols, heritage, decorators from top-level and nested declarations
  extractTsSymbols(root, symbols, heritageChains, decorators, typeUsages, seenSymbols, exportedNames);

  // Extract call sites with member expression info
  extractTsCallSites(root, callSites);

  // Extract constructor assignments for Tier 3 resolution (RFC §2.6)
  const constructorAssignments = extractTsConstructorAssignments(root);

  // Extract type aliases (RFC §2.15): type Foo = Bar
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_alias_declaration"])) {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    const aliasName = nameNode.text;
    // Only follow aliases to identifiers (project-internal types), not complex types
    const target =
      valueNode.type === "type_identifier"
        ? valueNode.text
        : valueNode.type === "generic_type"
          ? (valueNode.childForFieldName("name")?.text ?? null)
          : null;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({
        name: aliasName,
        target,
        line: node.startPosition.row + 1,
      });
    }
  }

  return {
    symbols,
    callSites,
    heritageChains,
    decorators,
    typeUsages,
    constructorAssignments,
    embeddings: [],
    implBlocks: [],
    typeAliases,
    semanticEdges: [],
  };
}

function collectTsExportedNames(root: Node): Set<string> {
  const exported = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;
    const decl = node.childForFieldName("declaration");
    if (decl) {
      const name = decl.childForFieldName("name")?.text;
      if (name) exported.add(name);
      // export const foo = ...
      if (decl.type === "lexical_declaration") {
        for (const d of decl.namedChildren) {
          if (d.type === "variable_declarator") {
            const vn = d.childForFieldName("name")?.text;
            if (vn) exported.add(vn);
          }
        }
      }
    }
    // export { name1, name2 }
    const clause = node.namedChildren.find((c) => c.type === "export_clause");
    if (clause) {
      for (const spec of clause.namedChildren) {
        if (spec.type === "export_specifier") {
          const n = spec.childForFieldName("name")?.text;
          if (n) exported.add(n);
        }
      }
    }
  }
  return exported;
}

function extractTsSymbols(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  decorators: DecoratorEdge[],
  typeUsages: TypeUsageEdge[],
  seenSymbols: Set<string>,
  exportedNames: Set<string>,
): void {
  const namedFnTypes = [
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "class_declaration",
    "interface_declaration",
    "type_alias_declaration",
  ];
  const exprFnTypes = ["arrow_function", "function", "function_expression", "generator_function"];

  // Named declarations
  for (const node of root.descendantsOfType(namedFnTypes)) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode || nameNode.type === "computed_property_name") continue;
    const name = nameNode.text;
    if (!name || name.length <= 1 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const kind = inferTsKind(node, root);
    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, TS_BODY_IDENT_TYPES);
    const isExported = exportedNames.has(name) || isExportedNode(node);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
    });

    // Heritage chains from class/interface declarations
    if (node.type === "class_declaration") {
      extractTsHeritage(node, name, heritageChains);
      extractTsClassDecorators(node, name, decorators);
    }
    if (node.type === "interface_declaration") {
      extractTsInterfaceHeritage(node, name, heritageChains);
    }

    // Type usages from function signatures
    if (node.type === "function_declaration" || node.type === "method_definition") {
      extractTsTypeUsages(node, name, typeUsages);
    }
  }

  // Arrow/function expressions assigned to named variables
  for (const node of root.descendantsOfType(exprFnTypes)) {
    const parent = node.parent;
    let name: string | undefined;
    if (parent?.type === "variable_declarator") {
      name = parent.childForFieldName("name")?.text;
    } else if (parent?.type === "assignment_expression") {
      const left = parent.childForFieldName("left");
      if (left?.type === "identifier") name = left.text;
    }
    if (!name || name.length <= 1 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, TS_BODY_IDENT_TYPES);
    const kind = detectJsxComponent(body) ? "component" : "function";
    const isExported = exportedNames.has(name) || isExportedNode(node);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
    });

    // Type usages from arrow function signatures
    extractTsTypeUsages(node, name, typeUsages);
  }
}

function inferTsKind(node: Node, _root: Node): SymbolKind {
  switch (node.type) {
    case "class_declaration":
      return "class";
    case "interface_declaration":
      return "interface";
    case "type_alias_declaration":
      return "type";
    case "method_definition":
      return "method";
    case "function_declaration":
    case "generator_function_declaration": {
      const body = node.childForFieldName("body");
      if (body && detectJsxComponent(body)) return "component";
      return "function";
    }
    default:
      return "function";
  }
}

function detectJsxComponent(body: Node | null): boolean {
  if (!body) return false;
  const jsxTypes = ["jsx_element", "jsx_self_closing_element", "jsx_fragment"];
  for (const t of jsxTypes) {
    if (body.descendantsOfType(t).length > 0) return true;
  }
  return false;
}

function isExportedNode(node: Node): boolean {
  let p = node.parent;
  // Walk up through variable_declarator → lexical_declaration → export_statement
  while (p) {
    if (p.type === "export_statement") return true;
    if (p.type === "variable_declarator" || p.type === "lexical_declaration") {
      p = p.parent;
      continue;
    }
    break;
  }
  return false;
}

function extractTsHeritage(classNode: Node, className: string, out: HeritageEdge[]): void {
  // class Foo extends Bar implements IBaz, IQux
  for (const child of classNode.namedChildren) {
    if (child.type === "class_heritage") {
      for (const clause of child.namedChildren) {
        if (clause.type !== "extends_clause" && clause.type !== "implements_clause") continue;
        // extends_clause / implements_clause can appear as direct children too
        const kind: "extends" | "implements" = clause.type === "extends_clause" ? "extends" : "implements";
        for (const typeNode of clause.namedChildren) {
          const target = extractTypeName(typeNode);
          if (target) {
            out.push({
              className,
              kind,
              target,
              line: clause.startPosition.row + 1,
            });
          }
        }
      }
      continue;
    }
    // Some tree-sitter versions put extends_clause / implements_clause directly on the class
    if (child.type === "extends_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target)
          out.push({
            className,
            kind: "extends",
            target,
            line: child.startPosition.row + 1,
          });
      }
    }
    if (child.type === "implements_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target)
          out.push({
            className,
            kind: "implements",
            target,
            line: child.startPosition.row + 1,
          });
      }
    }
  }
}

function extractTsInterfaceHeritage(ifaceNode: Node, name: string, out: HeritageEdge[]): void {
  // interface Foo extends Bar, Baz
  for (const child of ifaceNode.namedChildren) {
    if (child.type === "extends_type_clause" || child.type === "extends_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target)
          out.push({
            className: name,
            kind: "extends",
            target,
            line: child.startPosition.row + 1,
          });
      }
    }
  }
}

function extractTypeName(node: Node): string | null {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  // GenericType: Foo<Bar>
  if (node.type === "generic_type") {
    const nameNode = node.childForFieldName("name");
    return nameNode?.text ?? null;
  }
  // member_expression: ns.Type
  if (node.type === "member_expression" || node.type === "nested_type_identifier") {
    const right = node.childForFieldName("property") ?? node.namedChildren[node.namedChildren.length - 1];
    return right?.text ?? null;
  }
  return null;
}

function extractTsClassDecorators(classNode: Node, className: string, out: DecoratorEdge[]): void {
  // Check parent for decorator (decorated class)
  const parent = classNode.parent;
  if (parent?.type === "export_statement") {
    extractDecoratorsFromSiblings(parent, className, out);
  }
  extractDecoratorsFromSiblings(classNode, className, out);

  // Method decorators
  const body = classNode.childForFieldName("body");
  if (!body) return;
  for (const member of body.namedChildren) {
    if (member.type !== "method_definition") continue;
    const methodName = member.childForFieldName("name")?.text;
    if (!methodName) continue;
    for (const child of member.namedChildren) {
      if (child.type === "decorator") {
        const decoratorName = extractDecoratorName(child);
        if (decoratorName) {
          out.push({
            target: methodName,
            decorator: decoratorName,
            line: child.startPosition.row + 1,
          });
        }
      }
    }
  }
}

function extractDecoratorsFromSiblings(node: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "decorator") {
      const decoratorName = extractDecoratorName(child);
      if (decoratorName) {
        out.push({
          target: targetName,
          decorator: decoratorName,
          line: child.startPosition.row + 1,
        });
      }
    }
  }
}

function extractDecoratorName(decoratorNode: Node): string | null {
  // @Decorator or @Decorator() or @module.Decorator
  for (const child of decoratorNode.namedChildren) {
    if (child.type === "identifier") return child.text;
    if (child.type === "call_expression") {
      const fn = child.childForFieldName("function");
      if (fn?.type === "identifier") return fn.text;
      if (fn?.type === "member_expression") {
        return fn.childForFieldName("property")?.text ?? null;
      }
    }
    if (child.type === "member_expression") {
      return child.childForFieldName("property")?.text ?? null;
    }
  }
  return null;
}

function extractTsTypeUsages(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
  const params = fnNode.childForFieldName("parameters");
  const retType = fnNode.childForFieldName("return_type");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier", "generic_type"]));
  if (retType) typeNodes.push(...retType.descendantsOfType(["type_identifier", "generic_type"]));

  const seen = new Set<string>();
  for (const tn of typeNodes) {
    const typeName = tn.type === "generic_type" ? (tn.childForFieldName("name")?.text ?? null) : tn.text;
    if (!typeName || typeName.length <= 1 || seen.has(typeName)) continue;
    // Skip primitive types
    if (isPrimitiveType(typeName)) continue;
    seen.add(typeName);
    out.push({ symbolName, typeName, line: tn.startPosition.row + 1 });
  }
}

function isPrimitiveType(name: string): boolean {
  return ["string", "number", "boolean", "void", "null", "undefined", "never", "any", "unknown", "object"].includes(
    name,
  );
}

function extractTsCallSites(root: Node, out: RawCallSite[]): void {
  // call_expression nodes
  for (const call of root.descendantsOfType("call_expression")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    const site = parseTsCallExpression(fnNode, call);
    if (site) out.push(site);
  }

  // new_expression nodes
  for (const newExpr of root.descendantsOfType("new_expression")) {
    const ctorNode = newExpr.childForFieldName("constructor");
    if (!ctorNode) continue;

    const name = ctorNode.type === "identifier" ? ctorNode.text : null;
    if (!name || name.length <= 1) continue;

    out.push({
      callerFn: getEnclosingFn(newExpr),
      calleeName: name,
      line: newExpr.startPosition.row + 1,
      isMemberExpression: false,
      objectName: undefined,
      isConstructor: true,
    });
  }
}

/**
 * Extract variable-to-constructor assignments for Tier 3 resolution (RFC §2.6).
 * Detects `const svc = new UserService()` and `svc = new UserService()` patterns.
 * Keyed by variable name so the resolution engine can match callSite.objectName.
 */
function extractTsConstructorAssignments(root: Node): ConstructorAssignment[] {
  const assignments: ConstructorAssignment[] = [];

  for (const newExpr of root.descendantsOfType("new_expression")) {
    const ctorNode = newExpr.childForFieldName("constructor");
    if (!ctorNode || ctorNode.type !== "identifier") continue;
    const className = ctorNode.text;
    if (!className || className.length <= 1) continue;

    const line = newExpr.startPosition.row + 1;
    const callerFn = getEnclosingFn(newExpr);
    const parent = newExpr.parent;

    if (parent?.type === "variable_declarator") {
      // const svc = new UserService()
      const nameNode = parent.childForFieldName("name");
      if (nameNode?.type === "identifier") {
        const varName = nameNode.text;
        if (varName && varName.length > 1) {
          assignments.push({
            variableName: varName,
            className,
            callerFn,
            line,
          });
        }
      }
    } else if (parent?.type === "assignment_expression") {
      // svc = new UserService()
      const left = parent.childForFieldName("left");
      if (left?.type === "identifier") {
        const varName = left.text;
        if (varName && varName.length > 1) {
          assignments.push({
            variableName: varName,
            className,
            callerFn,
            line,
          });
        }
      }
    }
  }

  return assignments;
}

function parseTsCallExpression(fnNode: Node, callNode: Node): RawCallSite | null {
  if (fnNode.type === "identifier") {
    const name = fnNode.text;
    if (!name || name.length <= 1) return null;
    return {
      callerFn: getEnclosingFn(callNode),
      calleeName: name,
      line: callNode.startPosition.row + 1,
      isMemberExpression: false,
      objectName: undefined,
      isConstructor: false,
    };
  }

  if (fnNode.type === "member_expression") {
    const obj = fnNode.childForFieldName("object");
    const prop = fnNode.childForFieldName("property");
    if (!prop || !obj) return null;
    const calleeName = prop.text;
    const objectName = obj.type === "identifier" ? obj.text : undefined;
    if (!calleeName || calleeName.length <= 1) return null;
    return {
      callerFn: getEnclosingFn(callNode),
      calleeName,
      line: callNode.startPosition.row + 1,
      isMemberExpression: true,
      objectName,
      isConstructor: false,
    };
  }

  return null;
}

function getEnclosingFn(node: Node): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    switch (current.type) {
      case "function_declaration":
      case "generator_function_declaration":
      case "method_definition": {
        const name = current.childForFieldName("name")?.text;
        return name && name.length > 1 ? name : undefined;
      }
      case "arrow_function":
      case "function":
      case "function_expression":
      case "generator_function": {
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
    }
    current = current.parent;
  }
  return undefined;
}

// ── Python extraction ─────────────────────────────────────────────────────────

const PY_BODY_IDENT_TYPES = ["identifier"];

function extractPythonFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const typeUsages: TypeUsageEdge[] = [];
  const seenSymbols = new Set<string>();

  // Functions and classes at module level
  for (const node of root.descendantsOfType(["function_definition", "class_definition", "decorated_definition"])) {
    const actual = node.type === "decorated_definition" ? unwrapDecorated(node) : node;
    if (!actual) continue;

    const name = actual.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;

    const key = `${name}:${actual.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const isMethod = isInsidePythonClass(actual);
    const kind: SymbolKind = actual.type === "class_definition" ? "class" : isMethod ? "method" : "function";
    const body = actual.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(actual);
    const tokens = bodyTokenString(body ?? actual, PY_BODY_IDENT_TYPES);

    symbols.push({
      name,
      kind,
      startLine: actual.startPosition.row + 1,
      endLine: actual.endPosition ? actual.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: !name.startsWith("_"),
    });

    // Python heritage: class Foo(Bar, Baz, metaclass=Meta)
    if (actual.type === "class_definition") {
      const { bases, metaclass } = extractPythonHeritage(actual, name, heritageChains);
      if (bases.length > 0) {
        symbols[symbols.length - 1].bases = bases;
      }
      // [Hejlsberg] Separate metaclass from standard bases (RFC §2.12)
      if (metaclass) {
        symbols[symbols.length - 1].metaclass = metaclass;
      }
    }

    // Decorators
    if (node.type === "decorated_definition") {
      extractPythonDecorators(node, name, decorators);
    }
  }

  // Call sites
  for (const call of root.descendantsOfType("call")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    if (fnNode.type === "identifier") {
      const name = fnNode.text;
      if (name && name.length > 1) {
        callSites.push({
          callerFn: getPythonEnclosingFn(call),
          calleeName: name,
          line: call.startPosition.row + 1,
          isMemberExpression: false,
          objectName: undefined,
          isConstructor: false,
        });
      }
    } else if (fnNode.type === "attribute") {
      const obj = fnNode.childForFieldName("object");
      const attr = fnNode.childForFieldName("attribute");
      if (attr && obj) {
        // Detect super().method() pattern
        const isSuperCall = obj.type === "call" && obj.childForFieldName("function")?.text === "super";
        callSites.push({
          callerFn: getPythonEnclosingFn(call),
          calleeName: attr.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: isSuperCall ? "super" : obj.type === "identifier" ? obj.text : undefined,
          isConstructor: false,
          isSuperCall,
        });
      }
    }
  }

  // Python constructor assignments: obj = ClassName() (no `new` keyword)
  // Detect assignments where the RHS is a call to a capitalized name (class convention)
  const constructorAssignments: ConstructorAssignment[] = [];
  for (const node of root.descendantsOfType(["assignment", "expression_statement"])) {
    const assign = node.type === "assignment" ? node : null;
    if (!assign) continue;
    const left = assign.childForFieldName("left");
    const right = assign.childForFieldName("right");
    if (!left || !right || left.type !== "identifier" || right.type !== "call") continue;
    const fn = right.childForFieldName("function");
    if (!fn || fn.type !== "identifier") continue;
    const className = fn.text;
    const varName = left.text;
    // Python convention: class names are capitalized
    if (
      !className ||
      !varName ||
      className[0] !== className[0].toUpperCase() ||
      className[0] === className[0].toLowerCase()
    )
      continue;
    constructorAssignments.push({
      variableName: varName,
      className,
      callerFn: getPythonEnclosingFn(node),
      line: node.startPosition.row + 1,
    });
  }

  // F5: Python type alias extraction
  // Supports: type Foo = Bar (3.12+ type_alias_statement) and Foo: TypeAlias = Bar
  const typeAliases: TypeAlias[] = [];
  // Python 3.12+ syntax: type Foo = Bar
  for (const node of root.descendantsOfType(["type_alias_statement"])) {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    const aliasName = nameNode.text;
    const target = valueNode.type === "identifier" ? valueNode.text : null;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({
        name: aliasName,
        target,
        line: node.startPosition.row + 1,
      });
    }
  }
  // Pre-3.12 syntax: Foo: TypeAlias = Bar (annotated assignment at module scope)
  for (const node of root.descendantsOfType(["assignment"])) {
    // Must have a type annotation containing "TypeAlias"
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const typeAnnotation = node.childForFieldName("type");
    if (!left || !right || !typeAnnotation) continue;
    if (left.type !== "identifier" || right.type !== "identifier") continue;
    // Check if annotation text contains TypeAlias
    if (!typeAnnotation.text.includes("TypeAlias")) continue;
    const aliasName = left.text;
    const target = right.text;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({
        name: aliasName,
        target,
        line: node.startPosition.row + 1,
      });
    }
  }

  return {
    symbols,
    callSites,
    heritageChains,
    decorators,
    typeUsages,
    constructorAssignments,
    embeddings: [],
    implBlocks: [],
    typeAliases,
    semanticEdges: [],
  };
}

function unwrapDecorated(node: Node): Node | null {
  for (const child of node.namedChildren) {
    if (child.type === "function_definition" || child.type === "class_definition") return child;
  }
  return null;
}

function isInsidePythonClass(node: Node): boolean {
  let p = node.parent;
  while (p) {
    if (p.type === "class_definition") return true;
    if (p.type === "decorated_definition") {
      p = p.parent;
      continue;
    }
    break;
  }
  return false;
}

/**
 * Python heritage extraction supporting C3 MRO.
 * class Foo(Bar, Baz, metaclass=Meta) - extracts Bar and Baz as extends.
 * Multiple base classes reflect Python's multiple inheritance with C3 linearization.
 */
/**
 * [Hejlsberg] Python heritage extraction with metaclass separation (RFC §2.12).
 * class Foo(Bar, Baz, metaclass=Meta) extracts Bar and Baz as extends,
 * metaclass as a separate field to prevent C3 linearization false-positives.
 */
function extractPythonHeritage(
  classNode: Node,
  className: string,
  out: HeritageEdge[],
): { bases: string[]; metaclass: string | undefined } {
  const args = classNode.childForFieldName("superclasses");
  if (!args) return { bases: [], metaclass: undefined };

  const bases: string[] = [];
  let metaclass: string | undefined;
  let ordinal = 0;
  for (const arg of args.namedChildren) {
    if (arg.type === "keyword_argument") {
      // [Hejlsberg] Extract metaclass keyword argument separately
      const key = arg.childForFieldName("name");
      const value = arg.childForFieldName("value");
      if (key?.text === "metaclass" && value) {
        metaclass = value.type === "identifier" ? value.text : value.text;
      }
      continue;
    }
    const target = arg.type === "identifier" ? arg.text : arg.type === "attribute" ? arg.text : null;
    if (target && target.length > 1 && target !== "object") {
      out.push({
        className,
        kind: "extends",
        target,
        line: arg.startPosition.row + 1,
        ordinal,
      });
      bases.push(target);
      ordinal++;
    }
  }
  return { bases, metaclass };
}

function extractPythonDecorators(decoratedNode: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of decoratedNode.namedChildren) {
    if (child.type !== "decorator") continue;
    // @decorator or @module.decorator or @decorator(args)
    const inner = child.namedChildren[0];
    if (!inner) continue;
    let name: string | null = null;
    if (inner.type === "identifier") name = inner.text;
    else if (inner.type === "call") {
      const fn = inner.childForFieldName("function");
      if (fn?.type === "identifier") name = fn.text;
      else if (fn?.type === "attribute") name = fn.childForFieldName("attribute")?.text ?? null;
    } else if (inner.type === "attribute") {
      name = inner.childForFieldName("attribute")?.text ?? null;
    }
    if (name)
      out.push({
        target: targetName,
        decorator: name,
        line: child.startPosition.row + 1,
      });
  }
}

function getPythonEnclosingFn(node: Node): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === "function_definition") {
      const name = current.childForFieldName("name")?.text;
      return name && name.length > 1 ? name : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

// ── Go extraction ─────────────────────────────────────────────────────────────

const GO_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];

function extractGoFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const embeddings: EmbeddingEdge[] = [];
  const seenSymbols = new Set<string>();

  // Functions
  for (const node of root.descendantsOfType(["function_declaration", "method_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 1 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const kind: SymbolKind = node.type === "method_declaration" ? "method" : "function";
    let receiverType: string | undefined;
    let isPointerReceiver: boolean | undefined;
    if (node.type === "method_declaration") {
      const params = node.childForFieldName("parameters");
      if (params) {
        // Receiver is the first parameter_declaration in the parameters
        const recvParam = params.namedChildren.find((c) => c.type === "parameter_declaration");
        if (recvParam) {
          const typeChild = recvParam.childForFieldName("type");
          if (typeChild) {
            // F4: Track pointer vs value receiver. Pointer receivers
            // satisfy interfaces for *T only; value receivers satisfy for both.
            isPointerReceiver = typeChild.type === "pointer_type";
            receiverType =
              typeChild.type === "pointer_type" ? (typeChild.namedChildren[0]?.text ?? typeChild.text) : typeChild.text;
          }
        }
      }
    }
    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, GO_BODY_IDENT_TYPES);
    // Go exports = capitalized first letter
    const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
      receiverType,
      isPointerReceiver,
    });
  }

  // Type specs (structs, interfaces)
  for (const node of root.descendantsOfType(["type_spec"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 1 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const typeNode = node.childForFieldName("type");
    const isInterface = typeNode?.type === "interface_type";
    const isStruct = typeNode?.type === "struct_type";
    const kind: SymbolKind = isInterface ? "interface" : isStruct ? "struct" : "type";
    const bodyText = getNodeText(node);
    const tokens = bodyTokenString(node, GO_BODY_IDENT_TYPES);
    const isExported = name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
    });

    // Go interface embedding: type MyInterface interface { OtherInterface; ... }
    if (isInterface && typeNode) {
      extractGoInterfaceEmbedding(typeNode, name, heritageChains);
    }
    if (isStruct && typeNode) {
      extractGoStructEmbeddings(typeNode, name, embeddings);
    }
  }

  // Call sites
  for (const call of root.descendantsOfType("call_expression")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    if (fnNode.type === "identifier") {
      const name = fnNode.text;
      if (name && name.length > 1) {
        callSites.push({
          callerFn: getGoEnclosingFn(call),
          calleeName: name,
          line: call.startPosition.row + 1,
          isMemberExpression: false,
          objectName: undefined,
          isConstructor: false,
        });
      }
    } else if (fnNode.type === "selector_expression") {
      const obj = fnNode.childForFieldName("operand");
      const field = fnNode.childForFieldName("field");
      if (field && obj) {
        callSites.push({
          callerFn: getGoEnclosingFn(call),
          calleeName: field.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: obj.type === "identifier" ? obj.text : undefined,
          isConstructor: false,
        });
      }
    }
  }

  // Go type aliases: type Foo = Bar (with =, tree-sitter node type_alias)
  // NOT type Foo Bar (new type, tree-sitter node type_spec) -- RFC §2.15
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_alias"])) {
    const name = node.childForFieldName("name")?.text;
    const typeNode = node.childForFieldName("type");
    const target = typeNode?.type === "type_identifier" ? typeNode.text : null;
    if (name && target) {
      typeAliases.push({ name, target, line: node.startPosition.row + 1 });
    }
  }

  // F14: Go type usages from function signatures
  const typeUsages: TypeUsageEdge[] = [];
  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    // Find the AST node for this symbol to extract type refs from parameters/result
    const fnNodes = root.descendantsOfType(["function_declaration", "method_declaration"]);
    for (const fn of fnNodes) {
      const fnName = fn.childForFieldName("name")?.text;
      if (fnName !== sym.name) continue;
      if (fn.startPosition.row + 1 !== sym.startLine) continue;
      extractGoTypeUsages(fn, sym.name, typeUsages);
      break;
    }
  }

  // F15: Go struct literal assignments for Tier 3 resolution
  // Detect svc := &Server{} or svc := Server{} patterns
  const constructorAssignments: ConstructorAssignment[] = [];
  for (const node of root.descendantsOfType(["short_var_declaration"])) {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) continue;
    // Left side: identifier (the variable name)
    const varName =
      left.type === "expression_list"
        ? left.namedChildren[0]?.text
        : left.type === "identifier"
          ? left.text
          : undefined;
    if (!varName || varName.length <= 1) continue;
    // Right side: composite_literal or unary_expression(&Struct{})
    const literal = extractGoCompositeLiteral(right);
    if (literal) {
      constructorAssignments.push({
        variableName: varName,
        className: literal,
        callerFn: getGoEnclosingFn(node),
        line: node.startPosition.row + 1,
      });
    }
  }
  // Also handle var svc = Server{} (var_declaration)
  for (const node of root.descendantsOfType(["var_spec"])) {
    const nameNode = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (!nameNode || !value) continue;
    const varName = nameNode.text;
    if (!varName || varName.length <= 1) continue;
    const literal = extractGoCompositeLiteral(value);
    if (literal) {
      constructorAssignments.push({
        variableName: varName,
        className: literal,
        callerFn: getGoEnclosingFn(node),
        line: node.startPosition.row + 1,
      });
    }
  }

  return {
    symbols,
    callSites,
    heritageChains,
    decorators: [],
    typeUsages,
    constructorAssignments,
    embeddings,
    implBlocks: [],
    typeAliases,
    semanticEdges: [],
  };
}

function extractGoInterfaceEmbedding(ifaceBody: Node, ifaceName: string, out: HeritageEdge[]): void {
  // Interface fields that are type identifiers (embedded interfaces)
  for (const child of ifaceBody.namedChildren) {
    if (child.type === "type_identifier" || child.type === "qualified_type") {
      const target = child.type === "type_identifier" ? child.text : (child.childForFieldName("name")?.text ?? null);
      if (target) {
        out.push({
          className: ifaceName,
          kind: "extends",
          target,
          line: child.startPosition.row + 1,
        });
      }
    }
  }
}

function extractGoStructEmbeddings(typeNode: Node, structName: string, out: EmbeddingEdge[]): void {
  // In struct_type, fields without explicit names are embedded types
  for (const child of typeNode.namedChildren) {
    if (child.type !== "field_declaration_list") continue;
    for (const field of child.namedChildren) {
      if (field.type !== "field_declaration") continue;
      // Embedded field: has a type but no field name
      const fieldNames = field.namedChildren.filter((c) => c.type === "field_identifier");
      if (fieldNames.length > 0) continue; // has explicit name, not embedded

      const typeChild = field.namedChildren.find(
        (c) => c.type === "type_identifier" || c.type === "qualified_type" || c.type === "pointer_type",
      );
      if (!typeChild) continue;

      let embeddedType = typeChild.text;
      if (typeChild.type === "pointer_type") {
        const inner = typeChild.namedChildren[0];
        if (inner) embeddedType = inner.text;
      }

      out.push({ structName, embeddedType, line: field.startPosition.row + 1 });
    }
  }
}

/**
 * F14: Extract type usages from Go function signatures.
 * Scans parameter_list and result for type_identifier nodes.
 */
function extractGoTypeUsages(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
  const params = fnNode.childForFieldName("parameters");
  const result = fnNode.childForFieldName("result");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier"]));
  if (result) typeNodes.push(...result.descendantsOfType(["type_identifier"]));

  const seen = new Set<string>();
  for (const tn of typeNodes) {
    const typeName = tn.text;
    if (!typeName || typeName.length <= 1 || seen.has(typeName)) continue;
    if (isGoPrimitiveType(typeName)) continue;
    seen.add(typeName);
    out.push({ symbolName, typeName, line: tn.startPosition.row + 1 });
  }
}

const GO_PRIMITIVE_TYPES = new Set([
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

function isGoPrimitiveType(name: string): boolean {
  return GO_PRIMITIVE_TYPES.has(name);
}

/**
 * F15: Extract struct type name from a Go composite literal or &Struct{} expression.
 * Returns the type name if it's a capitalized identifier (struct convention), null otherwise.
 */
function extractGoCompositeLiteral(node: Node): string | null {
  // &Server{} → unary_expression → composite_literal
  let target = node;
  if (target.type === "expression_list") {
    target = target.namedChildren[0] ?? target;
  }
  if (target.type === "unary_expression") {
    const operand = target.namedChildren[0];
    if (operand) target = operand;
  }
  if (target.type === "composite_literal") {
    const typeNode = target.childForFieldName("type");
    if (typeNode?.type === "type_identifier") {
      const name = typeNode.text;
      if (name && name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase()) {
        return name;
      }
    }
  }
  return null;
}

function getGoEnclosingFn(node: Node): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === "function_declaration" || current.type === "method_declaration") {
      const name = current.childForFieldName("name")?.text;
      return name && name.length > 1 ? name : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

// ── Java extraction ───────────────────────────────────────────────────────────

const JAVA_BODY_IDENT_TYPES = ["identifier", "type_identifier"];

function extractJavaFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const typeUsages: TypeUsageEdge[] = [];
  const seenSymbols = new Set<string>();

  // F6/F7: Classes, interfaces and enums
  for (const node of root.descendantsOfType(["class_declaration", "interface_declaration", "enum_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length <= 1) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const kind: SymbolKind =
      node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "class";
    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, JAVA_BODY_IDENT_TYPES);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: hasJavaModifier(node, "public"),
    });

    // Java heritage: single extends, multiple implements
    extractJavaHeritage(node, name, heritageChains);
    extractJavaAnnotations(node, name, decorators);
  }

  // Methods
  for (const node of root.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length <= 1) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, JAVA_BODY_IDENT_TYPES);

    // Java default method detection (RFC §2.1): method with a body inside an interface
    const isInsideInterface = (() => {
      let p = node.parent;
      while (p) {
        if (p.type === "interface_declaration") return true;
        if (p.type === "class_declaration") return false;
        p = p.parent;
      }
      return false;
    })();
    const hasBody = !!node.childForFieldName("body");

    symbols.push({
      name,
      kind: "method",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: hasJavaModifier(node, "public"),
      isDefault: isInsideInterface && hasBody ? true : undefined,
    });

    extractTsTypeUsages(node, name, typeUsages);
    extractJavaAnnotations(node, name, decorators);
  }

  // Call sites
  for (const call of root.descendantsOfType("method_invocation")) {
    const nameNode = call.childForFieldName("name");
    const obj = call.childForFieldName("object");
    if (!nameNode) continue;

    callSites.push({
      callerFn: getJavaEnclosingFn(call),
      calleeName: nameNode.text,
      line: call.startPosition.row + 1,
      isMemberExpression: !!obj,
      objectName: obj?.type === "identifier" ? obj.text : undefined,
      isConstructor: false,
    });
  }

  // new expressions
  for (const newExpr of root.descendantsOfType("object_creation_expression")) {
    const typeNode = newExpr.childForFieldName("type");
    if (!typeNode) continue;
    const name =
      typeNode.type === "type_identifier" ? typeNode.text : (typeNode.childForFieldName("name")?.text ?? null);
    if (name && name.length > 1) {
      callSites.push({
        callerFn: getJavaEnclosingFn(newExpr),
        calleeName: name,
        line: newExpr.startPosition.row + 1,
        isMemberExpression: false,
        objectName: undefined,
        isConstructor: true,
      });
    }
  }

  const constructorAssignments = extractJavaConstructorAssignments(root);
  return {
    symbols,
    callSites,
    heritageChains,
    decorators,
    typeUsages,
    constructorAssignments,
    embeddings: [],
    implBlocks: [],
    typeAliases: [],
    semanticEdges: [],
  };
}

/**
 * Java heritage: single extends, multiple implements.
 * Java enforces single inheritance for classes; multiple interface implementation.
 */
function extractJavaHeritage(node: Node, className: string, out: HeritageEdge[]): void {
  // superclass (extends)
  const superclass = node.childForFieldName("superclass");
  if (superclass) {
    const target = superclass.type === "type_identifier" ? superclass.text : null;
    if (target)
      out.push({
        className,
        kind: "extends",
        target,
        line: superclass.startPosition.row + 1,
      });
  }

  // interfaces (implements)
  const interfaces = node.childForFieldName("interfaces");
  if (interfaces) {
    for (const iface of interfaces.namedChildren) {
      const target = iface.type === "type_identifier" ? iface.text : (iface.childForFieldName("name")?.text ?? null);
      if (target)
        out.push({
          className,
          kind: "implements",
          target,
          line: iface.startPosition.row + 1,
        });
    }
  }

  // Interface extends
  if (node.type === "interface_declaration") {
    const extClause = node.namedChildren.find((c) => c.type === "extends_interfaces");
    if (extClause) {
      for (const iface of extClause.namedChildren) {
        const target = iface.type === "type_identifier" ? iface.text : null;
        if (target)
          out.push({
            className,
            kind: "extends",
            target,
            line: iface.startPosition.row + 1,
          });
      }
    }
  }
}

/**
 * Extract variable-to-constructor assignments from Java code (RFC §2.6).
 * Detects `UserService svc = new UserService()` patterns.
 */
function extractJavaConstructorAssignments(root: Node): ConstructorAssignment[] {
  const assignments: ConstructorAssignment[] = [];

  for (const newExpr of root.descendantsOfType("object_creation_expression")) {
    const typeNode = newExpr.childForFieldName("type");
    if (!typeNode) continue;
    const className =
      typeNode.type === "type_identifier" ? typeNode.text : (typeNode.childForFieldName("name")?.text ?? null);
    if (!className || className.length <= 1) continue;

    const parent = newExpr.parent;
    if (parent?.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name");
      if (nameNode?.type === "identifier") {
        const varName = nameNode.text;
        if (varName && varName.length > 1) {
          assignments.push({
            variableName: varName,
            className,
            callerFn: getJavaEnclosingFn(newExpr),
            line: newExpr.startPosition.row + 1,
          });
        }
      }
    }
  }

  return assignments;
}

function extractJavaAnnotations(node: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      const name = child.childForFieldName("name")?.text;
      if (name)
        out.push({
          target: targetName,
          decorator: name,
          line: child.startPosition.row + 1,
        });
    }
  }
}

function hasJavaModifier(node: Node, modifier: string): boolean {
  const modifiers = node.childForFieldName("modifiers");
  if (!modifiers) return false;
  return modifiers.namedChildren.some((m) => m.text === modifier);
}

function getJavaEnclosingFn(node: Node): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === "method_declaration" || current.type === "constructor_declaration") {
      const name = current.childForFieldName("name")?.text;
      return name && name.length > 1 ? name : undefined;
    }
    current = current.parent;
  }
  return undefined;
}

// ── Rust extraction ───────────────────────────────────────────────────────────

const RUST_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];

function extractRustFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const implBlocks: ImplBlock[] = [];
  const seenSymbols = new Set<string>();

  // Functions
  for (const node of root.descendantsOfType(["function_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, RUST_BODY_IDENT_TYPES);
    const isExported = isRustPub(node);

    symbols.push({
      name,
      kind: "function",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
    });
  }

  // Structs, enums, traits
  for (const node of root.descendantsOfType(["struct_item", "enum_item", "trait_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;

    const key = `${name}:${node.startPosition.row}`;
    if (seenSymbols.has(key)) continue;
    seenSymbols.add(key);

    const kind: SymbolKind = node.type === "trait_item" ? "trait" : node.type === "enum_item" ? "enum" : "struct";
    const bodyText = getNodeText(node);
    const tokens = bodyTokenString(node, RUST_BODY_IDENT_TYPES);
    const isExported = isRustPub(node);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported,
    });

    // Trait bounds (trait MyTrait: OtherTrait + AnotherTrait)
    if (node.type === "trait_item") {
      extractRustTraitBounds(node, name, heritageChains);
    }
  }

  // impl blocks: impl Trait for Type
  for (const node of root.descendantsOfType(["impl_item"])) {
    const traitNode = node.childForFieldName("trait");
    const typeNode = node.childForFieldName("type");

    const typeName = typeNode?.type === "type_identifier" ? typeNode.text : null;
    const traitName = traitNode?.type === "type_identifier" ? traitNode.text : null;

    if (traitName && typeName) {
      heritageChains.push({
        className: typeName,
        kind: "implements",
        target: traitName,
        line: node.startPosition.row + 1,
      });
    }

    // Collect methods and detect Deref target
    const body = node.childForFieldName("body");
    const methods: string[] = [];
    let derefTarget: string | undefined;

    if (body) {
      for (const fn of body.descendantsOfType(["function_item"])) {
        const name = fn.childForFieldName("name")?.text;
        if (!name || name.length < 2 || name.startsWith("_")) continue;

        methods.push(name);

        const key = `${name}:${fn.startPosition.row}`;
        if (seenSymbols.has(key)) continue;
        seenSymbols.add(key);

        const fnBody = fn.childForFieldName("body");
        const bodyText = fnBody ? getNodeText(fnBody) : getNodeText(fn);
        const tokens = bodyTokenString(fnBody ?? fn, RUST_BODY_IDENT_TYPES);

        symbols.push({
          name,
          kind: "method",
          startLine: fn.startPosition.row + 1,
          endLine: fn.endPosition ? fn.endPosition.row + 1 : undefined,
          bodyTokens: tokens,
          bodyHash: hashBody(bodyText),
          isExported: isRustPub(fn),
          receiverType: typeName ?? undefined,
        });
      }

      // Detect Deref target: type Target = Inner inside impl Deref for Wrapper
      if (traitName === "Deref" || traitName === "std::ops::Deref") {
        for (const typeItem of body.descendantsOfType(["type_item"])) {
          const aliasName = typeItem.childForFieldName("name")?.text;
          if (aliasName === "Target") {
            const aliasType = typeItem.childForFieldName("type");
            if (aliasType) derefTarget = aliasType.text;
          }
        }
      }
    }

    if (typeName) {
      implBlocks.push({
        targetType: typeName,
        traitName: traitName ?? undefined,
        methods,
        derefTarget,
        filePath: "", // filled by caller
      });
    }
  }

  // Call sites
  for (const call of root.descendantsOfType("call_expression")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    if (fnNode.type === "identifier") {
      const name = fnNode.text;
      if (name && name.length > 1) {
        callSites.push({
          callerFn: getRustEnclosingFn(call),
          calleeName: name,
          line: call.startPosition.row + 1,
          isMemberExpression: false,
          objectName: undefined,
          isConstructor: false,
        });
      }
    } else if (fnNode.type === "field_expression") {
      const field = fnNode.childForFieldName("field");
      const value = fnNode.childForFieldName("value");
      if (field && value) {
        callSites.push({
          callerFn: getRustEnclosingFn(call),
          calleeName: field.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: value.type === "identifier" ? value.text : undefined,
          isConstructor: false,
        });
      }
    } else if (fnNode.type === "scoped_identifier") {
      // Type::method() style calls
      const name = fnNode.childForFieldName("name");
      if (name) {
        callSites.push({
          callerFn: getRustEnclosingFn(call),
          calleeName: name.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: fnNode.childForFieldName("path")?.text ?? undefined,
          isConstructor: false,
        });
      }
    }
  }

  // Rust derive macros and attribute macros → decorates edges (RFC §2.8 AC9)
  const decorators: DecoratorEdge[] = [];
  for (const node of root.descendantsOfType(["attribute_item"])) {
    // #[derive(Debug, Clone)] or #[tokio::main]
    const inner = node.namedChildren[0]; // the attribute content
    if (!inner) continue;

    // Find the decorated item (next sibling that is a struct/enum/function/impl)
    const parent = node.parent;
    if (!parent) continue;

    const siblings = parent.namedChildren;
    const nodeIdx = siblings.indexOf(node);
    let targetName: string | null = null;
    for (let i = nodeIdx + 1; i < siblings.length; i++) {
      const sib = siblings[i];
      if (sib.type === "attribute_item") continue; // skip chained attributes
      targetName = sib.childForFieldName("name")?.text ?? null;
      break;
    }
    if (!targetName) continue;

    // Parse derive: #[derive(Debug, Clone)]
    if (inner.type === "attribute" || inner.type === "meta_item") {
      const attrName = inner.childForFieldName("name")?.text ?? inner.namedChildren[0]?.text;
      if (attrName === "derive") {
        const args = inner.childForFieldName("arguments") ?? inner.namedChildren.find((c) => c.type === "token_tree");
        if (args) {
          for (const arg of args.namedChildren) {
            if (arg.type === "identifier" || arg.type === "meta_item") {
              decorators.push({
                target: targetName,
                decorator: arg.text,
                line: node.startPosition.row + 1,
              });
            }
          }
        }
      } else if (attrName) {
        decorators.push({
          target: targetName,
          decorator: attrName,
          line: node.startPosition.row + 1,
        });
      }
    }
  }

  // Rust type aliases: type Foo = Bar (RFC §2.15)
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_item"])) {
    // Skip type items inside impl blocks (associated types like type Target = Inner)
    let insideImpl = false;
    let p = node.parent;
    while (p) {
      if (p.type === "impl_item") {
        insideImpl = true;
        break;
      }
      p = p.parent;
    }
    if (insideImpl) continue;

    const name = node.childForFieldName("name")?.text;
    const typeNode = node.childForFieldName("type");
    if (!name || !typeNode) continue;
    const target =
      typeNode.type === "type_identifier"
        ? typeNode.text
        : typeNode.type === "generic_type"
          ? (typeNode.childForFieldName("type")?.text ?? typeNode.namedChildren[0]?.text ?? null)
          : null;
    if (target) {
      typeAliases.push({ name, target, line: node.startPosition.row + 1 });
    }
  }

  // F13: Rust type usages from function signatures
  const typeUsages: TypeUsageEdge[] = [];
  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    // Find the AST node for this symbol to extract type refs
    const fnNodes = root.descendantsOfType(["function_item"]);
    for (const fn of fnNodes) {
      const fnName = fn.childForFieldName("name")?.text;
      if (fnName !== sym.name) continue;
      if (fn.startPosition.row + 1 !== sym.startLine) continue;
      extractRustTypeUsages(fn, sym.name, typeUsages);
      break;
    }
  }

  return {
    symbols,
    callSites,
    heritageChains,
    decorators,
    typeUsages,
    constructorAssignments: [],
    embeddings: [],
    implBlocks,
    typeAliases,
    semanticEdges: [],
  };
}

/**
 * F13: Extract type usages from Rust function signatures.
 * Scans parameters and return_type for type_identifier nodes.
 */
function extractRustTypeUsages(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
  const params = fnNode.childForFieldName("parameters");
  const retType = fnNode.childForFieldName("return_type");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier"]));
  if (retType) typeNodes.push(...retType.descendantsOfType(["type_identifier"]));

  const seen = new Set<string>();
  for (const tn of typeNodes) {
    const typeName = tn.text;
    if (!typeName || typeName.length <= 1 || seen.has(typeName)) continue;
    if (isRustPrimitiveType(typeName)) continue;
    seen.add(typeName);
    out.push({ symbolName, typeName, line: tn.startPosition.row + 1 });
  }
}

const RUST_PRIMITIVE_TYPES = new Set([
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

function isRustPrimitiveType(name: string): boolean {
  return RUST_PRIMITIVE_TYPES.has(name);
}

/**
 * Rust trait bounds: trait Foo: Bar + Baz
 * These represent trait supertrait relationships.
 */
function extractRustTraitBounds(traitNode: Node, traitName: string, out: HeritageEdge[]): void {
  const bounds = traitNode.childForFieldName("bounds");
  if (!bounds) return;
  for (const bound of bounds.namedChildren) {
    const target = bound.type === "type_identifier" ? bound.text : null;
    if (target)
      out.push({
        className: traitName,
        kind: "extends",
        target,
        line: bound.startPosition.row + 1,
      });
  }
}

function isRustPub(node: Node): boolean {
  const vis = node.childForFieldName("visibility_modifier");
  return vis?.text === "pub" || false;
}

function getRustEnclosingFn(node: Node): string | undefined {
  let current: Node | null = node.parent;
  while (current) {
    if (current.type === "function_item") {
      const name = current.childForFieldName("name")?.text;
      return name && name.length > 1 ? name : undefined;
    }
    current = current.parent;
  }
  return undefined;
}
