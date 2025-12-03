// Re-export facade: all implementations live in src/parsers/ submodules.
// Existing imports from "./ast-parse.js" continue to work unchanged.

export type { RawImport } from "./parsers/types.js";
export { initTreeSitter } from "./parsers/init.js";
export { parseImportsAst } from "./parsers/parse-imports.js";
export { extractSnapshotAst } from "./parsers/extract-snapshot.js";
export { detectBarrelAst, resolveBarrelExportsAst } from "./parsers/barrel.js";
