/**
 * TypeScript/JavaScript file graph extraction.
 */

import type { Node } from "web-tree-sitter";
import type {
  ConstructorAssignment,
  DecoratorEdge,
  EmbeddingEdge,
  HeritageEdge,
  ImplBlock,
  RawCallSite,
  SemanticEdge,
  SymbolDefinition,
  SymbolKind,
  TypeAlias,
  TypeUsageEdge,
} from "../graph/symbol-types";
import {
  buildSymbol,
  extractTypeUsagesFromNodes,
  getEnclosingFunction,
  isDuplicateSymbol,
  isTsPrimitive,
} from "./extract-file-graph";

const TS_BODY_IDENT_TYPES = [
  "identifier",
  "property_identifier",
  "type_identifier",
  "shorthand_property_identifier",
  "string_fragment",
  "template_string",
];

const TS_FN_TYPES = ["function_declaration", "generator_function_declaration", "method_definition"];

const TS_EXPR_FN_TYPES = ["arrow_function", "function", "function_expression", "generator_function"];

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

export function extractTsFileGraph(root: Node): TsExtraction {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const typeUsages: TypeUsageEdge[] = [];
  const seenSymbols = new Set<string>();

  const exportedNames = collectExportedNames(root);

  extractSymbols(root, symbols, heritageChains, decorators, typeUsages, seenSymbols, exportedNames);
  extractCallSites(root, callSites);

  const constructorAssignments = extractConstructorAssignments(root);
  const typeAliases = extractTypeAliases(root);

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

// ── Symbols ──────────────────────────────────────────────────────────────────

function collectExportedNames(root: Node): Set<string> {
  const exported = new Set<string>();
  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;
    const decl = node.childForFieldName("declaration");
    if (decl) {
      const name = decl.childForFieldName("name")?.text;
      if (name) exported.add(name);
      if (decl.type === "lexical_declaration") {
        for (const d of decl.namedChildren) {
          if (d.type === "variable_declarator") {
            const vn = d.childForFieldName("name")?.text;
            if (vn) exported.add(vn);
          }
        }
      }
    }
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

function extractSymbols(
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

  for (const node of root.descendantsOfType(namedFnTypes)) {
    const nameNode = node.childForFieldName("name");
    if (!nameNode || nameNode.type === "computed_property_name") continue;
    const name = nameNode.text;
    if (!name || name.length <= 1 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const kind = inferKind(node);
    const body = node.childForFieldName("body");
    const isExported = exportedNames.has(name) || isExportedNode(node);
    const sym = buildSymbol(name, kind, node, body, TS_BODY_IDENT_TYPES, isExported);
    symbols.push(sym);

    if (node.type === "class_declaration") {
      extractHeritage(node, name, heritageChains);
      extractClassDecorators(node, name, decorators);
    }
    if (node.type === "interface_declaration") {
      extractInterfaceHeritage(node, name, heritageChains);
    }
    if (node.type === "function_declaration" || node.type === "method_definition") {
      extractTypeUsages(node, name, typeUsages);
    }
  }

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
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const body = node.childForFieldName("body");
    const kind = detectJsxComponent(body) ? "component" : "function";
    const isExported = exportedNames.has(name) || isExportedNode(node);
    symbols.push(buildSymbol(name, kind, node, body, TS_BODY_IDENT_TYPES, isExported));

    extractTypeUsages(node, name, typeUsages);
  }
}

function inferKind(node: Node): SymbolKind {
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

// ── Heritage ─────────────────────────────────────────────────────────────────

function extractHeritage(classNode: Node, className: string, out: HeritageEdge[]): void {
  for (const child of classNode.namedChildren) {
    if (child.type === "class_heritage") {
      for (const clause of child.namedChildren) {
        if (clause.type !== "extends_clause" && clause.type !== "implements_clause") continue;
        const kind: "extends" | "implements" = clause.type === "extends_clause" ? "extends" : "implements";
        for (const typeNode of clause.namedChildren) {
          const target = extractTypeName(typeNode);
          if (target) out.push({ className, kind, target, line: clause.startPosition.row + 1 });
        }
      }
      continue;
    }
    // Some tree-sitter versions put extends/implements directly on the class
    if (child.type === "extends_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target) out.push({ className, kind: "extends", target, line: child.startPosition.row + 1 });
      }
    }
    if (child.type === "implements_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target) out.push({ className, kind: "implements", target, line: child.startPosition.row + 1 });
      }
    }
  }
}

function extractInterfaceHeritage(ifaceNode: Node, name: string, out: HeritageEdge[]): void {
  for (const child of ifaceNode.namedChildren) {
    if (child.type === "extends_type_clause" || child.type === "extends_clause") {
      for (const typeNode of child.namedChildren) {
        const target = extractTypeName(typeNode);
        if (target) out.push({ className: name, kind: "extends", target, line: child.startPosition.row + 1 });
      }
    }
  }
}

export function extractTypeName(node: Node): string | null {
  if (node.type === "identifier" || node.type === "type_identifier") return node.text;
  if (node.type === "generic_type") {
    return node.childForFieldName("name")?.text ?? null;
  }
  if (node.type === "member_expression" || node.type === "nested_type_identifier") {
    const right = node.childForFieldName("property") ?? node.namedChildren[node.namedChildren.length - 1];
    return right?.text ?? null;
  }
  return null;
}

// ── Decorators ───────────────────────────────────────────────────────────────

function extractClassDecorators(classNode: Node, className: string, out: DecoratorEdge[]): void {
  const parent = classNode.parent;
  if (parent?.type === "export_statement") {
    extractDecoratorsFromSiblings(parent, className, out);
  }
  extractDecoratorsFromSiblings(classNode, className, out);

  const body = classNode.childForFieldName("body");
  if (!body) return;
  for (const member of body.namedChildren) {
    if (member.type !== "method_definition") continue;
    const methodName = member.childForFieldName("name")?.text;
    if (!methodName) continue;
    for (const child of member.namedChildren) {
      if (child.type === "decorator") {
        const decoratorName = extractDecoratorName(child);
        if (decoratorName)
          out.push({ target: methodName, decorator: decoratorName, line: child.startPosition.row + 1 });
      }
    }
  }
}

function extractDecoratorsFromSiblings(node: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "decorator") {
      const decoratorName = extractDecoratorName(child);
      if (decoratorName) out.push({ target: targetName, decorator: decoratorName, line: child.startPosition.row + 1 });
    }
  }
}

