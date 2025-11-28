/**
 * AST-based parsing for imports and snapshot extraction using web-tree-sitter.
 *
 * Replaces regex-based parsers in graph.ts and snapshot.ts with tree-sitter AST parsing.
 * Bundles precompiled WASM grammars in dist/wasm/ (JS, TS, TSX, Python, Go, Rust, Java).
 */

import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import path from "node:path";
import type { Language as ClarteLanguage, SnapshotEntry } from "./types.js";

// ── Types ────────────────────────────────────────────────────────────────────

export interface RawImport {
  specifier: string;
  importedNames: string[];
  isTypeOnly?: boolean;
  isDynamic?: boolean;
}

// ── Parser initialization ────────────────────────────────────────────────────

const languages = new Map<string, Language>();
let parser: Parser | null = null;
let initPromise: Promise<void> | null = null;

/**
 * Initialize the tree-sitter WASM runtime and load all language grammars.
 * Must be called once before any parsing. Subsequent calls are no-ops.
 * Safe to call concurrently (deduplicates via shared promise).
 */
export function initTreeSitter(): Promise<void> {
  if (initPromise) return initPromise;

  initPromise = (async () => {
    await Parser.init();
    parser = new Parser();

    // Resolve WASM grammars bundled in dist/wasm/ (copied at build time).
    // From src/ (dev): ../dist/wasm/, from dist/ (prod/binary): ./wasm/
    const selfDir = path.dirname(new URL(import.meta.url).pathname);
    const wasmDir = selfDir.endsWith("src")
      ? path.join(selfDir, "..", "dist", "wasm")
      : path.join(selfDir, "wasm");

    const langFiles: [string, string][] = [
      ["typescript", "tree-sitter-typescript.wasm"],
      ["tsx", "tree-sitter-tsx.wasm"],
      ["javascript", "tree-sitter-javascript.wasm"],
      ["python", "tree-sitter-python.wasm"],
      ["go", "tree-sitter-go.wasm"],
      ["rust", "tree-sitter-rust.wasm"],
      ["java", "tree-sitter-java.wasm"],
    ];

    await Promise.all(
      langFiles.map(async ([name, file]) => {
        const lang = await Language.load(path.join(wasmDir, file));
        languages.set(name, lang);
      }),
    );
  })();

  return initPromise;
}

function getLanguage(lang: ClarteLanguage, filePath?: string): Language {
  if (lang === "typescript" || lang === "javascript") {
    const ext = filePath?.split(".").pop()?.toLowerCase();
    if (ext === "tsx" || ext === "jsx") return languages.get("tsx")!;
    if (ext === "js" || ext === "mjs" || ext === "cjs") return languages.get("javascript")!;
    return languages.get("typescript")!;
  }
  const tsLang = languages.get(lang);
  if (!tsLang) throw new Error(`No tree-sitter grammar loaded for language: ${lang}`);
  return tsLang;
}

function parseSource(content: string, lang: ClarteLanguage, filePath?: string): Node {
  if (!parser) throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  parser.setLanguage(getLanguage(lang, filePath));
  const tree = parser.parse(content);
  if (!tree) throw new Error("Tree-sitter parse returned null");
  return tree.rootNode;
}

// ── Import parsing ───────────────────────────────────────────────────────────

/**
 * Parse imports from source code using tree-sitter AST.
 */
export function parseImportsAst(content: string, lang: ClarteLanguage, filePath?: string): RawImport[] {
  const root = parseSource(content, lang, filePath);

  switch (lang) {
    case "typescript":
    case "javascript":
      return parseJsImportsAst(root);
    case "python":
      return parsePythonImportsAst(root);
    case "go":
      return parseGoImportsAst(root);
    case "rust":
      return parseRustImportsAst(root);
    case "java":
      return parseJavaImportsAst(root);
    default:
      return parseJsImportsAst(root);
  }
}

// ── JS/TS import parsing ─────────────────────────────────────────────────────

function parseJsImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];
  const importSpecifiers = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      const imp = parseJsImportStatement(node);
      if (imp) {
        imports.push(imp);
        importSpecifiers.add(imp.specifier);
      }
    } else if (node.type === "export_statement") {
      // Re-exports: export { Foo } from './module' or export * from './module'
      const source = node.childForFieldName("source");
      if (source) {
        const imp = parseJsExportReexport(node, source);
        if (imp) {
          imports.push(imp);
          importSpecifiers.add(imp.specifier);
        }
      }
    } else if (node.type === "expression_statement" || node.type === "lexical_declaration") {
      // Dynamic import() and require()
      collectDynamicImports(node, imports);
    }
  }

  // require() via AST: find all call_expression with callee "require"
  const requireCalls = root.descendantsOfType("call_expression");
  for (const call of requireCalls) {
    const fn = call.childForFieldName("function");
    if (!fn || fn.type !== "identifier" || fn.text !== "require") continue;
    const args = call.childForFieldName("arguments");
    if (!args) continue;
    const firstArg = args.namedChildren[0];
    if (!firstArg) continue;
    const spec = extractStringContent(firstArg);
    if (spec && !importSpecifiers.has(spec)) {
      importSpecifiers.add(spec);
      imports.push({ specifier: spec, importedNames: [] });
    }
  }

  return imports;
}

