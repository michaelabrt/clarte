import { describe, expect, it } from "vitest";
import { detectObservations } from "../analysis/learn-observations.js";
import { makePersistedGraph, makeFileRecord, makeEdgeRecord } from "./helpers/factories.js";
import type { ParsedSession, IdealFile, ToolEvent } from "../types/learn.js";

function makeEvent(overrides: Partial<ToolEvent> & { tool: string }): ToolEvent {
  return {
    succeeded: true,
    timestamp: "2026-03-05T10:00:00Z",
    toolUseId: `t-${Math.random().toString(36).slice(2, 8)}`,
    ...overrides,
  };
}

function makeSession(events: ToolEvent[]): ParsedSession {
  return {
    sessionId: "test-session",
    cliVersion: "2.1.68",
    rootDir: "/home/user/project",
    events,
    turnCount: events.length,
    skippedLines: 0,
  };
}

function emptyIdealSet(): Map<string, IdealFile> {
  return new Map();
}

describe("detectObservations", () => {
  describe("blind-edit", () => {
    it("fires when Edit event has no prior Read", () => {
      const events = [makeEvent({ tool: "Edit", relativePath: "src/foo.ts" })];
      const graph = makePersistedGraph({ files: { "src/foo.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const blindEdits = obs.filter((o) => o.type === "blind-edit");
      expect(blindEdits).toHaveLength(1);
      expect(blindEdits[0].file).toBe("src/foo.ts");
    });

    it("does not fire when Read precedes Edit", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/foo.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(0);
    });

    it("does not fire for Write events (new file creation)", () => {
      const events = [makeEvent({ tool: "Write", relativePath: "src/new.ts" })];
      const graph = makePersistedGraph({ files: { "src/new.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(0);
    });

    it("is deduplicated per file (only emits once)", () => {
      const events = [
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/foo.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(1);
    });

    it("is suppressed when file is not in graph (new or untracked file)", () => {
      const events = [makeEvent({ tool: "Edit", relativePath: "src/new.ts" })];
      const graph = makePersistedGraph({ files: {} }); // file not in graph
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(0);
    });

    it("is suppressed when file was created by Write before Edit (even if in graph)", () => {
      const events = [
        makeEvent({ tool: "Write", relativePath: "src/new.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/new.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/new.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(0);
    });

    it("is suppressed when file appeared in search results", () => {
      const events = [
        makeEvent({ tool: "Grep", relativePath: undefined, pattern: "foo", resultFiles: ["src/foo.ts"] }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/foo.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "blind-edit")).toHaveLength(0);
    });
  });

  describe("missed-test", () => {
    it("fires when file has test mapping but test was never read/run", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const missed = obs.filter((o) => o.type === "missed-test");
      expect(missed).toHaveLength(1);
      expect(missed[0].relatedFile).toBe("src/__tests__/foo.test.ts");
    });

    it("emits positive test-after-edit when test was read", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/__tests__/foo.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-test")).toHaveLength(0);
      const positive = obs.filter((o) => o.type === "test-after-edit");
      expect(positive).toHaveLength(1);
      expect(positive[0].positive).toBe(true);
    });

    it("satisfies test check via Bash vitest run", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "vitest run src/__tests__/foo.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-test")).toHaveLength(0);
      expect(obs.filter((o) => o.type === "test-after-edit")).toHaveLength(1);
    });

    it("satisfies test check via Bash multi-segment command", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "cd packages/foo && vitest run src/__tests__/foo.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-test")).toHaveLength(0);
    });

    it("satisfies test check via Bash env prefix", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "FORCE_COLOR=0 vitest run src/__tests__/foo.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-test")).toHaveLength(0);
    });

    it("generic npm test does not satisfy missed-test for specific files", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "npm test" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/foo.ts": makeFileRecord(), "src/__tests__/foo.test.ts": makeFileRecord() },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      // npm test runs the whole suite - doesn't demonstrate intent to verify this specific file
      expect(obs.filter((o) => o.type === "missed-test")).toHaveLength(1);
      expect(obs.filter((o) => o.type === "test-after-edit")).toHaveLength(0);
    });
  });

  describe("missed-cochange", () => {
    it("fires when co-change partner is not read or edited", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/a.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/a.ts": makeFileRecord(), "src/b.ts": makeFileRecord() },
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.5, coChangeCount: 5 }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const missed = obs.filter((o) => o.type === "missed-cochange");
      expect(missed).toHaveLength(1);
      expect(missed[0].detail).toContain("50%");
    });

    it("emits cochange-edited when partner was also edited", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/b.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/b.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/a.ts": makeFileRecord(), "src/b.ts": makeFileRecord() },
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.5, coChangeCount: 5 }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-cochange")).toHaveLength(0);
      expect(obs.filter((o) => o.type === "cochange-edited").length).toBeGreaterThan(0);
    });

    it("emits cochange-checked when partner was read but not edited", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/b.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/a.ts": makeFileRecord(), "src/b.ts": makeFileRecord() },
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.5, coChangeCount: 5 }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-cochange")).toHaveLength(0);
      const checked = obs.filter((o) => o.type === "cochange-checked");
      expect(checked).toHaveLength(1);
      expect(checked[0].positive).toBe(true);
    });

    it("respects custom coChangeThreshold from options", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/a.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/a.ts" }),
      ];
      const graph = makePersistedGraph({
        files: { "src/a.ts": makeFileRecord(), "src/b.ts": makeFileRecord() },
        changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.35, coChangeCount: 3 }],
      });
      // Default threshold (0.4) skips 0.35
      const obs1 = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs1.filter((o) => o.type === "missed-cochange")).toHaveLength(0);

      // Lower threshold includes it
      const obs2 = detectObservations(makeSession(events), emptyIdealSet(), graph, { coChangeThreshold: 0.3 });
      expect(obs2.filter((o) => o.type === "missed-cochange")).toHaveLength(1);
    });
  });

  describe("missed-dependent", () => {
    it("fires for significant dependent not read", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/utils.ts" }),
      ];
      const graph = makePersistedGraph({
        files: {
          "src/utils.ts": makeFileRecord(),
          "src/important.ts": makeFileRecord({ importedByCount: 10, isChokepoint: false }),
        },
        edges: [{ ...makeEdgeRecord("src/important.ts", "src/utils.ts"), importedNames: ["readFileOr"] }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const missed = obs.filter((o) => o.type === "missed-dependent");
      expect(missed).toHaveLength(1);
      expect(missed[0].relatedFile).toBe("src/important.ts");
    });

    it("does not fire for non-significant dependent (importedByCount <= 5, not chokepoint)", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/utils.ts" }),
      ];
      const graph = makePersistedGraph({
        files: {
          "src/utils.ts": makeFileRecord(),
          "src/minor.ts": makeFileRecord({ importedByCount: 2, isChokepoint: false }),
        },
        edges: [{ ...makeEdgeRecord("src/minor.ts", "src/utils.ts"), importedNames: ["foo"] }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "missed-dependent")).toHaveLength(0);
    });
  });

  describe("search-then-find", () => {
    it("fires when 3+ targeted searches found the file in results", () => {
      const events = [
        makeEvent({ tool: "Grep", pattern: "utils", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Grep", pattern: "helper", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Grep", pattern: "readFile", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/utils.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const stf = obs.filter((o) => o.type === "search-then-find");
      expect(stf).toHaveLength(1);
      expect(stf[0].detail).toContain("3");
    });

    it("is deduplicated per file when same file is read twice", () => {
      const events = [
        makeEvent({ tool: "Grep", pattern: "utils", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Grep", pattern: "helper", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Grep", pattern: "readFile", resultFiles: ["src/utils.ts"] }),
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/other.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/utils.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "search-then-find")).toHaveLength(1);
    });

    it("does not fire for unrelated searches (no causal link)", () => {
      const events = [
        makeEvent({ tool: "Grep", pattern: "unrelated1" }),
        makeEvent({ tool: "Grep", pattern: "unrelated2" }),
        makeEvent({ tool: "Grep", pattern: "unrelated3" }),
        makeEvent({ tool: "Grep", pattern: "unrelated4" }),
        makeEvent({ tool: "Read", relativePath: "src/utils.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/utils.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "search-then-find")).toHaveLength(0);
    });
  });

  describe("re-read", () => {
    it("fires when file is read 3 times with intervening actions", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/config.ts" }),
        makeEvent({ tool: "Grep", pattern: "foo" }),
        makeEvent({ tool: "Edit", relativePath: "src/other.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/config.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/more.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/config.ts" }),
      ];
      const graph = makePersistedGraph({ files: { "src/config.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const reread = obs.filter((o) => o.type === "re-read");
      expect(reread).toHaveLength(1);
      expect(reread[0].detail).toContain("3 times");
    });
  });

  describe("failed-search", () => {
    it("fires when search has no results but pattern matches a graph file path", () => {
      const events = [makeEvent({ tool: "Grep", pattern: "config", succeeded: false })];
      const graph = makePersistedGraph({ files: { "src/config.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const failed = obs.filter((o) => o.type === "failed-search");
      expect(failed).toHaveLength(1);
      expect(failed[0].file).toBe("src/config.ts");
    });

    it("does not fire when pattern matches nothing in graph", () => {
      const events = [makeEvent({ tool: "Grep", pattern: "zzzznonexistent", succeeded: false })];
      const graph = makePersistedGraph({ files: { "src/config.ts": makeFileRecord() } });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "failed-search")).toHaveLength(0);
    });
  });

  describe("wasted-test", () => {
    it("fires when test file is not mapped to any edited file", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "vitest run src/__tests__/unrelated.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: {
          "src/foo.ts": makeFileRecord(),
          "src/__tests__/unrelated.test.ts": makeFileRecord(),
        },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const wasted = obs.filter((o) => o.type === "wasted-test");
      expect(wasted).toHaveLength(1);
      expect(wasted[0].file).toBe("src/__tests__/unrelated.test.ts");
    });

    it("does not fire when test file is mapped to an edited file", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Bash", command: "vitest run src/__tests__/foo.test.ts" }),
      ];
      const graph = makePersistedGraph({
        files: {
          "src/foo.ts": makeFileRecord(),
          "src/__tests__/foo.test.ts": makeFileRecord(),
        },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      expect(obs.filter((o) => o.type === "wasted-test")).toHaveLength(0);
    });
  });

  describe("perfect agent", () => {
    it("produces only positive observations when agent reads all ideal files", () => {
      const events = [
        makeEvent({ tool: "Read", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/foo.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/__tests__/foo.test.ts" }),
        makeEvent({ tool: "Read", relativePath: "src/bar.ts" }),
        makeEvent({ tool: "Edit", relativePath: "src/bar.ts" }),
      ];
      const graph = makePersistedGraph({
        files: {
          "src/foo.ts": makeFileRecord(),
          "src/bar.ts": makeFileRecord(),
          "src/__tests__/foo.test.ts": makeFileRecord(),
        },
        testMapping: { "src/foo.ts": ["src/__tests__/foo.test.ts"] },
        changeCoupling: [{ fileA: "src/foo.ts", fileB: "src/bar.ts", confidence: 0.6, coChangeCount: 5 }],
      });
      const obs = detectObservations(makeSession(events), emptyIdealSet(), graph);
      const negative = obs.filter((o) => !o.positive);
      expect(negative).toHaveLength(0);
    });
  });
});
