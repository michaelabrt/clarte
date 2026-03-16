import { defineConfig, type Options } from "tsup";
import pkg from "./package.json";

export default defineConfig((options): Options[] => [
  {
    entry: ["src/index.ts"],
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: !options.watch,
    splitting: false,
    external: ["web-tree-sitter", "@modelcontextprotocol/sdk"],
    sourcemap: false,
    dts: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
    define: {
      PKG_VERSION: JSON.stringify(pkg.version),
      PKG_NAME: JSON.stringify(pkg.name),
      PKG_DESCRIPTION: JSON.stringify(pkg.description),
    },
  },
  {
    entry: { "hook-entry": "src/steer/hook-entry.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    outExtension: () => ({ js: ".mjs" }),
    clean: false,
    splitting: false,
    sourcemap: false,
    dts: false,
    noExternal: [/.*/],
  },
  {
    entry: { "mcp-server": "src/mcp/server.ts" },
    format: ["esm"],
    target: "node20",
    outDir: "dist",
    clean: false,
    splitting: false,
    external: ["web-tree-sitter", "@modelcontextprotocol/sdk", "@huggingface/transformers"],
    sourcemap: false,
    dts: false,
    banner: {
      js: "#!/usr/bin/env node",
    },
  },
]);
