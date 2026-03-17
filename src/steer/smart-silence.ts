/**
 * RFC-002 SS2.5: Smart Silence gatekeeper.
 *
 * Evaluates four suppression conditions in priority order.
 * When the system cannot make a reliable prediction, it stays silent
 * rather than hallucinating file targets.
 *
 * Conditions (first match wins):
 * 1. All predictions below threshold
 * 2. User query explicitly names target files
 * 3. Graph is stale (predicted files changed since last index)
 * 4. Project too small for graph-based prediction
 */

import type { IntentPrediction } from "../core/config/intent-constants";
import { THETA_LOW, STALE_FILE_OVERLAP_THRESHOLD, MIN_PROJECT_FILES } from "../core/config/intent-constants";
import { promptMentionsTargets } from "./targets-resolve";

// -- Types --------------------------------------------------------------------

export interface SilenceResult {
  shouldSuppress: boolean;
  reason: string | null;
  /** True if graph signal is suppressed but BM25F lexical results remain valid */
  fallbackToLexical: boolean;
}

// -- Main evaluator -----------------------------------------------------------

/**
 * Evaluate whether predictions should be suppressed.
 *
 * @param predictions - verified predictions from Phase 2
 * @param query - the user's original task prompt
 * @param fileCount - total files in the project
 * @param _graphCommit - commit hash when graph was built (reserved for future use)
 * @param _headCommit - current HEAD commit hash (reserved for future use)
 * @param changedFilesSinceGraph - files modified since the graph was built
 * @param predictedFiles - file paths from the predictions
 */
export function evaluateSmartSilence(
  predictions: IntentPrediction[],
  query: string,
  fileCount: number,
  _graphCommit: string,
  _headCommit: string,
  changedFilesSinceGraph: string[],
  predictedFiles: string[],
): SilenceResult {
  // 1. All below threshold
  if (predictions.length === 0 || predictions.every((p) => p.score <= THETA_LOW)) {
    return { shouldSuppress: true, reason: "all below threshold", fallbackToLexical: false };
  }

  // 2. Explicit paths in query
  if (promptMentionsTargets(query, predictedFiles)) {
    return { shouldSuppress: true, reason: "explicit paths", fallbackToLexical: false };
  }

  // 3. Stale graph
  if (predictedFiles.length > 0) {
    const changedSet = new Set(changedFilesSinceGraph);
    let overlapCount = 0;
    for (const f of predictedFiles) {
      if (changedSet.has(f)) overlapCount++;
    }
    const overlap = overlapCount / predictedFiles.length;
    if (overlap > STALE_FILE_OVERLAP_THRESHOLD) {
      return { shouldSuppress: false, reason: "stale graph", fallbackToLexical: true };
    }
  }

  // 4. Tiny project
  if (fileCount < MIN_PROJECT_FILES) {
    return { shouldSuppress: true, reason: "small project", fallbackToLexical: false };
  }

  // 5. No suppression
  return { shouldSuppress: false, reason: null, fallbackToLexical: false };
}
