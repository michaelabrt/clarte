import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import { homedir } from "node:os";
import {
  parseSessionFile,
  classifyTurns,
  detectAllPatterns,
  computeMetrics,
  aggregateMetrics,
  formatSessionReport,
  formatAggregateReport,
  formatJson,
} from "../observe/index";
import type { SessionMetrics } from "../observe/index";

export interface ObserveOptions {
  /** Specific session ID to analyze */
  sessionId?: string;
  /** Analyze all projects, not just current */
  all?: boolean;
  /** Time window (e.g. "7d", "30d") */
  since?: string;
  /** Output JSON instead of human-readable */
  json?: boolean;
  /** Project root (used to find project-specific sessions) */
  rootDir: string;
}

/**
 * Find Claude Code session log files.
 */
function findSessionFiles(opts: ObserveOptions): string[] {
  const claudeDir = path.join(homedir(), ".claude", "projects");

  let projectDirs: string[];
  try {
    projectDirs = readdirSync(claudeDir)
      .map((d) => path.join(claudeDir, d))
      .filter((d) => statSync(d).isDirectory());
  } catch {
    return [];
  }

  // Filter to current project if not --all
  if (!opts.all) {
    const projectKey = opts.rootDir.replace(/\//g, "-").replace(/^-/, "");
    projectDirs = projectDirs.filter((d) => path.basename(d).includes(projectKey));
  }

  const files: Array<{ path: string; mtime: number }> = [];

  for (const dir of projectDirs) {
    try {
      const entries = readdirSync(dir);
      for (const entry of entries) {
        if (!entry.endsWith(".jsonl")) continue;
        const fp = path.join(dir, entry);
        try {
          const st = statSync(fp);
          if (st.isFile() && st.size > 100) {
            files.push({ path: fp, mtime: st.mtimeMs });
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Skip unreadable dirs
    }
  }

  // Apply time filter
  if (opts.since) {
    const ms = parseDuration(opts.since);
    if (ms > 0) {
      const cutoff = Date.now() - ms;
      return files
        .filter((f) => f.mtime >= cutoff)
        .sort((a, b) => b.mtime - a.mtime)
        .map((f) => f.path);
    }
  }

  // Default: last 20 sessions, sorted newest first
  return files
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, 20)
    .map((f) => f.path);
}

function parseDuration(s: string): number {
  const match = s.match(/^(\d+)(d|h|m|w)$/);
  if (!match) return 0;
  const n = parseInt(match[1], 10);
  const unit = match[2];
  const ms: Record<string, number> = {
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
    w: 604_800_000,
  };
  return n * (ms[unit] ?? 0);
}

/**
 * Analyze a single session and return metrics.
 */
function analyzeSession(filePath: string): SessionMetrics | null {
  try {
    const session = parseSessionFile(filePath);
    if (session.turns.length === 0) return null;
    const classified = classifyTurns(session.turns);
    const patterns = detectAllPatterns(classified);
    return computeMetrics(classified, patterns, session.startedAt, session.endedAt);
  } catch {
    return null;
  }
}

/**
 * Run the observe command.
 */
export async function runObserveMode(opts: ObserveOptions): Promise<void> {
  // Single session mode
  if (opts.sessionId) {
    const files = findSessionFiles({ ...opts, all: true });
    const id = opts.sessionId;
    const match = files.find((f) => f.includes(id));
    if (!match) {
      console.error(`Session not found: ${opts.sessionId}`);
      process.exit(1);
    }
    const session = parseSessionFile(match);
    const classified = classifyTurns(session.turns);
    const patterns = detectAllPatterns(classified);
    const metrics = computeMetrics(classified, patterns, session.startedAt, session.endedAt);
    console.log(opts.json ? formatJson(metrics) : formatSessionReport(metrics, session.sessionId));
    return;
  }

  // Multi-session mode
  const files = findSessionFiles(opts);
  if (files.length === 0) {
    console.log("No session logs found.");
    if (!opts.all) {
      console.log("Try --all to search across all projects, or --since=30d for a wider window.");
    }
    return;
  }

  const sessionMetrics: SessionMetrics[] = [];
  for (const file of files) {
    const metrics = analyzeSession(file);
    if (metrics) sessionMetrics.push(metrics);
  }

  if (sessionMetrics.length === 0) {
    console.log("No analyzable sessions found (all empty or malformed).");
    return;
  }

  const agg = aggregateMetrics(sessionMetrics);

  if (opts.json) {
    console.log(formatJson(agg));
  } else {
    console.log(formatAggregateReport(agg));
  }
}
