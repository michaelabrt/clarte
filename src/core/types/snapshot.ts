/** Extracted code snapshot entry */
export interface SnapshotEntry {
  /** Source file path (relative) */
  file: string;
  /** Category: type, interface, function, component, store, hook */
  category: "type" | "interface" | "function" | "component" | "store" | "hook";
  /** The extracted signature or declaration */
  signature: string;
  /** Number of files that import this file (from import graph) */
  importedByCount?: number;
  /** Number of direct (non-barrel-routed) importers */
  directImportedByCount?: number;
}

/** Full code snapshot result */
export interface CodeSnapshot {
  entries: SnapshotEntry[];
  /** Rendered markdown block */
  markdown: string;
  /** Number of entries excluded by token budget */
  budgetExcluded?: number;
  /** Estimated total tokens for the snapshot */
  estimatedTokens?: number;
}
