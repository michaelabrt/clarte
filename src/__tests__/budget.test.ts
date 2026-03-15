import { describe, expect, it } from "vitest";
import { applyBudget, applyCharBudget } from "../templates/budget.js";
import { trimSnapshotToChars, renderSnapshot } from "../snapshot/snapshot.js";
import type { CodeSnapshot, ContextSection, SnapshotEntry } from "../types.js";

describe("applyBudget", () => {
  const makeSections = (specs: Array<[string, number, number]>): ContextSection[] =>
    specs.map(([id, priority, tokens]) => ({
      id,
      priority,
      content: `Section ${id}`,
      tokens,
    }));

  it("includes all sections when budget is large enough", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["dev", 0, 50],
    ]);
    const { included, omitted } = applyBudget(sections, 10000);
    expect(included).toHaveLength(4);
    expect(omitted).toHaveLength(0);
  });

  it("always includes priority 0 sections", () => {
    const sections = makeSections([
      ["header", 0, 500],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["dev", 0, 500],
    ]);
    // Budget is very small, but priority 0 always stays
    const { included } = applyBudget(sections, 100);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("header");
    expect(ids).toContain("dev");
  });

  it("always includes priority 1-2 sections (even over budget)", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["guidelines", 2, 100],
      ["arch", 4, 200],
      ["dev", 0, 50],
    ]);
    const { included, omitted } = applyBudget(sections, 200);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("tech");
    expect(ids).toContain("guidelines");
    expect(omitted).toContain("arch");
  });

  it("drops lower-priority sections when budget is exceeded", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 200],
      ["hot", 7, 150],
      ["dead", 9, 100],
      ["tight", 10, 100],
      ["dev", 0, 50],
    ]);
    const { included, omitted } = applyBudget(sections, 400);
    const ids = included.map((s) => s.id);
    expect(ids).toContain("header");
    expect(ids).toContain("tech");
    expect(ids).toContain("arch");
    expect(omitted).toContain("hot");
    expect(omitted).toContain("dead");
    expect(omitted).toContain("tight");
  });

  it("preserves original section order in included list", () => {
    const sections = makeSections([
      ["header", 0, 50],
      ["tech", 1, 100],
      ["arch", 4, 50],
      ["dev", 0, 50],
    ]);
    const { included } = applyBudget(sections, 10000);
    const ids = included.map((s) => s.id);
    expect(ids).toEqual(["header", "tech", "arch", "dev"]);
  });
});

// ── Character budget tests ─────────────────────────────────────────────────

function makeSection(id: string, priority: number, chars: number): ContextSection {
  const header = `## ${id}\n\n`;
  const body = "x".repeat(Math.max(0, chars - header.length));
  return { id, priority, content: header + body, tokens: Math.ceil(chars / 4) };
}

function makeSnapshotEntries(count: number): SnapshotEntry[] {
  const entries: SnapshotEntry[] = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      file: `src/file${i}.ts`,
      category: i < count / 2 ? "type" : "function",
      signature: `export ${i < count / 2 ? "interface" : "function"} Item${i} { field${i}: string; anotherField${i}: number; }`,
      importedByCount: count - i,
    });
  }
  return entries;
}

describe("applyCharBudget", () => {
  const comment = "\n<!-- clarte: generated test -->\n";

  it("includes all sections when under budget", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("tech-stack", 1, 200),
      makeSection("snapshot", 6, 300),
    ];

    const { included, dropped } = applyCharBudget(sections, 10000, comment);
    expect(included).toHaveLength(3);
    expect(dropped).toHaveLength(0);
  });

  it("drops lowest-priority sections (highest number) first", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("tech-stack", 1, 200),
      makeSection("snapshot", 6, 300),
      makeSection("tight-coupling", 10, 300),
    ];

    const total = sections.reduce((s, sec) => s + sec.content.length, 0);
    const { included, dropped } = applyCharBudget(sections, total - 100, comment);
    expect(dropped).toContain("tight-coupling");
    expect(included.map((s) => s.id)).not.toContain("tight-coupling");
  });

  it("never drops P0-P2 sections", () => {
    const sections = [
      makeSection("header", 0, 5000),
      makeSection("guidelines", 2, 5000),
      makeSection("snapshot", 6, 100),
    ];

    const { included, dropped } = applyCharBudget(sections, 1000, comment);
    expect(included.find((s) => s.id === "header")).toBeDefined();
    expect(included.find((s) => s.id === "guidelines")).toBeDefined();
    expect(dropped).toContain("snapshot");
  });

  it("preserves original section order", () => {
    const sections = [
      makeSection("header", 0, 100),
      makeSection("snapshot", 6, 200),
      makeSection("tech-stack", 1, 100),
    ];

    const { included } = applyCharBudget(sections, 10000, comment);
    expect(included.map((s) => s.id)).toEqual(["header", "snapshot", "tech-stack"]);
  });
});

describe("trimSnapshotToChars", () => {
  it("returns full markdown when under budget", () => {
    const entries = makeSnapshotEntries(5);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, 100000);
    expect(trimmedCount).toBe(0);
    expect(markdown).toBe(fullMarkdown);
  });

  it("trims entries to fit within character budget", () => {
    const entries = makeSnapshotEntries(20);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const targetChars = Math.floor(fullMarkdown.length / 2);
    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, targetChars);

    expect(markdown.length).toBeLessThanOrEqual(targetChars);
    expect(trimmedCount).toBeGreaterThan(0);
    expect(trimmedCount).toBeLessThan(entries.length);
  });

  it("preserves highest-value entries (from the front)", () => {
    const entries = makeSnapshotEntries(10);
    const fullMarkdown = renderSnapshot(entries, "typescript");
    const snapshot: CodeSnapshot = { entries, markdown: fullMarkdown };

    const targetChars = Math.floor(fullMarkdown.length / 3);
    const { markdown } = trimSnapshotToChars(snapshot, targetChars);

    expect(markdown).toContain("Item0");
  });

  it("always keeps at least 1 entry", () => {
    const entries = makeSnapshotEntries(5);
    const snapshot: CodeSnapshot = {
      entries,
      markdown: renderSnapshot(entries, "typescript"),
    };

    const { markdown, trimmedCount } = trimSnapshotToChars(snapshot, 10);
    expect(trimmedCount).toBe(4);
    expect(markdown.length).toBeGreaterThan(0);
  });
});