function parseJsImportStatement(node: Node): RawImport | null {
  const source = node.childForFieldName("source");
  if (!source) return null;

  const specifier = extractStringContent(source);
  if (!specifier) return null;

  // Check for `type` keyword (import type { ... })
  const isTypeOnly = node.children.some(c => c.type === "type" && !c.isNamed);

  // Side-effect import: import './style.css' (no import_clause)
  const importClause = node.namedChildren.find(c => c.type === "import_clause");
  if (!importClause) {
    return { specifier, importedNames: [], isTypeOnly };
  }

  const names: string[] = [];
  for (const child of importClause.namedChildren) {
    if (child.type === "identifier") {
      // Default import: import Foo from '...'
      names.push(child.text);
    } else if (child.type === "named_imports") {
      // Named imports: import { foo, bar } from '...'
      for (const spec of child.namedChildren) {
        if (spec.type === "import_specifier") {
          const name = spec.childForFieldName("name");
          if (name) names.push(name.text);
        }
      }
    }
    // namespace_import: import * as utils from '...' -> no named imports
  }

  return { specifier, importedNames: names, isTypeOnly };
}

function parseJsExportReexport(exportNode: Node, source: Node): RawImport | null {
  const specifier = extractStringContent(source);
  if (!specifier) return null;

  const isTypeOnly = exportNode.children.some(c => c.type === "type" && !c.isNamed);
  const names: string[] = [];

  const exportClause = exportNode.namedChildren.find(c => c.type === "export_clause");
  if (exportClause) {
    for (const spec of exportClause.namedChildren) {
      if (spec.type === "export_specifier") {
        const name = spec.childForFieldName("name");
        if (name) names.push(name.text);
      }
    }
  }

  return { specifier, importedNames: names, isTypeOnly };
}

function collectDynamicImports(node: Node, imports: RawImport[]): void {
  // Walk descendants looking for dynamic import() calls
  const calls = node.descendantsOfType("call_expression");
  for (const call of calls) {
    const fn = call.childForFieldName("function");
    if (!fn) continue;

    if (fn.type === "import") {
      // dynamic import('...')
      const args = call.childForFieldName("arguments");
      if (args) {
        const firstArg = args.namedChildren[0];
        if (firstArg) {
          const spec = extractStringContent(firstArg);
          if (spec) {
            imports.push({ specifier: spec, importedNames: [], isDynamic: true });
          }
        }
      }
    }
  }
}

function extractStringContent(node: Node): string | null {
  // String nodes have a string_fragment child with the actual content
  const fragment = node.namedChildren.find(
    c => c.type === "string_fragment" || c.type === "string_content",
  );
  if (fragment) return fragment.text;

  // For some grammars the text is the full quoted string
  const text = node.text;
  if ((text.startsWith('"') && text.endsWith('"')) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }

  return null;
}

// ── Python import parsing ────────────────────────────────────────────────────

function parsePythonImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_statement") {
      parsePythonImportStmt(node, imports, false);
    } else if (node.type === "import_from_statement") {
      parsePythonFromImportStmt(node, imports, false);
    } else if (node.type === "if_statement") {
      // TYPE_CHECKING guard
      const condition = node.childForFieldName("condition");
      if (condition && condition.text === "TYPE_CHECKING") {
        const consequence = node.childForFieldName("consequence");
        if (consequence) {
          for (const child of consequence.namedChildren) {
            if (child.type === "import_statement") {
              parsePythonImportStmt(child, imports, true);
            } else if (child.type === "import_from_statement") {
              parsePythonFromImportStmt(child, imports, true);
            }
          }
        }
      }
    }
  }

  return imports;
}

function parsePythonImportStmt(node: Node, imports: RawImport[], isTypeOnly: boolean): void {
  // import foo, bar, baz
  const names = node.childrenForFieldName("name");
  for (const name of names) {
    const specifier = name.text.split(" as ")[0].trim();
    imports.push({ specifier, importedNames: [], isTypeOnly: isTypeOnly || undefined });
  }
}

function parsePythonFromImportStmt(node: Node, imports: RawImport[], isTypeOnly: boolean): void {
  // from module import name1, name2
  const moduleName = node.childForFieldName("module_name");
  if (!moduleName) return;

  const specifier = moduleName.text;
  const nameNodes = node.childrenForFieldName("name");
  const importedNames = nameNodes.map(n => n.text.split(" as ")[0].trim());

  imports.push({ specifier, importedNames, isTypeOnly: isTypeOnly || undefined });
}