function extractDecoratorName(decoratorNode: Node): string | null {
  for (const child of decoratorNode.namedChildren) {
    if (child.type === "identifier") return child.text;
    if (child.type === "call_expression") {
      const fn = child.childForFieldName("function");
      if (fn?.type === "identifier") return fn.text;
      if (fn?.type === "member_expression") return fn.childForFieldName("property")?.text ?? null;
    }
    if (child.type === "member_expression") return child.childForFieldName("property")?.text ?? null;
  }
  return null;
}

// ── Type usages ──────────────────────────────────────────────────────────────

function extractTypeUsages(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
  const params = fnNode.childForFieldName("parameters");
  const retType = fnNode.childForFieldName("return_type");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier", "generic_type"]));
  if (retType) typeNodes.push(...retType.descendantsOfType(["type_identifier", "generic_type"]));

  extractTypeUsagesFromNodes(typeNodes, symbolName, isTsPrimitive, out, (tn) =>
    tn.type === "generic_type" ? (tn.childForFieldName("name")?.text ?? null) : tn.text,
  );
}

// ── Call sites ───────────────────────────────────────────────────────────────

function extractCallSites(root: Node, out: RawCallSite[]): void {
  for (const call of root.descendantsOfType("call_expression")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;
    const site = parseCallExpression(fnNode, call);
    if (site) out.push(site);
  }

  for (const newExpr of root.descendantsOfType("new_expression")) {
    const ctorNode = newExpr.childForFieldName("constructor");
    if (!ctorNode) continue;
    const name = ctorNode.type === "identifier" ? ctorNode.text : null;
    if (!name || name.length <= 1) continue;

    out.push({
      callerFn: getEnclosingFunction(newExpr, TS_FN_TYPES, TS_EXPR_FN_TYPES),
      calleeName: name,
      line: newExpr.startPosition.row + 1,
      isMemberExpression: false,
      objectName: undefined,
      isConstructor: true,
    });
  }
}

function parseCallExpression(fnNode: Node, callNode: Node): RawCallSite | null {
  if (fnNode.type === "identifier") {
    const name = fnNode.text;
    if (!name || name.length <= 1) return null;
    return {
      callerFn: getEnclosingFunction(callNode, TS_FN_TYPES, TS_EXPR_FN_TYPES),
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
    if (!calleeName || calleeName.length <= 1) return null;
    return {
      callerFn: getEnclosingFunction(callNode, TS_FN_TYPES, TS_EXPR_FN_TYPES),
      calleeName,
      line: callNode.startPosition.row + 1,
      isMemberExpression: true,
      objectName: obj.type === "identifier" ? obj.text : undefined,
      isConstructor: false,
    };
  }

  return null;
}

// ── Constructor assignments ──────────────────────────────────────────────────

/**
 * Detects `const svc = new UserService()` and `svc = new UserService()` patterns.
 * Keyed by variable name so the resolution engine can match callSite.objectName.
 */
function extractConstructorAssignments(root: Node): ConstructorAssignment[] {
  const assignments: ConstructorAssignment[] = [];

  for (const newExpr of root.descendantsOfType("new_expression")) {
    const ctorNode = newExpr.childForFieldName("constructor");
    if (!ctorNode || ctorNode.type !== "identifier") continue;
    const className = ctorNode.text;
    if (!className || className.length <= 1) continue;

    const line = newExpr.startPosition.row + 1;
    const callerFn = getEnclosingFunction(newExpr, TS_FN_TYPES, TS_EXPR_FN_TYPES);
    const parent = newExpr.parent;

    if (parent?.type === "variable_declarator") {
      const nameNode = parent.childForFieldName("name");
      if (nameNode?.type === "identifier") {
        const varName = nameNode.text;
        if (varName && varName.length > 1) {
          assignments.push({ variableName: varName, className, callerFn, line });
        }
      }
    } else if (parent?.type === "assignment_expression") {
      const left = parent.childForFieldName("left");
      if (left?.type === "identifier") {
        const varName = left.text;
        if (varName && varName.length > 1) {
          assignments.push({ variableName: varName, className, callerFn, line });
        }
      }
    }
  }

  return assignments;
}

// ── Type aliases ─────────────────────────────────────────────────────────────

function extractTypeAliases(root: Node): TypeAlias[] {
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_alias_declaration"])) {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    const aliasName = nameNode.text;
    const target =
      valueNode.type === "type_identifier"
        ? valueNode.text
        : valueNode.type === "generic_type"
          ? (valueNode.childForFieldName("name")?.text ?? null)
          : null;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({ name: aliasName, target, line: node.startPosition.row + 1 });
    }
  }
  return typeAliases;
}
