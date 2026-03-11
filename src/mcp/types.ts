import type { PersistedGraph } from "../types/persisted-graph.js";
import type { PersistedCallGraph, CallerIndex, FileCallIndex } from "../types/call-graph.js";

export interface EdgeEntry {
  from: string;
  to: string;
  importedNames: string[];
}

export interface ServerState {
  rootDir: string;
  graph: PersistedGraph | null;
  callGraph: PersistedCallGraph | null;
  callerIndex: CallerIndex;
  fileCallIndex: FileCallIndex;
  edgesByTarget: Map<string, EdgeEntry[]>;
  graphMtime: number;
  callGraphMtime: number;
}