// ── Go import parsing ────────────────────────────────────────────────────────

function parseGoImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      // Single or grouped imports
      const specs = node.descendantsOfType("import_spec");
      for (const spec of specs) {
        const pathNode = spec.childForFieldName("path");
        if (pathNode) {
          // Strip quotes from interpreted_string_literal
          const content = pathNode.namedChildren.find(
            c => c.type === "interpreted_string_literal_content",
          );
          const specifier = content ? content.text : pathNode.text.replace(/^"|"$/g, "");
          imports.push({ specifier, importedNames: [] });
        }
      }
    }
  }

  return imports;
}

// ── Rust import parsing ──────────────────────────────────────────────────────

function parseRustImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg) {
        parseRustUsePath(arg, imports);
      }
    } else if (node.type === "mod_item") {
      // mod config;
      const name = node.childForFieldName("name");
      if (name && !node.namedChildren.some(c => c.type === "declaration_list")) {
        // Only external mod declarations (mod foo;), not inline mod blocks
        // Prefix with "mod::" so resolveImport can distinguish from use declarations
        imports.push({ specifier: `mod::${name.text}`, importedNames: [] });
      }
    }
  }

  return imports;
}

function parseRustUsePath(node: Node, imports: RawImport[]): void {
  if (node.type === "scoped_use_list") {
    // use crate::types::{Language, HubFile}
    const pathNode = node.childForFieldName("path");
    const list = node.childForFieldName("list");
    if (pathNode && list) {
      const basePath = pathNode.text;
      const names: string[] = [];
      for (const child of list.namedChildren) {
        if (child.type === "identifier" || child.type === "self") {
          names.push(child.text);
        } else if (child.type === "scoped_identifier") {
          names.push(child.text);
        }
      }
      imports.push({ specifier: `${basePath}::{${names.join(", ")}}`, importedNames: names });
    }
  } else if (node.type === "scoped_identifier") {
    // use crate::graph::ImportGraph
    const specifier = node.text;
    const name = node.childForFieldName("name");
    imports.push({
      specifier,
      importedNames: name ? [name.text] : [],
    });
  } else if (node.type === "use_wildcard") {
    // use crate::prelude::*
    imports.push({ specifier: node.text, importedNames: [] });
  } else if (node.type === "identifier") {
    imports.push({ specifier: node.text, importedNames: [node.text] });
  }
}

// ── Java import parsing ──────────────────────────────────────────────────────

function parseJavaImportsAst(root: Node): RawImport[] {
  const imports: RawImport[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "import_declaration") {
      // The import path is the full text minus "import", "static", and ";"
      const hasAsterisk = node.namedChildren.some(c => c.type === "asterisk");
      const scopedId = node.namedChildren.find(c => c.type === "scoped_identifier");

      if (scopedId) {
        const fullPath = hasAsterisk ? `${scopedId.text}.*` : scopedId.text;
        const parts = fullPath.split(".");
        const lastName = parts[parts.length - 1];
        const names = lastName === "*" ? [] : [lastName];
        imports.push({ specifier: fullPath, importedNames: names });
      }
    }
  }

  return imports;
}

// ── Snapshot extraction ──────────────────────────────────────────────────────

/**
 * Extract snapshot entries from source code using tree-sitter AST.
 */
export function extractSnapshotAst(
  content: string,
  relPath: string,
  lang: ClarteLanguage,
  filePath?: string,
): SnapshotEntry[] {
  const root = parseSource(content, lang, filePath);

  switch (lang) {
    case "typescript":
    case "javascript":
      return extractJsSnapshot(root, content, relPath);
    case "python":
      return extractPythonSnapshot(root, content, relPath);
    case "go":
      return extractGoSnapshot(root, content, relPath);
    case "rust":
      return extractRustSnapshot(root, content, relPath);
    case "java":
      return extractJavaSnapshot(root, content, relPath);
    default:
      return extractJsSnapshot(root, content, relPath);
  }
}

// ── JS/TS snapshot extraction ────────────────────────────────────────────────

function extractJsSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  // Category hints from path (same as regex version)
  const isStore = /stores?[/\\]/.test(relPath);
  const isHook = /hooks?[/\\]/.test(relPath) || relPath.includes("use");
  const isComponent = /components?[/\\]/.test(relPath);
  const isType = /types?[/\\]/.test(relPath) || relPath.endsWith(".types.ts");

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;

    const declaration = node.childForFieldName("declaration");
    if (!declaration) continue;

    const isDefault = node.children.some(c => c.type === "default" && !c.isNamed);

    switch (declaration.type) {
      case "interface_declaration": {
        const name = declaration.childForFieldName("name");
        const category = name?.text.endsWith("Slice") ? "store"
          : name?.text.endsWith("Props") ? "component"
          : "interface" as const;
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category, signature: block });
        break;
      }

      case "type_alias_declaration": {
        const name = declaration.childForFieldName("name");
        const category = name?.text.endsWith("Slice") ? "store"
          : name?.text.endsWith("Props") ? "component"
          : "type" as const;
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category, signature: block });
        break;
      }

      case "enum_declaration": {
        const block = extractNodeBlock(declaration, content, node);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }

      case "function_declaration": {
        const name = declaration.childForFieldName("name")?.text ?? "";

        if (isDefault) {
          let category: SnapshotEntry["category"] = "function";
          if (isHook || name.startsWith("use")) category = "hook";
          else if (isComponent && name[0] === name[0].toUpperCase()) category = "component";
          else if (isStore) category = "store";
          const sig = extractFunctionSignature(declaration, content, node);
          entries.push({ file: relPath, category, signature: sig });
        } else {
          // Skip component function exports
          if (isComponent && name[0] === name[0].toUpperCase() && !name.startsWith("use")) break;

          let category: SnapshotEntry["category"] = "function";
          if (isHook || name.startsWith("use")) category = "hook";
          else if (isStore) category = "store";
          const sig = extractFunctionSignature(declaration, content, node);
          entries.push({ file: relPath, category, signature: sig });
        }
        break;
      }

      case "lexical_declaration": {
        // export const foo = (...) => ...
        const declarator = declaration.namedChildren.find(c => c.type === "variable_declarator");
        if (!declarator) break;

        const name = declarator.childForFieldName("name")?.text ?? "";
        const value = declarator.childForFieldName("value");

        // Only include function expressions (arrow functions, function expressions)
        if (!value || (value.type !== "arrow_function" && value.type !== "function" &&
            value.type !== "function_expression" && value.type !== "call_expression")) {
          break;
        }

        // For call_expression, check if it wraps a function (HOCs, etc.)
        if (value.type === "call_expression") {
          // Only include if the call returns a function-like
          const hasArrowOrFn = value.descendantsOfType("arrow_function").length > 0 ||
            value.descendantsOfType("function").length > 0;
          if (!hasArrowOrFn) break;
        }

        if (isComponent && name[0] === name[0].toUpperCase() && !name.startsWith("use")) break;

        let category: SnapshotEntry["category"] = "function";
        if (isHook || name.startsWith("use")) category = "hook";
        else if (isStore) category = "store";
        const sig = extractConstFunctionSignature(node, content);
        entries.push({ file: relPath, category, signature: sig });
        break;
      }

      case "class_declaration": {
        const category = isComponent ? "component" : "type" as const;
        if (isDefault) {
          const block = extractNodeBlock(declaration, content, node);
          entries.push({ file: relPath, category, signature: block });
        } else {
          const block = extractNodeBlock(declaration, content, node);
          entries.push({ file: relPath, category, signature: block });
        }
        break;
      }
    }
  }

  // Non-exported Props interfaces in component files
  if (isComponent) {
    for (const node of root.namedChildren) {
      if (node.type === "interface_declaration") {
        const name = node.childForFieldName("name");
        if (name?.text.endsWith("Props")) {
          const block = extractNodeBlock(node, content);
          entries.push({ file: relPath, category: "component", signature: block });
        }
      }
    }
  }

  return entries;
}

/**
 * Extract a full block (type, interface, enum, class) from AST using node spans.
 * Caps at 30 lines to match existing behavior.
 */
function extractNodeBlock(
  declaration: Node,
  content: string,
  exportNode?: Node,
): string {
  // Include the "export" keyword if present
  const startNode = exportNode ?? declaration;
  const text = content.slice(startNode.startIndex, declaration.endIndex);

  // Cap at 30 lines
  const lines = text.split("\n");
  if (lines.length > 30) {
    return lines.slice(0, 30).join("\n").trim();
  }
  return text.trim();
}

/**
 * Extract a function signature (everything up to the opening brace).
 * Uses AST to find the statement_block child instead of brace-counting.
 */
function extractFunctionSignature(
  funcDecl: Node,
  content: string,
  exportNode?: Node,
): string {
  const startNode = exportNode ?? funcDecl;
  const body = funcDecl.childForFieldName("body");

  if (body && body.type === "statement_block") {
    // Slice from export/function start to just before the body
    const sig = content.slice(startNode.startIndex, body.startIndex).trim();
    return sig;
  }

  // Fallback: use full text up to first {
  const fullText = content.slice(startNode.startIndex, funcDecl.endIndex);
  const braceIdx = fullText.indexOf("{");
  if (braceIdx >= 0) return fullText.slice(0, braceIdx).trim();
  return fullText.trim();
}

