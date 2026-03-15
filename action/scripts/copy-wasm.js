import { cpSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const require = createRequire(import.meta.url);
const wasmSrc = path.join(
  path.dirname(require.resolve("@vscode/tree-sitter-wasm/package.json")),
  "wasm",
);
const wasmDest = path.join(import.meta.dirname, "..", "dist", "wasm");

const files = [
  "tree-sitter.wasm",
  "tree-sitter-typescript.wasm",
  "tree-sitter-tsx.wasm",
  "tree-sitter-javascript.wasm",
  "tree-sitter-python.wasm",
  "tree-sitter-go.wasm",
  "tree-sitter-rust.wasm",
  "tree-sitter-java.wasm",
];

const distDir = path.join(import.meta.dirname, "..", "dist");

mkdirSync(wasmDest, { recursive: true });
for (const file of files) {
  cpSync(path.join(wasmSrc, file), path.join(wasmDest, file));
}

// Copy the tree-sitter runtime WASM next to the bundle (web-tree-sitter
// resolves it via import.meta.url, which points to dist/index.js)
const runtimeSrc = path.join(
  path.dirname(require.resolve("web-tree-sitter")),
  "web-tree-sitter.wasm",
);
cpSync(runtimeSrc, path.join(distDir, "web-tree-sitter.wasm"));

console.log(`Copied ${files.length} grammar WASMs to dist/wasm/ + runtime to dist/`);
