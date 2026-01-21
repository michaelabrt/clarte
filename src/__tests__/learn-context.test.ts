import { describe, expect, it } from "vitest";
import { buildIdealContextSet, ROLE_PRIORITY } from "../analysis/learn-context.js";
import { makePersistedGraph, makeFileRecord, makeEdgeRecord } from "./helpers/factories.js";

describe("buildIdealContextSet", () => {
  it("L0: includes edited files with role 'edited'", () => {
    const graph = makePersistedGraph({
      files: { "src/foo.ts": makeFileRecord() },
    });
    const result = buildIdealContextSet(["src/foo.ts"], graph);
    expect(result.get("src/foo.ts")).toEqual({ role: "edited", source: "src/foo.ts" });
  });

  it("L1: includes importers capped at 10, sorted by importedByCount", () => {
    const files: Record<string, ReturnType<typeof makeFileRecord>> = {
      "src/target.ts": makeFileRecord(),
    };
    const edges: ReturnType<typeof makeEdgeRecord>[] = [];
    // Create 15 importers with varying importedByCount
    for (let i = 0; i < 15; i++) {
      const name = `src/importer-${i}.ts`;
      files[name] = makeFileRecord({ importedByCount: i });
      edges.push({ ...makeEdgeRecord(name, "src/target.ts"), importedNames: ["foo"] });
    }

    const graph = makePersistedGraph({ files, edges });
    const result = buildIdealContextSet(["src/target.ts"], graph);

    // Should have 11 entries: 1 edited + 10 capped importers
    const dependents = [...result.entries()].filter(([, v]) => v.role === "dependent");
    expect(dependents).toHaveLength(10);

    // Sorted by importedByCount descending: importer-14 should be first
    expect(dependents[0][0]).toBe("src/importer-14.ts");
  });

  it("L2: includes imports with role 'dependency'", () => {
    const graph = makePersistedGraph({
      files: {
        "src/foo.ts": makeFileRecord(),
        "src/utils.ts": makeFileRecord(),
      },
      edges: [makeEdgeRecord("src/foo.ts", "src/utils.ts")],
    });

    const result = buildIdealContextSet(["src/foo.ts"], graph);
    expect(result.get("src/utils.ts")?.role).toBe("dependency");
  });

  it("L3: includes test-mapped files with role 'test'", () => {
    const graph = makePersistedGraph({
      files: {
        "src/foo.ts": makeFileRecord(),
        "src/__tests__/foo.test.ts": makeFileRecord(),
      },
      testMapping: {
        "src/foo.ts": ["src/__tests__/foo.test.ts"],
      },
    });

    const result = buildIdealContextSet(["src/foo.ts"], graph);
    expect(result.get("src/__tests__/foo.test.ts")?.role).toBe("test");
  });

  it("L4: includes co-change at 0.5 confidence, excludes at 0.3", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord(),
        "src/b.ts": makeFileRecord(),
        "src/c.ts": makeFileRecord(),
      },
      changeCoupling: [
        { fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.5, coChangeCount: 5 },
        { fileA: "src/a.ts", fileB: "src/c.ts", confidence: 0.3, coChangeCount: 3 },
      ],
    });

    const result = buildIdealContextSet(["src/a.ts"], graph);
    expect(result.get("src/b.ts")?.role).toBe("co-change");
    expect(result.has("src/c.ts")).toBe(false);
  });

  it("L5: includes structural mismatch at 0.4 confidence, excludes at 0.2", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord(),
        "src/b.ts": makeFileRecord(),
        "src/c.ts": makeFileRecord(),
      },
      structuralMismatches: [
        { fileA: "src/a.ts", fileB: "src/b.ts", graphDistance: 5, coChangeConfidence: 0.4, coChangeCount: 4 },
        { fileA: "src/a.ts", fileB: "src/c.ts", graphDistance: 3, coChangeConfidence: 0.2, coChangeCount: 2 },
      ],
    });

    const result = buildIdealContextSet(["src/a.ts"], graph);
    expect(result.get("src/b.ts")?.role).toBe("hidden-dep");
    expect(result.has("src/c.ts")).toBe(false);
  });

  it("role priority: file that is both dependency and test gets role 'test'", () => {
    const graph = makePersistedGraph({
      files: {
        "src/foo.ts": makeFileRecord(),
        "src/__tests__/foo.test.ts": makeFileRecord(),
      },
      edges: [makeEdgeRecord("src/foo.ts", "src/__tests__/foo.test.ts")],
      testMapping: {
        "src/foo.ts": ["src/__tests__/foo.test.ts"],
      },
    });

    const result = buildIdealContextSet(["src/foo.ts"], graph);
    // test > dependency in ROLE_PRIORITY
    expect(result.get("src/__tests__/foo.test.ts")?.role).toBe("test");
  });

  it("edited file not in graph: L0 populated, L1-L5 skipped, no crash", () => {
    const graph = makePersistedGraph({ files: {} });
    const result = buildIdealContextSet(["src/nonexistent.ts"], graph);
    expect(result.get("src/nonexistent.ts")?.role).toBe("edited");
    expect(result.size).toBe(1);
  });

  it("custom thresholds via options parameter", () => {
    const graph = makePersistedGraph({
      files: {
        "src/a.ts": makeFileRecord(),
        "src/b.ts": makeFileRecord(),
      },
      changeCoupling: [{ fileA: "src/a.ts", fileB: "src/b.ts", confidence: 0.35, coChangeCount: 3 }],
    });

    // Default threshold (0.4) excludes this
    const result1 = buildIdealContextSet(["src/a.ts"], graph);
    expect(result1.has("src/b.ts")).toBe(false);

    // Lower threshold includes it
    const result2 = buildIdealContextSet(["src/a.ts"], graph, { coChangeThreshold: 0.3 });
    expect(result2.get("src/b.ts")?.role).toBe("co-change");
  });

  it("ROLE_PRIORITY has correct order", () => {
    expect(ROLE_PRIORITY).toEqual(["dependency", "dependent", "hidden-dep", "co-change", "test", "edited"]);
  });
});
