import { describe, expect, it } from "vitest";
import { formatLearnResult } from "../cli/learn.js";
import type { LearnResult } from "../types/learn.js";

function makeResult(overrides: Partial<LearnResult> = {}): LearnResult {
  return {
    version: 1,
    sessionId: "abc12345-6789",
    slug: "memoized-knitting-zebra",
    cliVersion: "2.1.68",
    totalEvents: 47,
    turnCount: 12,
    editedFiles: ["src/foo.ts", "src/bar.ts"],
    idealContextSize: 11,
    observations: [],
    bySection: {},
    diagnostics: {
      missedIdealFiles: [],
      readFiles: [],
      precision: 0.8,
      recall: 0.6,
      skippedLines: 0,
    },
    ...overrides,
  };
}

describe("formatLearnResult", () => {
  it("formats text output with observations", () => {
    const result = makeResult({
      observations: [
        {
          type: "blind-edit",
          section: "file-index",
          file: "src/new.ts",
          detail: "Edited src/new.ts without reading it first",
          eventIndex: 5,
        },
        {
          type: "missed-test",
          section: "test-mapping",
          file: "src/foo.ts",
          relatedFile: "src/__tests__/foo.test.ts",
          detail: "Edited src/foo.ts but never read src/__tests__/foo.test.ts",
          eventIndex: 8,
        },
        {
          type: "test-after-edit",
          section: "test-mapping",
          file: "src/bar.ts",
          relatedFile: "src/__tests__/bar.test.ts",
          detail: "Correctly ran tests after editing src/bar.ts",
          eventIndex: 10,
          positive: true,
        },
      ],
      bySection: {
        "file-index": { total: 1, positive: 0, negative: 1 },
        "test-mapping": { total: 2, positive: 1, negative: 1 },
      },
    });

    const output = formatLearnResult(result, false);

    expect(output).toContain("Session: memoized-knitting-zebra (CLI 2.1.68)");
    expect(output).toContain("Events: 47 tool calls across 12 turns");
    expect(output).toContain("Edited: 2 files");
    expect(output).toContain("Ideal context: 11 files");
    expect(output).toContain("blind-edit (file-index)");
    expect(output).toContain("Edited src/new.ts without reading it first");
    expect(output).toContain("missed-test (test-mapping)");
    expect(output).toContain("test-after-edit [positive] (test-mapping)");
    expect(output).toContain("By section:");
    expect(output).toContain("file-index");
    expect(output).toContain("test-mapping");
    // Should not contain diagnostics in non-verbose mode
    expect(output).not.toContain("Precision:");
  });

  it("formats text output with zero observations", () => {
    const result = makeResult({
      observations: [],
      bySection: {},
    });

    const output = formatLearnResult(result, false);

    expect(output).toContain("Session: memoized-knitting-zebra");
    expect(output).toContain("No observations - agent's file access aligned with the project graph.");
  });

  it("formats text output with zero edits", () => {
    const result = makeResult({
      editedFiles: [],
      idealContextSize: 0,
      observations: [],
      bySection: {},
    });

    const output = formatLearnResult(result, false);

    expect(output).toContain("No edits found in session - nothing to analyze.");
  });

  it("includes diagnostics in verbose mode", () => {
    const result = makeResult({
      observations: [],
      diagnostics: {
        missedIdealFiles: ["src/missed.ts"],
        readFiles: ["src/foo.ts"],
        precision: 0.8,
        recall: 0.6,
        skippedLines: 2,
      },
    });

    const output = formatLearnResult(result, true);

    expect(output).toContain("Diagnostics");
    expect(output).toContain("Precision: 80.0%");
    expect(output).toContain("Recall: 60.0%");
    expect(output).toContain("Skipped lines: 2");
  });
});
