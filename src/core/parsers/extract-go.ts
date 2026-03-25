/**
 * Go file graph extraction.
 */

import type { Node } from "web-tree-sitter";
import type {
  ConstructorAssignment,
  EmbeddingEdge,
  FileGraphResult,
  HeritageEdge,
  RawCallSite,
  SymbolDefinition,
  SymbolKind,
  TypeAlias,
  TypeUsageEdge,
} from "../graph/symbol-types";
import {
  bodyTokenString,
  extractTypeUsagesFromNodes,
  getEnclosingFunction,
  getNodeText,
  hashBody,
  isDuplicateSymbol,
  isGoPrimitive,
} from "./extract-file-graph";

const GO_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];
const GO_FN_TYPES = ["function_declaration", "method_declaration"];

function isGoExported(name: string): boolean {
  return name[0] === name[0].toUpperCase() && name[0] !== name[0].toLowerCase();
}

export function extractGoFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const embeddings: EmbeddingEdge[] = [];
  const seenSymbols = new Set<string>();

  extractFunctions(root, symbols, seenSymbols);
  extractTypes(root, symbols, heritageChains, embeddings, seenSymbols);
  extractCallSites(root, callSites);

  const typeAliases = extractTypeAliases(root);
  const typeUsages = extractAllTypeUsages(root, symbols);
  const constructorAssignments = extractConstructorAssignments(root);

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

// ── Functions ────────────────────────────────────────────────────────────────

