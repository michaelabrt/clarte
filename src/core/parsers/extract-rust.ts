/**
 * Rust file graph extraction.
 */

import type { Node } from "web-tree-sitter";
import type {
  DecoratorEdge,
  FileGraphResult,
  HeritageEdge,
  ImplBlock,
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
  isRustPrimitive,
} from "./extract-file-graph";

const RUST_BODY_IDENT_TYPES = ["identifier", "field_identifier", "type_identifier"];
const RUST_FN_TYPES = ["function_item"];

function isRustPub(node: Node): boolean {
  const vis = node.childForFieldName("visibility_modifier");
  return vis?.text === "pub" || false;
}

export function extractRustFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const implBlocks: ImplBlock[] = [];
  const seenSymbols = new Set<string>();

  extractFunctions(root, symbols, seenSymbols);
  extractTypeDefs(root, symbols, heritageChains, seenSymbols);
  extractImplBlocks(root, symbols, heritageChains, implBlocks, seenSymbols);
  extractCallSites(root, callSites);

  const decorators = extractDecorators(root);
  const typeAliases = extractTypeAliases(root);
  const typeUsages = extractAllTypeUsages(root, symbols);

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

// ── Functions ────────────────────────────────────────────────────────────────

function extractFunctions(root: Node, symbols: SymbolDefinition[], seenSymbols: Set<string>): void {
  for (const node of root.descendantsOfType(["function_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const body = node.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(node);
    const tokens = bodyTokenString(body ?? node, RUST_BODY_IDENT_TYPES);

    symbols.push({
      name,
      kind: "function",
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: isRustPub(node),
    });
  }
}

// ── Structs, enums, traits ───────────────────────────────────────────────────

function extractTypeDefs(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  seenSymbols: Set<string>,
): void {
  for (const node of root.descendantsOfType(["struct_item", "enum_item", "trait_item"])) {
    const name = node.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, node.startPosition.row)) continue;

    const kind: SymbolKind = node.type === "trait_item" ? "trait" : node.type === "enum_item" ? "enum" : "struct";
    const bodyText = getNodeText(node);
    const tokens = bodyTokenString(node, RUST_BODY_IDENT_TYPES);

    symbols.push({
      name,
      kind,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition ? node.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: isRustPub(node),
    });

    if (node.type === "trait_item") extractTraitBounds(node, name, heritageChains);
  }
}

/** Rust trait bounds: trait Foo: Bar + Baz (supertrait relationships). */
function extractTraitBounds(traitNode: Node, traitName: string, out: HeritageEdge[]): void {
  const bounds = traitNode.childForFieldName("bounds");
  if (!bounds) return;
  for (const bound of bounds.namedChildren) {
    const target = bound.type === "type_identifier" ? bound.text : null;
    if (target) out.push({ className: traitName, kind: "extends", target, line: bound.startPosition.row + 1 });
  }
}

// ── Impl blocks ──────────────────────────────────────────────────────────────

function extractImplBlocks(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  implBlocks: ImplBlock[],
  seenSymbols: Set<string>,
): void {
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

    const body = node.childForFieldName("body");
    const methods: string[] = [];
    let derefTarget: string | undefined;

    if (body) {
      for (const fn of body.descendantsOfType(["function_item"])) {
        const name = fn.childForFieldName("name")?.text;
        if (!name || name.length < 2 || name.startsWith("_")) continue;
        methods.push(name);

        if (!isDuplicateSymbol(seenSymbols, name, fn.startPosition.row)) {
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
      }

      // Detect Deref target: type Target = Inner inside impl Deref for Wrapper
      if (traitName === "Deref" || traitName === "std::ops::Deref") {
        for (const typeItem of body.descendantsOfType(["type_item"])) {
          if (typeItem.childForFieldName("name")?.text === "Target") {
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
          callerFn: getEnclosingFunction(call, RUST_FN_TYPES),
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
          callerFn: getEnclosingFunction(call, RUST_FN_TYPES),
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
          callerFn: getEnclosingFunction(call, RUST_FN_TYPES),
          calleeName: name.text,
          line: call.startPosition.row + 1,
          isMemberExpression: true,
          objectName: fnNode.childForFieldName("path")?.text ?? undefined,
          isConstructor: false,
        });
      }
    }
  }
}

// ── Derive macros and attribute macros ───────────────────────────────────────

function extractDecorators(root: Node): DecoratorEdge[] {
  const decorators: DecoratorEdge[] = [];
  for (const node of root.descendantsOfType(["attribute_item"])) {
    const inner = node.namedChildren[0];
    if (!inner) continue;

    const parent = node.parent;
    if (!parent) continue;

    const siblings = parent.namedChildren;
    const nodeIdx = siblings.indexOf(node);
    let targetName: string | null = null;
    for (let i = nodeIdx + 1; i < siblings.length; i++) {
      const sib = siblings[i];
      if (sib.type === "attribute_item") continue;
      targetName = sib.childForFieldName("name")?.text ?? null;
      break;
    }
    if (!targetName) continue;

    if (inner.type === "attribute" || inner.type === "meta_item") {
      const attrName = inner.childForFieldName("name")?.text ?? inner.namedChildren[0]?.text;
      if (attrName === "derive") {
        const args = inner.childForFieldName("arguments") ?? inner.namedChildren.find((c) => c.type === "token_tree");
        if (args) {
          for (const arg of args.namedChildren) {
            if (arg.type === "identifier" || arg.type === "meta_item") {
              decorators.push({ target: targetName, decorator: arg.text, line: node.startPosition.row + 1 });
            }
          }
        }
      } else if (attrName) {
        decorators.push({ target: targetName, decorator: attrName, line: node.startPosition.row + 1 });
      }
    }
  }
  return decorators;
}

// ── Type usages ──────────────────────────────────────────────────────────────

function extractAllTypeUsages(root: Node, symbols: SymbolDefinition[]): TypeUsageEdge[] {
  const typeUsages: TypeUsageEdge[] = [];
  for (const sym of symbols) {
    if (sym.kind !== "function" && sym.kind !== "method") continue;
    const fnNodes = root.descendantsOfType(["function_item"]);
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
  const retType = fnNode.childForFieldName("return_type");

  const typeNodes: Node[] = [];
  if (params) typeNodes.push(...params.descendantsOfType(["type_identifier"]));
  if (retType) typeNodes.push(...retType.descendantsOfType(["type_identifier"]));

  extractTypeUsagesFromNodes(typeNodes, symbolName, isRustPrimitive, out);
}

// ── Type aliases ─────────────────────────────────────────────────────────────

function extractTypeAliases(root: Node): TypeAlias[] {
  const typeAliases: TypeAlias[] = [];
  for (const node of root.descendantsOfType(["type_item"])) {
    // Skip associated types inside impl blocks (e.g., type Target = Inner)
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
    if (target) typeAliases.push({ name, target, line: node.startPosition.row + 1 });
  }
  return typeAliases;
}
