/**
 * Inverse Node Frequency (INF) edge attenuation.
 *
 * Replaces the hardcoded Domain-Terminal Filter with an information-theoretic
 * measure. The amount of "intent" an edge transmits is inversely proportional
 * to the target's directed indegree, scaled by a hub/sink discriminator that
 * preserves flow through legitimate hubs (barrel files, facades) while choking
 * pure utility sinks (loggers, formatters).
 *
 * All degrees are strictly directed to avoid penalizing sibling modules or
 * circular dependencies.
 */

import { INF_FLOOR, INF_CEILING, HUB_SINK_FLOOR } from "../config/fusion-constants";

/**
 * Compute the INF attenuation factor for a target node.
 *
 * Formula:
 *   rawINF = log((|V| + 1) / (indegree + 1)) / log(|V| + 1)
 *   sinkScale = clamp(1 - outdegree/indegree, HUB_SINK_FLOOR, 1.0)
 *   penalty = (1 - rawINF) * sinkScale
 *   attenuation = 1 - penalty
 *
 * The result is clamped to [INF_FLOOR, INF_CEILING].
 *
 * Behavior by node type (|V| = 1000):
 *   Domain model  (in=4,  out=8):   ~0.99 (pass through)
 *   Barrel/hub    (in=50, out=50):   ~0.97 (pass through)
 *   Utility sink  (in=200, out=3):   ~0.24 (heavy attenuation)
 *   Extreme sink  (in=400, out=1):   ~0.13 (very heavy attenuation)
 */
export function computeINF(indegree: number, outdegree: number, totalNodes: number): number {
  if (totalNodes <= 1) return INF_CEILING;

  const logTotal = Math.log(totalNodes + 1);
  const rawINF = Math.log((totalNodes + 1) / (indegree + 1)) / logTotal;

  // Hub/sink discriminator using directed degree ratio.
  // Pure sink (in >> out): sinkScale -> 1.0 (full penalty applied)
  // Hub/barrel (in ~ out): sinkScale -> HUB_SINK_FLOOR (minimal penalty)
  // Producer (out > in): sinkScale -> HUB_SINK_FLOOR (no penalty)
  const sinkScale = indegree > 0 ? Math.max(HUB_SINK_FLOOR, Math.min(1.0, 1 - outdegree / indegree)) : HUB_SINK_FLOOR;

  const penalty = (1 - rawINF) * sinkScale;
  const attenuation = 1 - penalty;

  return Math.max(INF_FLOOR, Math.min(INF_CEILING, attenuation));
}