/**
 * Extract signature for `export const foo = (...) => ...`
 * Captures from "export" to just before the arrow function body.
 */
function extractConstFunctionSignature(exportNode: Node, content: string): string {
  const declaration = exportNode.childForFieldName("declaration");
  if (!declaration) return exportNode.text.split("\n")[0];

  const declarator = declaration.namedChildren.find(c => c.type === "variable_declarator");
  if (!declarator) return content.slice(exportNode.startIndex, declaration.endIndex).trim();

  const value = declarator.childForFieldName("value");
  if (!value) return content.slice(exportNode.startIndex, declaration.endIndex).trim();

  // For arrow functions, capture up to the body (or the => for expression bodies)
  if (value.type === "arrow_function") {
    const body = value.childForFieldName("body");
    if (body && body.type === "statement_block") {
      return content.slice(exportNode.startIndex, body.startIndex).trim();
    }
    // Expression body arrow: include the full signature including =>
    // Slice up to the body start
    if (body) {
      const arrow = value.children.find(c => c.type === "=>" && !c.isNamed);
      if (arrow) {
        return content.slice(exportNode.startIndex, arrow.endIndex).trim();
      }
    }
  }

  // Fallback
  const fullText = content.slice(exportNode.startIndex, value.endIndex);
  const braceIdx = fullText.indexOf("{");
  if (braceIdx >= 0) return fullText.slice(0, braceIdx).trim();
  return fullText.split("\n").slice(0, 3).join(" ").trim();
}

// ── Python snapshot extraction ───────────────────────────────────────────────

/** Bases that indicate a "type" category */
const PY_TYPE_BASES = new Set([
  "BaseModel", "TypedDict", "NamedTuple", "Protocol",
]);

/** Decorator names that indicate a dataclass-like */
const PY_DATACLASS_DECORATORS = new Set([
  "dataclass", "dataclasses.dataclass", "attrs", "attr.s", "define",
]);

function extractPythonSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  for (const node of root.namedChildren) {
    if (node.type === "decorated_definition") {
      const decorators = node.namedChildren.filter(c => c.type === "decorator");
      const definition = node.namedChildren.find(
        c => c.type === "class_definition" || c.type === "function_definition",
      );
      if (!definition) continue;

      const decoNames = decorators.map(d => {
        // @decorator or @module.decorator
        const text = d.text.replace(/^@/, "").split("(")[0].trim();
        return text;
      });

      if (definition.type === "class_definition") {
        extractPythonClassEntry(definition, content, relPath, entries, decoNames);
      } else if (definition.type === "function_definition") {
        extractPythonFunctionEntry(definition, content, relPath, entries, decoNames, 0);
      }
    } else if (node.type === "class_definition") {
      extractPythonClassEntry(node, content, relPath, entries, []);
    } else if (node.type === "function_definition") {
      extractPythonFunctionEntry(node, content, relPath, entries, [], 0);
    } else if (node.type === "expression_statement") {
      // Type aliases: Foo = NewType/Union/Optional/...
      const child = node.firstNamedChild;
      if (child?.type === "assignment") {
        const right = child.childForFieldName("right");
        if (right) {
          const rightText = right.text;
          if (/^(?:NewType|Union|Optional|Callable|Literal|TypeVar|Annotated)\b/.test(rightText)) {
            entries.push({ file: relPath, category: "type", signature: node.text.trimStart() });
          }
        }
      }
    }
  }

  return entries;
}

function extractPythonClassEntry(
  node: Node,
  content: string,
  relPath: string,
  entries: SnapshotEntry[],
  decorators: string[],
): void {
  const name = node.childForFieldName("name")?.text ?? "";

  // Get base classes
  const superclassNode = node.childForFieldName("superclasses");
  const baseList: string[] = [];
  if (superclassNode) {
    for (const child of superclassNode.namedChildren) {
      // Handle both simple identifiers and subscripted (Generic[T]) bases
      const baseName = child.text.split("[")[0].split("(")[0].trim();
      if (baseName) baseList.push(baseName);
    }
  }

  const isEnum = baseList.some(b => b === "Enum" || b === "IntEnum" || b === "StrEnum");
  const isProtocol = baseList.some(b => b === "Protocol");
  const isDatalike =
    baseList.some(b => PY_TYPE_BASES.has(b)) ||
    decorators.some(d => PY_DATACLASS_DECORATORS.has(d));

  let category: SnapshotEntry["category"] = "type";
  if (isProtocol) category = "interface";

  if (isDatalike || isEnum || isProtocol) {
    // Data-like: extract full block
    const block = extractPythonBlock(node, content, decorators);
    entries.push({ file: relPath, category, signature: block });
  } else {
    // Non-data class: extract header + public methods
    const decoPrefix = decorators.map(d => `@${d}`).join("\n");
    const classLine = node.text.split("\n")[0].trimStart();
    let header = decoPrefix ? `${decoPrefix}\n${classLine}` : classLine;

    // Look for docstring
    const body = node.childForFieldName("body");
    if (body) {
      const docstring = extractPythonDocstringFromBody(body);
      if (docstring) header += ` # "${docstring}"`;
    }

    entries.push({ file: relPath, category: "type", signature: header });

    // Extract public methods from the class body
    if (body) {
      for (const child of body.namedChildren) {
        let funcNode: Node | null = null;
        let methodDecos: string[] = [];

        if (child.type === "function_definition") {
          funcNode = child;
        } else if (child.type === "decorated_definition") {
          methodDecos = child.namedChildren
            .filter(c => c.type === "decorator")
            .map(d => d.text.replace(/^@/, "").split("(")[0].trim());
          funcNode = child.namedChildren.find(c => c.type === "function_definition") ?? null;
        }

        if (funcNode) {
          const methodName = funcNode.childForFieldName("name")?.text ?? "";
          // Skip private/dunder methods except __init__
          if (methodName.startsWith("_") && methodName !== "__init__") continue;
          extractPythonFunctionEntry(funcNode, content, relPath, entries, methodDecos, 1);
        }
      }
    }
  }
}

