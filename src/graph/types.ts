import type { FileRole } from "../types.js";

export const PERSISTED_GRAPH_VERSION = 1;

export interface PersistedGraph {
  version: typeof PERSISTED_GRAPH_VERSION;
  timestamp: string;
  headCommit?: string;
  files: Record<string, FileRecord>;
  edges: EdgeRecord[];
  communities: Array<{ id: number; files: string[]; label: string }>;
  changeCoupling: Array<{
    fileA: string;
    fileB: string;
    confidence: number;
    coChangeCount: number;
  }>;
  structuralMismatches: Array<{
    fileA: string;
    fileB: string;
    graphDistance: number;
    coChangeConfidence: number;
    coChangeCount: number;
  }>;
  testMapping: Record<string, string[]>;
  lagCouplings: Array<{ fileA: string; fileB: string; lagScore: number }>;
}

export interface FileRecord {
  role: FileRole | null;
  authority: number;
  hubScore: number;
  betweenness: number;
  instability: number | null;
  importedByCount: number;
  isChokepoint: boolean;
  separatesComponents: number;
  isCrossCutting: boolean;
  layerSpread: number;
  layers: string[];
  hasTests: boolean;
  testFiles: string[];
  communityId: number | null;
}

export interface EdgeRecord {
  from: string;
  to: string;
  importedNames: string[];
  isTypeOnly?: boolean;
  isDynamic?: boolean;
  isBarrelRouted?: boolean;
}
