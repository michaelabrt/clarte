import { defineConfig } from "tsup";
import { builtinModules } from "node:module";

// Node built-ins as external: CJS deps (@actions/core, @actions/github)
// use require("os") etc. which must become ESM imports, not inlined
// __require shims that throw "Dynamic require not supported".
const nodeBuiltins = builtinModules.flatMap((m) => [m, `node:${m}`]);

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  clean: true,
  splitting: false,
  // Bundle all npm packages into a single file
  noExternal: [/.*/],
  // But keep Node built-ins and WASM loader as runtime imports
  external: [...nodeBuiltins, "web-tree-sitter"],
  sourcemap: false,
  dts: false,
  // Inject createRequire banner so any residual require() calls
  // from CJS deps work in the ESM bundle
  banner: {
    js: 'import { createRequire as __banner_cR } from "node:module"; const require = __banner_cR(import.meta.url);',
  },
});
