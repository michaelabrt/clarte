/** Co-change coupling between two files */
export interface ChangeCoupling {
  fileA: string;
  fileB: string;
  /** Number of commits both files appeared in together */
  coChangeCount: number;
  /** Fraction of commits containing either file that contain both */
  support: number;
  /** Confidence: coChangeCount / max(commitsA, commitsB) */
  confidence: number;
  /** Directional: P(fileB changes | fileA changes) = coChangeCount / commitsA */
  confidenceAB?: number;
  /** Directional: P(fileA changes | fileB changes) = coChangeCount / commitsB */
  confidenceBA?: number;
  /** Days since the most recent commit that changed both files (for temporal decay) */
  lastCochangeDays?: number;
}

/** Lag-adjusted temporal coupling (files that change within 1-3 commits of each other) */
export interface LagCoupling {
  fileA: string;
  fileB: string;
  /** Number of same-commit co-changes */
  sameCommitCount: number;
  /** Weighted lag coupling score (inverse-lag weighted) */
  lagScore: number;
}

/** Per-symbol blame record for temporal decay */
export interface SymbolBlameRecord {
  symbolId: number;
  daysSinceModified: number;
}

/** Git activity analysis results */
export interface GitAnalysis {
  /** Map of relative file path -> commit count in analysis window */
  commitCounts: Map<string, number>;
  /** Files sorted by commit count descending */
  hotFiles: Array<{
    path: string;
    commits: number;
    lastChanged: string;
  }>;
  /** Co-change coupling pairs (files that change together) */
  changeCoupling: ChangeCoupling[];
  /** Lag-adjusted temporal coupling pairs (reactive co-change within 1-3 commits) */
  lagCouplings?: LagCoupling[];
  /** Per-file code churn (lines added/removed) in the analysis window */
  fileChurn?: Map<string, { linesAdded: number; linesRemoved: number }>;
}
