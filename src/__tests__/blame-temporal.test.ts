import { describe, it, expect } from "vitest";
import { parseBlameOutput, mapBlameToSymbols } from "../core/git/blame";
import type { InMemorySymbolGraph, InMemorySymbolNode } from "../storage/types";
import { BLAME_LAMBDA, BLAME_FLOOR, BLAME_DEFAULT_DAYS } from "../core/config/phase7-constants";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSymGraph(symbols: Array<{ id: number; file: string; start: number; end?: number }>): InMemorySymbolGraph {
  const symMap = new Map<number, InMemorySymbolNode>();
  const byFile = new Map<string, number[]>();

  for (const s of symbols) {
    symMap.set(s.id, {
      id: s.id,
      filePath: s.file,
      name: `sym${s.id}`,
      kind: "function",
      startLine: s.start,
      endLine: s.end ?? null,
      isExported: true,
    });
    let ids = byFile.get(s.file);
    if (!ids) {
      ids = [];
      byFile.set(s.file, ids);
    }
    ids.push(s.id);
  }

  return { symbols: symMap, forward: new Map(), reverse: new Map(), byFile };
}

/**
 * Build minimal git blame --porcelain output for testing.
 * Each entry: sha, orig/final line, author-time, tab-prefixed content.
 */
function buildPorcelain(entries: Array<{ line: number; timestamp: number }>): string {
  return entries
    .map(
      (e) =>
        `${"a".repeat(40)} ${e.line} ${e.line} 1\nauthor Test\nauthor-mail <test@test.com>\nauthor-time ${e.timestamp}\nauthor-tz +0000\ncommitter Test\ncommitter-mail <test@test.com>\ncommitter-time ${e.timestamp}\ncommitter-tz +0000\nsummary test\nfilename test.ts\n\tcontent line ${e.line}`,
    )
    .join("\n");
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("parseBlameOutput", () => {
  it("parses porcelain output into line -> days mapping", () => {
    const now = Date.now();
    const oneDayAgo = Math.floor((now - 86400_000) / 1000);
    const twoDaysAgo = Math.floor((now - 2 * 86400_000) / 1000);

    const output = buildPorcelain([
      { line: 1, timestamp: oneDayAgo },
      { line: 5, timestamp: twoDaysAgo },
    ]);

    const result = parseBlameOutput(output, now);

    expect(result.size).toBe(2);
    expect(result.get(1)).toBeCloseTo(1.0, 0);
    expect(result.get(5)).toBeCloseTo(2.0, 0);
  });

  it("returns empty map for empty output", () => {
    expect(parseBlameOutput("").size).toBe(0);
  });
});

describe("mapBlameToSymbols", () => {
  it("uses min days across symbol line range", () => {
    const symGraph = makeSymGraph([{ id: 1, file: "a.ts", start: 1, end: 10 }]);

    const lineBlame = new Map([
      [
        "a.ts",
        new Map([
          [1, 30],
          [5, 10], // most recent
          [10, 90],
        ]),
      ],
    ]);

    const result = mapBlameToSymbols(lineBlame, symGraph);
    expect(result.get(1)).toBe(10);
  });

  it("uses startLine only when endLine is undefined", () => {
    const symGraph = makeSymGraph([{ id: 1, file: "a.ts", start: 5 }]);

    const lineBlame = new Map([
      [
        "a.ts",
        new Map([
          [1, 10],
          [5, 20],
          [10, 30],
        ]),
      ],
    ]);

    const result = mapBlameToSymbols(lineBlame, symGraph);
    expect(result.get(1)).toBe(20);
  });

  it("defaults to BLAME_DEFAULT_DAYS for missing blame data", () => {
    const symGraph = makeSymGraph([{ id: 1, file: "missing.ts", start: 1 }]);

    const result = mapBlameToSymbols(new Map(), symGraph);
    expect(result.get(1)).toBe(BLAME_DEFAULT_DAYS);
  });
});

describe("blame decay formula", () => {
  function decay(days: number): number {
    return Math.max(BLAME_FLOOR, Math.exp(-BLAME_LAMBDA * days));
  }

  it("day 0: decay = 1.0", () => {
    expect(decay(0)).toBeCloseTo(1.0, 5);
  });

  it("day 30: moderate decay", () => {
    const val = decay(30);
    expect(val).toBeGreaterThan(0.3);
    expect(val).toBeLessThan(1.0);
  });

  it("day 90: approaching floor", () => {
    const val = decay(90);
    expect(val).toBeCloseTo(BLAME_FLOOR, 1);
  });

  it("day 365: floored", () => {
    expect(decay(365)).toBe(BLAME_FLOOR);
  });
});
