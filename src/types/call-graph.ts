export interface CallSite {
  /** File containing the call expression (relative path) */
  caller: string;
  /** Enclosing function/method name, or "" for module top-level */
  callerFn: string;
  /** Name of the function/method being called */
  callee: string;
  /** File where callee is defined (relative), null if unresolved/external */
  calleeFile: string | null;
  /** 1-based line number of the call expression */
  line: number;
}

export interface PersistedCallGraph {
  version: 1;
  timestamp: string;
  /** All resolved call sites (calleeFile !== null). Unresolved/built-in calls are excluded. */
  sites: CallSite[];
  /** Per-file content hashes for incremental invalidation */
  fileHashes: Record<string, string>;
}

/** "file::FnName" -> CallSite[] where that function is called */
export type CallerIndex = Map<string, CallSite[]>;

/** "file" -> CallSite[] of all calls made from that file */
export type FileCallIndex = Map<string, CallSite[]>;
