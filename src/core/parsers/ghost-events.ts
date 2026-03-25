/**
 * Event binding ghost edge detector.
 *
 * Scans call sites for .on() and .emit() patterns. Groups by objectName
 * (the emitter/bus instance) and creates ghost edges from handler scopes
 * to emitter scopes when both on and emit are observed on the same object.
 */

import type { FileGraphResult } from "../graph/symbol-types";
import type { GhostEdgeCandidate } from "../graph/ghost-types";
import { GHOST_CONFIDENCE } from "../graph/ghost-types";

/** Maximum ratio of files an objectName can appear in before being filtered */
const FREQUENCY_CEILING = 0.1;

/** Absolute cap on ghost edges per objectName to prevent O(n*m) blowup */
const MAX_EDGES_PER_EMITTER = 50;

interface EmitterInfo {
  onSites: Array<{ file: string; callerFn: string; line: number }>;
  emitSites: Array<{ file: string; callerFn: string; line: number }>;
  fileCount: Set<string>;
}

export function detectEventEdges(
  fileGraphResults: Map<string, FileGraphResult>,
  fileCount: number,
): GhostEdgeCandidate[] {
  // Group on/emit call sites by objectName
  const emitters = new Map<string, EmitterInfo>();

  for (const [filePath, result] of fileGraphResults) {
    for (const cs of result.callSites) {
      if (!cs.isMemberExpression || !cs.objectName) continue;
      if (cs.calleeName !== "on" && cs.calleeName !== "emit") continue;
      if (!cs.callerFn) continue;

      let info = emitters.get(cs.objectName);
      if (!info) {
        info = { onSites: [], emitSites: [], fileCount: new Set() };
        emitters.set(cs.objectName, info);
      }
      info.fileCount.add(filePath);

      const site = { file: filePath, callerFn: cs.callerFn, line: cs.line };
      if (cs.calleeName === "on") {
        info.onSites.push(site);
      } else {
        info.emitSites.push(site);
      }
    }
  }

  const candidates: GhostEdgeCandidate[] = [];

  for (const [objectName, info] of emitters) {
    // Frequency filter: skip if objectName appears in >10% of files
    if (info.fileCount.size / fileCount > FREQUENCY_CEILING) continue;
    // Must have both on and emit
    if (info.onSites.length === 0 || info.emitSites.length === 0) continue;

    // Create edges from each emitter to each handler (capped to prevent quadratic blowup)
    let edgeCount = 0;
    for (const emitSite of info.emitSites) {
      for (const onSite of info.onSites) {
        if (edgeCount >= MAX_EDGES_PER_EMITTER) break;
        // Skip self-edges (same function in same file)
        if (emitSite.file === onSite.file && emitSite.callerFn === onSite.callerFn) continue;

        candidates.push({
          fromFile: emitSite.file,
          fromSymbol: emitSite.callerFn,
          toFile: onSite.file,
          toSymbol: onSite.callerFn,
          kind: "ghost:event_bind",
          confidence: GHOST_CONFIDENCE,
          line: emitSite.line,
          evidence: {
            pattern: "event_emitter_pairing",
            eventName: objectName,
          },
        });
        edgeCount++;
      }
      if (edgeCount >= MAX_EDGES_PER_EMITTER) break;
    }
  }

  return candidates;
}