function extractPythonFunctionEntry(
  node: Node,
  content: string,
  relPath: string,
  entries: SnapshotEntry[],
  decorators: string[],
  nestLevel: number,
): void {
  const name = node.childForFieldName("name")?.text ?? "";

  // Skip private and test functions at top level
  if (nestLevel === 0 && (name.startsWith("_") || name.startsWith("test_"))) return;

  const sig = extractPythonFuncSignature(node, content, decorators);
  entries.push({ file: relPath, category: "function", signature: sig });
}

function extractPythonBlock(
  node: Node,
  content: string,
  decorators: string[],
): string {
  const maxLines = 30;
  const decoPrefix = decorators.map(d => `@${d}`).join("\n");

  // Get the node text and trim leading indentation from each line
  const lines = node.text.split("\n").map(l => l.trimStart());
  if (lines.length > maxLines) {
    const trimmed = lines.slice(0, maxLines);
    return decoPrefix ? `${decoPrefix}\n${trimmed.join("\n")}` : trimmed.join("\n");
  }

  // Trim trailing blank lines
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  return decoPrefix ? `${decoPrefix}\n${lines.join("\n")}` : lines.join("\n");
}

function extractPythonFuncSignature(
  node: Node,
  content: string,
  decorators: string[],
): string {
  const parts: string[] = [];

  for (const dec of decorators) {
    parts.push(`@${dec}`);
  }

  // Build signature from the def line through the colon
  const params = node.childForFieldName("parameters");
  const returnType = node.childForFieldName("return_type");
  const body = node.childForFieldName("body");

  // Compute signature end: just before the body (the ":" before the block)
  let sigEnd: number;
  if (body) {
    // The colon is between the return type (or params) and the body
    sigEnd = body.startIndex;
  } else {
    sigEnd = node.endIndex;
  }

  // Get the signature text
  let sigText = content.slice(node.startIndex, sigEnd).trimStart();

  // Ensure it ends with ":"
  sigText = sigText.trimEnd();
  if (!sigText.endsWith(":")) {
    // Find the colon
    const colonIdx = sigText.lastIndexOf(":");
    if (colonIdx >= 0) {
      sigText = sigText.slice(0, colonIdx + 1);
    }
  }

  // Collapse multi-line signatures to single line
  sigText = sigText.split("\n").map(l => l.trim()).join(" ");

  parts.push(sigText);

  // Look for docstring
  if (body) {
    const docstring = extractPythonDocstringFromBody(body);
    if (docstring) {
      parts[parts.length - 1] += ` # "${docstring}"`;
    }
  }

  return parts.join("\n");
}

