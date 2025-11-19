/**
 * Copies only the WASM grammars clarte uses into dist/wasm/.
 * Runs as a postbuild step: `tsup && node scripts/copy-wasm.js`
 *
 * This avoids shipping the full @vscode/tree-sitter-wasm package (22 MB)
 * when we only need 7 grammars + the runtime (5.4 MB).
 */

import { cpSync, mkdirSync, statSync } from "node:fs";
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

mkdirSync(wasmDest, { recursive: true });

let totalBytes = 0;
for (const file of files) {
  cpSync(path.join(wasmSrc, file), path.join(wasmDest, file));
  totalBytes += statSync(path.join(wasmDest, file)).size;
}

console.log(`Copied ${files.length} WASM grammars to dist/wasm/ (${(totalBytes / 1024 / 1024).toFixed(1)} MB)`);
