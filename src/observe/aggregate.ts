import type { SessionMetrics } from "./metrics";

/** Aggregated metrics across multiple sessions */
export interface AggregateMetrics {
  /** Number of sessions analyzed */
  sessionCount: number;
  /** Average turns per session */
  avgTurns: number;
  /** Average first-edit turn */
  avgFirstEditTurn: number | null;
  /** Average phase percentages */
  avgExplorePercent: number;
  avgEditPercent: number;
  avgTailPercent: number;
  /** Total and average cost */
  totalCost: number;
  avgCost: number;
  /** Total and average waste */
  totalWaste: number;
  avgWaste: number;
  /** Waste as percentage of total cost */
  wastePercent: number;
  /** Average read/edit ratio */
  avgReadEditRatio: number;
  /** Pattern frequency (how many sessions have each pattern type) */
  patternFrequency: Record<string, number>;
  /** Per-session metrics for drill-down */
  sessions: SessionMetrics[];
}

/**
 * Aggregate metrics across multiple sessions.
 */
export function aggregateMetrics(sessions: SessionMetrics[]): AggregateMetrics {
  const n = sessions.length || 1;

  const avgTurns = sessions.reduce((s, m) => s + m.totalTurns, 0) / n;

  const firstEdits = sessions.map((m) => m.firstEditTurn).filter((t): t is number => t !== null);
  const avgFirstEditTurn = firstEdits.length > 0 ? firstEdits.reduce((s, t) => s + t, 0) / firstEdits.length : null;

  const avgExplorePercent = sessions.reduce((s, m) => s + m.explorePercent, 0) / n;
  const avgEditPercent = sessions.reduce((s, m) => s + m.editPercent, 0) / n;
  const avgTailPercent = sessions.reduce((s, m) => s + m.tailPercent, 0) / n;

  const totalCost = sessions.reduce((s, m) => s + m.totalCost, 0);
  const totalWaste = sessions.reduce((s, m) => s + m.totalWaste, 0);

  const avgReadEditRatio = sessions.reduce((s, m) => s + m.readEditRatio, 0) / n;

  const patternFrequency: Record<string, number> = {};
  for (const session of sessions) {
    const seen = new Set<string>();
    for (const p of session.patterns) {
      if (!seen.has(p.type)) {
        patternFrequency[p.type] = (patternFrequency[p.type] ?? 0) + 1;
        seen.add(p.type);
      }
    }
  }

  return {
    sessionCount: sessions.length,
    avgTurns: Math.round(avgTurns * 10) / 10,
    avgFirstEditTurn: avgFirstEditTurn !== null ? Math.round(avgFirstEditTurn * 10) / 10 : null,
    avgExplorePercent: Math.round(avgExplorePercent),
    avgEditPercent: Math.round(avgEditPercent),
    avgTailPercent: Math.round(avgTailPercent),
    totalCost: Math.round(totalCost * 100) / 100,
    avgCost: Math.round((totalCost / n) * 100) / 100,
    totalWaste: Math.round(totalWaste * 100) / 100,
    avgWaste: Math.round((totalWaste / n) * 100) / 100,
    wastePercent: totalCost > 0 ? Math.round((totalWaste / totalCost) * 100) : 0,
    avgReadEditRatio: Math.round(avgReadEditRatio * 10) / 10,
    patternFrequency,
    sessions,
  };
}