function extractPythonDocstringFromBody(body: Node): string | null {
  // Docstring is the first expression_statement with a string child
  const firstStmt = body.namedChildren[0];
  if (!firstStmt || firstStmt.type !== "expression_statement") return null;

  const stringNode = firstStmt.firstNamedChild;
  if (!stringNode || stringNode.type !== "string") return null;

  let text = stringNode.text;
  // Strip triple quotes
  if (text.startsWith('"""') || text.startsWith("'''")) {
    const quote = text.slice(0, 3);
    text = text.slice(3);
    if (text.endsWith(quote)) text = text.slice(0, -3);
  } else if (text.startsWith('"') || text.startsWith("'")) {
    text = text.slice(1, -1);
  }

  text = text.trim().split("\n")[0].trim();
  if (!text) return null;

  if (text.length > 80) text = text.slice(0, 77) + "...";
  // Normalize single quotes to double quotes
  text = text.replace(/'/g, '"');
  return text;
}

// ── Go snapshot extraction ───────────────────────────────────────────────────

function extractGoSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  // Check for generated file: first comment contains "Code generated"
  const firstComment = root.namedChildren.find(c => c.type === "comment");
  if (firstComment && /Code generated/.test(firstComment.text)) return [];

  for (const node of root.namedChildren) {
    if (node.type === "type_declaration") {
      const specs = node.namedChildren.filter(c => c.type === "type_spec");
      for (const spec of specs) {
        const name = spec.childForFieldName("name")?.text ?? "";
        // Only exported (uppercase)
        if (!name || name[0] !== name[0].toUpperCase()) continue;

        const typeNode = spec.childForFieldName("type");
        if (!typeNode) continue;

        if (typeNode.type === "struct_type" || typeNode.type === "interface_type") {
          const category: SnapshotEntry["category"] = typeNode.type === "interface_type" ? "interface" : "type";
          const block = extractGoNodeBlock(spec, content);
          entries.push({ file: relPath, category, signature: `type ${block}` });
        } else {
          // Type alias or named type
          entries.push({ file: relPath, category: "type", signature: `type ${spec.text.trimStart()}` });
        }
      }
    } else if (node.type === "function_declaration") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (!name || name[0] !== name[0].toUpperCase()) continue;

      const sig = extractGoFuncSig(node, content);
      entries.push({ file: relPath, category: "function", signature: sig });
    } else if (node.type === "method_declaration") {
      const name = node.childForFieldName("name")?.text ?? "";
      if (!name || name[0] !== name[0].toUpperCase()) continue;

      const sig = extractGoMethodSig(node, content);
      entries.push({ file: relPath, category: "function", signature: sig });
    } else if (node.type === "const_declaration") {
      // Const blocks with exported names (enum-like iota patterns)
      const hasExported = node.descendantsOfType("const_spec").some(spec => {
        const name = spec.childForFieldName("name")?.text ?? "";
        return name && name[0] === name[0].toUpperCase();
      });
      if (hasExported) {
        const block = extractGoNodeBlock(node, content);
        entries.push({ file: relPath, category: "type", signature: block });
      }
    }
  }

  return entries;
}

function extractGoNodeBlock(node: Node, content: string): string {
  const text = node.text.split("\n").map(l => l.trimStart());
  if (text.length > 30) return text.slice(0, 30).join("\n").trim();
  return text.join("\n").trim();
}

function extractGoFuncSig(node: Node, content: string): string {
  const body = node.childForFieldName("body");
  if (body) {
    return content.slice(node.startIndex, body.startIndex).trim();
  }
  return node.text.split("{")[0].trim();
}

function extractGoMethodSig(node: Node, content: string): string {
  let sig = extractGoFuncSig(node, content);

  // Rewrite method receivers: func (r *Type) Method(... -> (Type).Method(...
  const receiverMatch = sig.match(/^func\s*\(\w+\s+\*?(\w+)\)\s*(\w+)\((.*)$/);
  if (receiverMatch) {
    const [, receiverType, methodName, rest] = receiverMatch;
    return `(${receiverType}).${methodName}(${rest}`;
  }

  return sig;
}

// ── Rust snapshot extraction ─────────────────────────────────────────────────

function extractRustSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];

  for (const node of root.namedChildren) {
    // Skip #[cfg(test)] modules
    if (node.type === "attribute_item" && node.text.includes("cfg(test)")) {
      // The next sibling should be a mod_item; skip it
      continue;
    }

    if (node.type === "mod_item") {
      // Check if preceded by #[cfg(test)]
      const prev = node.previousNamedSibling;
      if (prev?.type === "attribute_item" && prev.text.includes("cfg(test)")) continue;
    }

    // Only process pub items
    const hasPub = node.namedChildren.some(c => c.type === "visibility_modifier");
    if (!hasPub && node.type !== "impl_item") continue;

    switch (node.type) {
      case "struct_item": {
        const body = node.namedChildren.find(c => c.type === "field_declaration_list");
        if (body) {
          const block = extractGoNodeBlock(node, content);
          entries.push({ file: relPath, category: "type", signature: block });
        } else {
          // Tuple or unit struct
          entries.push({ file: relPath, category: "type", signature: node.text.replace(/;$/, "").trim() });
        }
        break;
      }
      case "enum_item": {
        const block = extractGoNodeBlock(node, content);
        entries.push({ file: relPath, category: "type", signature: block });
        break;
      }
      case "trait_item": {
        const block = extractGoNodeBlock(node, content);
        entries.push({ file: relPath, category: "interface", signature: block });
        break;
      }
      case "type_item": {
        // pub type Foo = ...
        entries.push({ file: relPath, category: "type", signature: node.text.replace(/;$/, "").trim() });
        break;
      }
      case "function_item": {
        const sig = extractRustFuncSig(node, content);
        entries.push({ file: relPath, category: "function", signature: sig });
        break;
      }
      case "impl_item": {
        // Extract pub fn from impl blocks
        const body = node.namedChildren.find(c => c.type === "declaration_list");
        if (body) {
          for (const child of body.namedChildren) {
            if (child.type === "function_item") {
              const hasPubFn = child.namedChildren.some(c => c.type === "visibility_modifier");
              if (hasPubFn) {
                const sig = extractRustFuncSig(child, content);
                entries.push({ file: relPath, category: "function", signature: sig });
              }
            }
          }
        }
        break;
      }
    }
  }

  return entries;
}

