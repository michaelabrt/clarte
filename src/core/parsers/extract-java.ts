/**
 * Java file graph extraction.
 */

import type { Node } from "web-tree-sitter";
import type {
  ConstructorAssignment,
  DecoratorEdge,
  FileGraphResult,
  HeritageEdge,
  RawCallSite,
  SymbolDefinition,
  SymbolKind,
  TypeUsageEdge,
} from "../graph/symbol-types";
import {
  buildSymbol,
  extractTypeUsagesFromNodes,
  getEnclosingFunction,
  isDuplicateSymbol,
  isTsPrimitive,
} from "./extract-file-graph";

const JAVA_BODY_IDENT_TYPES = ["identifier", "type_identifier"];
const JAVA_FN_TYPES = ["method_declaration", "constructor_declaration"];

export function extractJavaFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const typeUsages: TypeUsageEdge[] = [];
  const seenSymbols = new Set<string>();

  extractClassesAndInterfaces(root, symbols, heritageChains, decorators, seenSymbols);
  extractMethods(root, symbols, decorators, typeUsages, seenSymbols);
  extractCallSites(root, callSites);

  const constructorAssignments = extractConstructorAssignments(root);

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

// ── Classes, interfaces and enums ────────────────────────────────────────────

function extractClassesAndInterfaces(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  decorators: DecoratorEdge[],
  seenSymbols: Set<string>,
): void {
  for (const node of root.descendantsOfType(["class_declaration", "interface_declaration", "enum_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length <= 1) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const kind: SymbolKind =
      node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "class";
    const body = node.childForFieldName("body");
    const sym = buildSymbol(name, kind, node, body, JAVA_BODY_IDENT_TYPES, hasModifier(node, "public"));
    symbols.push(sym);

    extractHeritage(node, name, heritageChains);
    extractAnnotations(node, name, decorators);
  }
}

// ── Methods ──────────────────────────────────────────────────────────────────

function extractMethods(
  root: Node,
  symbols: SymbolDefinition[],
  decorators: DecoratorEdge[],
  typeUsages: TypeUsageEdge[],
  seenSymbols: Set<string>,
): void {
  for (const node of root.descendantsOfType(["method_declaration", "constructor_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length <= 1) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const body = node.childForFieldName("body");
    const sym = buildSymbol(name, "method", node, body, JAVA_BODY_IDENT_TYPES, hasModifier(node, "public"));

    // Java default method: method with a body inside an interface
    const isInsideInterface = (() => {
      let p = node.parent;
      while (p) {
        if (p.type === "interface_declaration") return true;
        if (p.type === "class_declaration") return false;
        p = p.parent;
      }
      return false;
    })();
    if (isInsideInterface && !!node.childForFieldName("body")) sym.isDefault = true;

    symbols.push(sym);
    extractJavaTypeUsages(node, name, typeUsages);
    extractAnnotations(node, name, decorators);
  }
}

// ── Heritage ─────────────────────────────────────────────────────────────────

/** Java heritage: single extends, multiple implements. */
function extractHeritage(node: Node, className: string, out: HeritageEdge[]): void {
  const superclass = node.childForFieldName("superclass");
  if (superclass) {
    const target = superclass.type === "type_identifier" ? superclass.text : null;
    if (target) out.push({ className, kind: "extends", target, line: superclass.startPosition.row + 1 });
  }

  const interfaces = node.childForFieldName("interfaces");
  if (interfaces) {
    for (const iface of interfaces.namedChildren) {
      const target = iface.type === "type_identifier" ? iface.text : (iface.childForFieldName("name")?.text ?? null);
      if (target) out.push({ className, kind: "implements", target, line: iface.startPosition.row + 1 });
    }
  }

  if (node.type === "interface_declaration") {
    const extClause = node.namedChildren.find((c) => c.type === "extends_interfaces");
    if (extClause) {
      for (const iface of extClause.namedChildren) {
        const target = iface.type === "type_identifier" ? iface.text : null;
        if (target) out.push({ className, kind: "extends", target, line: iface.startPosition.row + 1 });
      }
    }
  }
}

// ── Annotations ──────────────────────────────────────────────────────────────

function extractAnnotations(node: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of node.namedChildren) {
    if (child.type === "marker_annotation" || child.type === "annotation") {
      const name = child.childForFieldName("name")?.text;
      if (name) out.push({ target: targetName, decorator: name, line: child.startPosition.row + 1 });
    }
  }
}

// ── Type usages ──────────────────────────────────────────────────────────────

function extractJavaTypeUsages(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
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

function extractCallSites(root: Node, callSites: RawCallSite[]): void {
  for (const call of root.descendantsOfType("method_invocation")) {
    const nameNode = call.childForFieldName("name");
    const obj = call.childForFieldName("object");
    if (!nameNode) continue;

    callSites.push({
      callerFn: getEnclosingFunction(call, JAVA_FN_TYPES),
      calleeName: nameNode.text,
      line: call.startPosition.row + 1,
      isMemberExpression: !!obj,
      objectName: obj?.type === "identifier" ? obj.text : undefined,
      isConstructor: false,
    });
  }

  for (const newExpr of root.descendantsOfType("object_creation_expression")) {
    const typeNode = newExpr.childForFieldName("type");
    if (!typeNode) continue;
    const name =
      typeNode.type === "type_identifier" ? typeNode.text : (typeNode.childForFieldName("name")?.text ?? null);
    if (name && name.length > 1) {
      callSites.push({
        callerFn: getEnclosingFunction(newExpr, JAVA_FN_TYPES),
        calleeName: name,
        line: newExpr.startPosition.row + 1,
        isMemberExpression: false,
        objectName: undefined,
        isConstructor: true,
      });
    }
  }
}

// ── Constructor assignments ──────────────────────────────────────────────────

/** Detects `UserService svc = new UserService()` patterns. */
function extractConstructorAssignments(root: Node): ConstructorAssignment[] {
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
            callerFn: getEnclosingFunction(newExpr, JAVA_FN_TYPES),
            line: newExpr.startPosition.row + 1,
          });
        }
      }
    }
  }

  return assignments;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function hasModifier(node: Node, modifier: string): boolean {
  const modifiers = node.childForFieldName("modifiers");
  if (!modifiers) return false;
  return modifiers.namedChildren.some((m) => m.text === modifier);
}
