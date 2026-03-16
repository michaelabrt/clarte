import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import path from "node:path";
import type { Language as ClarteLanguage } from "../types.js";
import { errorMessage } from "../utils.js";

const languages = new Map<string, Language>();
let parser: Parser | null = null;
let parserReady: Promise<void> | null = null;

const LANG_FILES: Record<string, string> = {
  typescript: "tree-sitter-typescript.wasm",
  tsx: "tree-sitter-tsx.wasm",
  javascript: "tree-sitter-javascript.wasm",
  python: "tree-sitter-python.wasm",
  go: "tree-sitter-go.wasm",
  rust: "tree-sitter-rust.wasm",
  java: "tree-sitter-java.wasm",
};

function getWasmDir(): string {
  const selfDir = path.dirname(new URL(import.meta.url).pathname);
  return selfDir.includes("/src/core/parsers")
    ? path.join(selfDir, "..", "..", "..", "dist", "wasm")
    : path.join(selfDir, "wasm");
}

const langPromises = new Map<string, Promise<void>>();

async function ensureLanguage(name: string): Promise<void> {
  if (languages.has(name)) return;
  if (!langPromises.has(name)) {
    langPromises.set(
      name,
      (async () => {
        const wasmFile = LANG_FILES[name];
        if (!wasmFile) throw new Error(`Unknown tree-sitter language: ${name}`);
        const wasmDir = getWasmDir();
        try {
          const lang = await Language.load(path.join(wasmDir, wasmFile));
          languages.set(name, lang);
        } catch (err) {
          langPromises.delete(name);
          const msg = errorMessage(err);
          throw new Error(
            `Failed to load tree-sitter WASM grammar '${name}' from ${wasmDir}: ${msg}. ` +
              "Run 'npm install' or 'npm run build' to restore missing files.",
          );
        }
      })(),
    );
  }
  return langPromises.get(name);
}

/**
 * Map a ClarteLanguage to the tree-sitter grammar names it requires.
 */
function getRequiredGrammars(lang: ClarteLanguage): string[] {
  switch (lang) {
    case "typescript":
      return ["typescript", "tsx", "javascript"];
    case "javascript":
      return ["javascript", "tsx"];
    case "python":
      return ["python"];
    case "go":
      return ["go"];
    case "rust":
      return ["rust"];
    case "java":
      return ["java"];
    default:
      return ["typescript", "tsx", "javascript"];
  }
}

/**
 * Ensure the WASM runtime and Parser singleton are initialized.
 * Separated from grammar loading so initTreeSitter and initForLanguage
 * share the parser without accidentally skipping grammar loads.
 */
async function ensureParser(): Promise<void> {
  if (!parserReady) {
    parserReady = (async () => {
      // Parser.init() loads web-tree-sitter.wasm from its own node_modules dir.
      // Language grammars (tree-sitter-*.wasm) are loaded from dist/wasm/ via
      // ensureLanguage(). These are two different WASM binaries: the core runtime
      // vs the language-specific grammars - so they use different paths.
      await Parser.init();
      parser = new Parser();
    })();
  }
  return parserReady;
}

/**
 * Initialize the tree-sitter WASM runtime and load all language grammars.
 * Backward-compatible: loads ALL grammars eagerly.
 * Safe to call concurrently (deduplicates via shared promise).
 */
export async function initTreeSitter(): Promise<void> {
  await ensureParser();
  await Promise.all(Object.keys(LANG_FILES).map(ensureLanguage));
}

/**
 * Initialize the tree-sitter runtime and load only the grammars needed for a language.
 * Preferred over initTreeSitter() to avoid loading unused grammars.
 */
export async function initForLanguage(lang: ClarteLanguage): Promise<void> {
  await ensureParser();
  const grammars = getRequiredGrammars(lang);
  await Promise.all(grammars.map(ensureLanguage));
}

export function getLanguage(lang: ClarteLanguage, filePath?: string): Language {
  if (lang === "typescript" || lang === "javascript") {
    const ext = filePath ? path.extname(filePath).slice(1).toLowerCase() : undefined;
    if (ext === "tsx" || ext === "jsx") return languages.get("tsx") as Language;
    if (ext === "js" || ext === "mjs" || ext === "cjs") return languages.get("javascript") as Language;
    return languages.get("typescript") as Language;
  }
  const tsLang = languages.get(lang);
  if (!tsLang) throw new Error(`No tree-sitter grammar loaded for language: ${lang}. Call initForLanguage() first.`);
  return tsLang;
}

/**
 * Parse content and pass the root node to a callback. The tree's WASM memory
 * is freed after the callback returns, making it structurally impossible to leak.
 */
export function withParsedTree<T>(
  content: string,
  lang: ClarteLanguage,
  filePath: string | undefined,
  fn: (root: Node) => T,
): T {
  if (!parser) throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  parser.setLanguage(getLanguage(lang, filePath));
  const tree = parser.parse(content);
  if (!tree) throw new Error("Tree-sitter parse returned null");
  try {
    return fn(tree.rootNode);
  } finally {
    tree.delete();
  }
}

/**
 * @deprecated Use withParsedTree for proper WASM memory management.
 * This function leaks tree-sitter Tree objects because tree.delete() cannot
 * be called before returning rootNode (it would invalidate the node).
 */
export function parseSource(content: string, lang: ClarteLanguage, filePath?: string): Node {
  if (!parser) throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  parser.setLanguage(getLanguage(lang, filePath));
  const tree = parser.parse(content);
  if (!tree) throw new Error("Tree-sitter parse returned null");
  return tree.rootNode;
}
