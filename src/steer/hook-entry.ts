/**
 * Bundle entry point for hooks. Re-exports everything that hook scripts need.
 * Built by tsup into a self-contained ESM module (dist/hook-entry.mjs).
 * Copied to .clarte/hooks/bm25f.mjs at init time.
 */
export {
  resolveEditTargets,
  rankSymbols,
  tokenizeQuery,
  tokenizeQueryForSymbols,
  shouldSkipPreFlight,
  promptMentionsTargets,
} from "./targets-resolve";
export { renderTaskContext, renderFallbackContext } from "./render-task-context";
export { resolveTargetsFromHistory } from "./git-fallback";
export type { GitFallbackResult } from "./git-fallback";
export { isTestFile } from "../core/utils";
export type { PersistedGraph } from "../core/types/persisted-graph";
export type { SymbolMatch } from "./targets-resolve";