function extractFunctions(root: Node, symbols: SymbolDefinition[], seenSymbols: Set<string>): void {
  for (const node of root.descendantsOfType(["function_declaration", "method_declaration"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 1 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const kind: SymbolKind = node.type === "method_declaration" ? "method" : "function";
    let receiverType: string | undefined;
    let isPointerReceiver: boolean | undefined;

    if (node.type === "method_declaration") {
      const params = node.childForFieldName("parameters");
      if (params) {
        const recvParam = params.namedChildren.find((c) => c.type === "parameter_declaration");
        if (recvParam) {
          const typeChild = recvParam.childForFieldName("type");
          if (typeChild) {
            // Pointer receivers satisfy interfaces for *T only; value receivers for both
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

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: isGoExported(name),
      receiverType,
      isPointerReceiver,
    });
  }
}

// ── Type specs (structs, interfaces) ─────────────────────────────────────────

function extractTypes(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  embeddings: EmbeddingEdge[],
  seenSymbols: Set<string>,
): void {
  for (const node of root.descendantsOfType(["type_spec"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 1 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const typeNode = node.childForFieldName("type");
    const isInterface = typeNode?.type === "interface_type";
    const isStruct = typeNode?.type === "struct_type";
    const kind: SymbolKind = isInterface ? "interface" : isStruct ? "struct" : "type";
    const bodyText = getNodeText(node);
    const tokens = bodyTokenString(node, GO_BODY_IDENT_TYPES);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: isGoExported(name),
    });

    if (isInterface && typeNode) extractInterfaceEmbedding(typeNode, name, heritageChains);
    if (isStruct && typeNode) extractStructEmbeddings(typeNode, name, embeddings);
  }
}

function extractInterfaceEmbedding(ifaceBody: Node, ifaceName: string, out: HeritageEdge[]): void {
  for (const child of ifaceBody.namedChildren) {
    if (child.type === "type_identifier" || child.type === "qualified_type") {
      const target = child.type === "type_identifier" ? child.text : (child.childForFieldName("name")?.text ?? null);
      if (target) out.push({ className: ifaceName, kind: "extends", target, line: child.startPosition.row + 1 });
    }
  }
}

function extractStructEmbeddings(typeNode: Node, structName: string, out: EmbeddingEdge[]): void {
  for (const child of typeNode.namedChildren) {
    if (child.type !== "field_declaration_list") continue;
    for (const field of child.namedChildren) {
      if (field.type !== "field_declaration") continue;
      // Embedded field: has a type but no field name
      const fieldNames = field.namedChildren.filter((c) => c.type === "field_identifier");
      if (fieldNames.length > 0) continue;

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

// ── Call sites ───────────────────────────────────────────────────────────────

function extractCallSites(root: Node, callSites: RawCallSite[]): void {
  for (const call of root.descendantsOfType("call_expression")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    if (fnNode.type === "identifier") {
      const name = fnNode.text;
      if (name && name.length > 1) {
        callSites.push({
          callerFn: getEnclosingFunction(call, GO_FN_TYPES),
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
          callerFn: getEnclosingFunction(call, GO_FN_TYPES),
          calleeName: field.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: obj.type === "identifier" ? obj.text : undefined,
          isConstructor: false,
        });
      }
    }
  }
}

// ── Type usages ──────────────────────────────────────────────────────────────

function extractAllTypeUsages(root: Node, symbols: SymbolDefinition[]): TypeUsageEdge[] {
  const typeUsages: TypeUsageEdge[] = [];
  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    const fnNodes = root.descendantsOfType(["function_declaration", "method_declaration"]);
    for (const fn of fnNodes) {
      if (fn.childForFieldName("name")?.text !== sym.name) continue;
      if (fn.startPosition.row + 1 !== sym.startLine) continue;
      extractTypeUsagesFromFn(fn, sym.name, typeUsages);
      break;
    }
  }
  return typeUsages;
}

function extractTypeUsagesFromFn(fnNode: Node, symbolName: string, out: TypeUsageEdge[]): void {
  const params = fnNode.childForFieldName("parameters");
  const result = fnNode.childForFieldName("result");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier"]));
  if (result) typeNodes.push(...result.descendantsOfType(["type_identifier"]));

  extractTypeUsagesFromNodes(typeNodes, symbolName, isGoPrimitive, out);
}

// ── Type aliases ─────────────────────────────────────────────────────────────

function extractTypeAliases(root: Node): TypeAlias[] {
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_alias"])) {
    const name = node.childForFieldName("name")?.text;
    const typeNode = node.childForFieldName("type");
    const target = typeNode?.type === "type_identifier" ? typeNode.text : null;
    if (name && target) {
      typeAliases.push({ name, target, line: node.startPosition.row + 1 });
    }
  }
  return typeAliases;
}

// ── Constructor assignments ──────────────────────────────────────────────────

/** Detect svc := &Server{} or svc := Server{} patterns. */
function extractConstructorAssignments(root: Node): ConstructorAssignment[] {
  const assignments: ConstructorAssignment[] = [];

  // Short var declarations: svc := &Server{}
  for (const node of root.descendantsOfType(["short_var_declaration"])) {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    if (!left || !right) continue;
    const varName =
      left.type === "expression_list"
        ? left.namedChildren[0]?.text
        : left.type === "identifier"
          ? left.text
          : undefined;
    if (!varName || varName.length <= 1) continue;
    const literal = extractCompositeLiteral(right);
    if (literal) {
      assignments.push({
        variableName: varName,
        className: literal,
        callerFn: getEnclosingFunction(node, GO_FN_TYPES),
        line: node.startPosition.row + 1,
      });
    }
  }

  // Var declarations: var svc = Server{}
  for (const node of root.descendantsOfType(["var_spec"])) {
    const nameNode = node.childForFieldName("name");
    const value = node.childForFieldName("value");
    if (!nameNode || !value) continue;
    const varName = nameNode.text;
    if (!varName || varName.length <= 1) continue;
    const literal = extractCompositeLiteral(value);
    if (literal) {
      assignments.push({
        variableName: varName,
        className: literal,
        callerFn: getEnclosingFunction(node, GO_FN_TYPES),
        line: node.startPosition.row + 1,
      });
    }
  }

  return assignments;
}

/**
 * Extract struct type name from a Go composite literal or &Struct{} expression.
 * Returns the type name if it's a capitalized identifier (struct convention).
 */
function extractCompositeLiteral(node: Node): string | null {
  let target = node;
  if (target.type === "expression_list") target = target.namedChildren[0] ?? target;
  if (target.type === "unary_expression") {
    const operand = target.namedChildren[0];
    if (operand) target = operand;
  }
  if (target.type === "composite_literal") {
    const typeNode = target.childForFieldName("type");
    if (typeNode?.type === "type_identifier") {
      const name = typeNode.text;
      if (name && isGoExported(name)) return name;
    }
  }
  return null;
}