function extractRustFuncSig(node: Node, content: string): string {
  const body = node.childForFieldName("body");
  if (body) {
    return content.slice(node.startIndex, body.startIndex).trim();
  }
  const text = node.text;
  const braceIdx = text.indexOf("{");
  if (braceIdx >= 0) return text.slice(0, braceIdx).trim();
  return text.trim();
}

// ── Java snapshot extraction ─────────────────────────────────────────────────

function extractJavaSnapshot(root: Node, content: string, relPath: string): SnapshotEntry[] {
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
  const modifiers = node.namedChildren.find(c => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.text.includes("public");
}

function hasJavaAnnotation(node: Node, name: string): boolean {
  const modifiers = node.namedChildren.find(c => c.type === "modifiers");
  if (!modifiers) return false;
  return modifiers.namedChildren.some(
    c => (c.type === "marker_annotation" || c.type === "annotation") && c.text.includes(name),
  );
}

function extractJavaBlock(node: Node, content: string): string {
  // Include annotations from modifiers
  const text = node.text.split("\n").map(l => l.trimStart());
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

/** JPA/Spring annotations that indicate a field is structurally significant */
const JAVA_SIGNIFICANT_FIELD_ANNOTATIONS = new Set([
  "ManyToOne", "OneToMany", "ManyToMany", "OneToOne",
  "Column", "JoinColumn", "JoinTable", "Id", "EmbeddedId",
  "Embedded", "ElementCollection",
]);

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
      const modifiers = child.namedChildren.find(c => c.type === "modifiers");
      if (!modifiers) continue;
      const hasSignificant = modifiers.namedChildren.some(c => {
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
  const modifiers = node.namedChildren.find(c => c.type === "modifiers");
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

// ── Barrel file detection ────────────────────────────────────────────────────

/**
 * Detect if a file is a barrel file (index.ts that re-exports from other modules).
 */
export function detectBarrelAst(content: string, filePath?: string): {
  isBarrel: boolean;
  reExportCount: number;
  totalStatements: number;
} {
  const root = parseSource(content, "typescript", filePath);

  let reExportCount = 0;
  let totalStatements = 0;

  for (const node of root.namedChildren) {
    if (node.type === "export_statement") {
      totalStatements++;
      // Re-export if it has a source (from '...')
      if (node.childForFieldName("source")) {
        reExportCount++;
      }
    } else if (node.type === "import_statement" || node.type === "lexical_declaration" ||
               node.type === "function_declaration" || node.type === "class_declaration" ||
               node.type === "interface_declaration" || node.type === "type_alias_declaration" ||
               node.type === "enum_declaration" || node.type === "expression_statement") {
      totalStatements++;
    }
  }

  return {
    isBarrel: totalStatements > 0 && reExportCount / totalStatements > 0.5,
    reExportCount,
    totalStatements,
  };
}

/**
 * Resolve barrel file re-exports to their source modules.
 */
export function resolveBarrelExportsAst(content: string, filePath?: string): {
  namedExports: Map<string, string>;
  starExports: Set<string>;
} {
  const root = parseSource(content, "typescript", filePath);
  const namedExports = new Map<string, string>();
  const starExports = new Set<string>();

  for (const node of root.namedChildren) {
    if (node.type !== "export_statement") continue;
    const source = node.childForFieldName("source");
    if (!source) continue;

    const specifier = extractStringContent(source);
    if (!specifier) continue;

    // Check for star export: export * from '...'
    const hasStar = node.children.some(c => c.type === "*" && !c.isNamed);
    if (hasStar) {
      starExports.add(specifier);
      continue;
    }

    // Named re-exports: export { Foo, Bar } from '...'
    const exportClause = node.namedChildren.find(c => c.type === "export_clause");
    if (exportClause) {
      for (const spec of exportClause.namedChildren) {
        if (spec.type === "export_specifier") {
          const name = spec.childForFieldName("name");
          if (name) {
            namedExports.set(name.text, specifier);
          }
        }
      }
    }
  }

  return { namedExports, starExports };
}
