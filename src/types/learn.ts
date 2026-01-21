export interface ToolEvent {
  tool: "Read" | "Grep" | "Glob" | "Write" | "Edit" | "Bash" | string;
  filePath?: string;
  relativePath?: string;
  pattern?: string;
  command?: string;
  succeeded: boolean;
  timestamp: string;
  toolUseId: string;
  /** Files mentioned in the tool's result (for search-then-find linking) */
  resultFiles?: string[];
}

export interface ParsedSession {
  sessionId: string;
  slug?: string;
  cliVersion: string;
  rootDir: string;
  events: ToolEvent[];
  turnCount: number;
  skippedLines: number;
}

export interface IdealFile {
  role: "edited" | "dependent" | "dependency" | "test" | "co-change" | "hidden-dep";
  source: string;
}

export interface Observation {
  type: string;
  section: string;
  file: string;
  relatedFile?: string;
  detail: string;
  eventIndex: number;
  positive?: boolean;
}

export interface LearnResult {
  version: 1;
  sessionId: string;
  slug?: string;
  cliVersion: string;
  totalEvents: number;
  turnCount: number;
  editedFiles: string[];
  idealContextSize: number;
  observations: Observation[];
  bySection: Record<string, { total: number; positive: number; negative: number }>;
  diagnostics: {
    /** Files in ideal set the agent never touched */
    missedIdealFiles: string[];
    /** Unique files read by agent */
    readFiles: string[];
    /** Precision: unique reads in ideal set / total unique reads (verbose-only, ignores read frequency) */
    precision: number;
    /** Recall: ideal files read / total ideal files (verbose-only) */
    recall: number;
    /** Lines that failed to parse */
    skippedLines: number;
  };
}
