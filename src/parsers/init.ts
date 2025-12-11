import { Parser, Language } from "web-tree-sitter";
import type { Node } from "web-tree-sitter";
import path from "node:path";
import type { Language as ClarteLanguage } from "../types.js";

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
    // Dev: import.meta.url is in src/parsers/ -> ../../dist/wasm/
    // Prod: tsup bundles into dist/index.js -> ./wasm/
    const selfDir = path.dirname(new URL(import.meta.url).pathname);
    const wasmDir = selfDir.includes("/src")
      ? path.join(selfDir, "..", "..", "dist", "wasm")
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

    try {
      await Promise.all(
        langFiles.map(async ([name, file]) => {
          const lang = await Language.load(path.join(wasmDir, file));
          languages.set(name, lang);
        }),
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to load tree-sitter WASM grammars from ${wasmDir}: ${msg}. ` +
          "Run 'npm install' or 'npm run build' to restore missing files.",
      );
    }
  })();

  return initPromise;
}

export function getLanguage(lang: ClarteLanguage, filePath?: string): Language {
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

export function parseSource(content: string, lang: ClarteLanguage, filePath?: string): Node {
  if (!parser) throw new Error("Tree-sitter not initialized. Call initTreeSitter() first.");
  parser.setLanguage(getLanguage(lang, filePath));
  const tree = parser.parse(content);
  if (!tree) throw new Error("Tree-sitter parse returned null");
  return tree.rootNode;
}
