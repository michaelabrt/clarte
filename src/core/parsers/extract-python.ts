/**
 * Python file graph extraction.
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
  TypeAlias,
} from "../graph/symbol-types";
import { bodyTokenString, getEnclosingFunction, getNodeText, hashBody, isDuplicateSymbol } from "./extract-file-graph";

const PY_BODY_IDENT_TYPES = ["identifier"];
const PY_FN_TYPES = ["function_definition"];

export function extractPythonFileGraph(root: Node): Omit<FileGraphResult, "imports"> {
  const symbols: SymbolDefinition[] = [];
  const callSites: RawCallSite[] = [];
  const heritageChains: HeritageEdge[] = [];
  const decorators: DecoratorEdge[] = [];
  const seenSymbols = new Set<string>();

  extractSymbols(root, symbols, heritageChains, decorators, seenSymbols);
  extractCallSites(root, callSites);

  const constructorAssignments = extractConstructorAssignments(root);
  const typeAliases = extractTypeAliases(root);

  return {
    symbols,
    callSites,
    heritageChains,
    decorators,
    typeUsages: [],
    constructorAssignments,
    embeddings: [],
    implBlocks: [],
    typeAliases,
    semanticEdges: [],
  };
}

// ── Symbols ──────────────────────────────────────────────────────────────────

function extractSymbols(
  root: Node,
  symbols: SymbolDefinition[],
  heritageChains: HeritageEdge[],
  decorators: DecoratorEdge[],
  seenSymbols: Set<string>,
): void {
  for (const node of root.descendantsOfType(["function_definition", "class_definition", "decorated_definition"])) {
    const actual = node.type === "decorated_definition" ? unwrapDecorated(node) : node;
    if (!actual) continue;

    const name = actual.childForFieldName("name")?.text;
    if (!name || name.length < 2 || name.startsWith("_")) continue;
    if (isDuplicateSymbol(seenSymbols, name, actual.startPosition.row)) continue;

    const isMethod = isInsideClass(actual);
    const kind: SymbolKind = actual.type === "class_definition" ? "class" : isMethod ? "method" : "function";
    const body = actual.childForFieldName("body");
    const bodyText = body ? getNodeText(body) : getNodeText(actual);
    const tokens = bodyTokenString(body ?? actual, PY_BODY_IDENT_TYPES);

    const sym: SymbolDefinition = {
      name,
      kind,
      startLine: actual.startPosition.row + 1,
      endLine: actual.endPosition ? actual.endPosition.row + 1 : undefined,
      bodyTokens: tokens,
      bodyHash: hashBody(bodyText),
      isExported: !name.startsWith("_"),
    };

    if (actual.type === "class_definition") {
      const { bases, metaclass } = extractHeritage(actual, name, heritageChains);
      if (bases.length > 0) sym.bases = bases;
      if (metaclass) sym.metaclass = metaclass;
    }

    if (node.type === "decorated_definition") {
      extractDecorators(node, name, decorators);
    }

    symbols.push(sym);
  }
}

function unwrapDecorated(node: Node): Node | null {
  for (const child of node.namedChildren) {
    if (child.type === "function_definition" || child.type === "class_definition") return child;
  }
  return null;
}

function isInsideClass(node: Node): boolean {
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

// ── Heritage ─────────────────────────────────────────────────────────────────

/**
 * Python heritage with metaclass separation.
 * class Foo(Bar, Baz, metaclass=Meta) extracts Bar and Baz as extends,
 * metaclass as a separate field to prevent C3 linearization false-positives.
 */
function extractHeritage(
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
      const key = arg.childForFieldName("name");
      const value = arg.childForFieldName("value");
      if (key?.text === "metaclass" && value) {
        metaclass = value.type === "identifier" ? value.text : value.text;
      }
      continue;
    }
    const target = arg.type === "identifier" ? arg.text : arg.type === "attribute" ? arg.text : null;
    if (target && target.length > 1 && target !== "object") {
      out.push({ className, kind: "extends", target, line: arg.startPosition.row + 1, ordinal });
      bases.push(target);
      ordinal++;
    }
  }
  return { bases, metaclass };
}

// ── Decorators ───────────────────────────────────────────────────────────────

function extractDecorators(decoratedNode: Node, targetName: string, out: DecoratorEdge[]): void {
  for (const child of decoratedNode.namedChildren) {
    if (child.type !== "decorator") continue;
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
    if (name) out.push({ target: targetName, decorator: name, line: child.startPosition.row + 1 });
  }
}

// ── Call sites ───────────────────────────────────────────────────────────────

function extractCallSites(root: Node, callSites: RawCallSite[]): void {
  for (const call of root.descendantsOfType("call")) {
    const fnNode = call.childForFieldName("function");
    if (!fnNode) continue;

    if (fnNode.type === "identifier") {
      const name = fnNode.text;
      if (name && name.length > 1) {
        callSites.push({
          callerFn: getEnclosingFunction(call, PY_FN_TYPES),
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
        const isSuperCall = obj.type === "call" && obj.childForFieldName("function")?.text === "super";
        callSites.push({
          callerFn: getEnclosingFunction(call, PY_FN_TYPES),
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
}

// ── Constructor assignments ──────────────────────────────────────────────────

/** Detect obj = ClassName() (no `new` keyword in Python). */
function extractConstructorAssignments(root: Node): ConstructorAssignment[] {
  const assignments: ConstructorAssignment[] = [];
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
    if (
      !className ||
      !varName ||
      className[0] !== className[0].toUpperCase() ||
      className[0] === className[0].toLowerCase()
    )
      continue;
    assignments.push({
      variableName: varName,
      className,
      callerFn: getEnclosingFunction(node, PY_FN_TYPES),
      line: node.startPosition.row + 1,
    });
  }
  return assignments;
}

// ── Type aliases ─────────────────────────────────────────────────────────────

function extractTypeAliases(root: Node): TypeAlias[] {
  const typeAliases: TypeAlias[] = [];

  // Python 3.12+ syntax: type Foo = Bar
  for (const node of root.descendantsOfType(["type_alias_statement"])) {
    const nameNode = node.childForFieldName("name");
    const valueNode = node.childForFieldName("value");
    if (!nameNode || !valueNode) continue;
    const aliasName = nameNode.text;
    const target = valueNode.type === "identifier" ? valueNode.text : null;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({ name: aliasName, target, line: node.startPosition.row + 1 });
    }
  }

  // Pre-3.12: Foo: TypeAlias = Bar
  for (const node of root.descendantsOfType(["assignment"])) {
    const left = node.childForFieldName("left");
    const right = node.childForFieldName("right");
    const typeAnnotation = node.childForFieldName("type");
    if (!left || !right || !typeAnnotation) continue;
    if (left.type !== "identifier" || right.type !== "identifier") continue;
    if (!typeAnnotation.text.includes("TypeAlias")) continue;
    const aliasName = left.text;
    const target = right.text;
    if (aliasName && target && target.length > 1) {
      typeAliases.push({ name: aliasName, target, line: node.startPosition.row + 1 });
    }
  }

  return typeAliases;
}
