import { defineConfig } from "tsup";
import pkg from "./package.json";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
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
});
