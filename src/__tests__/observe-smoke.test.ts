import { describe, it, expect } from "vitest";
import { resolve } from "node:path";
import {
  parseSessionFile,
  classifyTurns,
  detectAllPatterns,
  computeMetrics,
  formatSessionReport,
} from "../observe/index";

// Use a real session log if available, skip otherwise
const SESSION_DIR = resolve(process.env.HOME ?? "", ".claude/projects");
const findFirstSession = (): string | null => {
  try {
    const { execSync } = require("node:child_process");
    const result = execSync(`find ${SESSION_DIR} -name "*.jsonl" -not -path "*/subagents/*" | head -1`, {
      encoding: "utf-8",
    }).trim();
    return result || null;
  } catch {
    return null;
  }
};

const sessionFile = findFirstSession();

describe.skipIf(!sessionFile)("observe smoke test", () => {
  const file = sessionFile as string;

  it("parses a real session log", () => {
    const session = parseSessionFile(file);
    expect(session.sessionId).toBeTruthy();
    expect(session.turns.length).toBeGreaterThan(0);
    expect(session.startedAt).toBeTruthy();
  });

  it("classifies turns into phases", () => {
    const session = parseSessionFile(file);
    const classified = classifyTurns(session.turns);
    expect(classified.length).toBe(session.turns.length);
    for (const turn of classified) {
      expect(["explore", "edit", "tail"]).toContain(turn.phase);
    }
  });

  it("computes metrics", () => {
    const session = parseSessionFile(file);
    const classified = classifyTurns(session.turns);
    const patterns = detectAllPatterns(classified);
    const metrics = computeMetrics(classified, patterns, session.startedAt, session.endedAt);

    expect(metrics.totalTurns).toBe(session.turns.length);
    expect(metrics.explorePercent + metrics.editPercent + metrics.tailPercent).toBeGreaterThanOrEqual(98); // rounding
    expect(metrics.totalCost).toBeGreaterThanOrEqual(0);
  });

  it("formats a report", () => {
    const session = parseSessionFile(file);
    const classified = classifyTurns(session.turns);
    const patterns = detectAllPatterns(classified);
    const metrics = computeMetrics(classified, patterns, session.startedAt, session.endedAt);
    const report = formatSessionReport(metrics, session.sessionId);

    expect(report).toContain("Phase Breakdown");
    expect(report).toContain("Explore:");
    expect(report).toContain("Edit:");
    expect(report).toContain("Tail:");
  });
});
