import { describe, expect, it } from "vitest";
import { extractUserSections, mergeUserSections } from "../core/generate.js";

describe("extractUserSections", () => {
  it("extracts a single user section", () => {
    const content = [
      "## Key Files",
      "",
      "some content",
      "",
      "<!-- clarte:user-start -->",
      "## Domain Knowledge",
      "",
      "- Orders expire in 24h",
      "<!-- clarte:user-end -->",
      "",
      "## Development",
    ].join("\n");

    const sections = extractUserSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBe("## Key Files");
    expect(sections[0].content).toContain("Domain Knowledge");
    expect(sections[0].content).toContain("Orders expire in 24h");
    expect(sections[0].content).toContain("<!-- clarte:user-start -->");
    expect(sections[0].content).toContain("<!-- clarte:user-end -->");
  });

  it("extracts multiple user sections", () => {
    const content = [
      "## Tech Stack",
      "",
      "<!-- clarte:user-start -->",
      "Custom note 1",
      "<!-- clarte:user-end -->",
      "",
      "## Key Files",
      "",
      "<!-- clarte:user-start -->",
      "Custom note 2",
      "<!-- clarte:user-end -->",
    ].join("\n");

    const sections = extractUserSections(content);
    expect(sections).toHaveLength(2);
    expect(sections[0].anchor).toBe("## Tech Stack");
    expect(sections[0].content).toContain("Custom note 1");
    expect(sections[1].anchor).toBe("## Key Files");
    expect(sections[1].content).toContain("Custom note 2");
  });

  it("handles section before any header", () => {
    const content = [
      "<!-- clarte:user-start -->",
      "Top-level note",
      "<!-- clarte:user-end -->",
      "",
      "## First Section",
    ].join("\n");

    const sections = extractUserSections(content);
    expect(sections).toHaveLength(1);
    expect(sections[0].anchor).toBeNull();
  });

  it("returns empty for no markers", () => {
    const content = "## Key Files\n\nsome content\n";
    expect(extractUserSections(content)).toHaveLength(0);
  });

  it("skips unclosed markers", () => {
    const content = ["## Key Files", "", "<!-- clarte:user-start -->", "Unclosed section"].join("\n");

    expect(extractUserSections(content)).toHaveLength(0);
  });
});

describe("mergeUserSections", () => {
  it("inserts section after its anchor header", () => {
    const newContent = [
      "## Tech Stack",
      "",
      "TypeScript",
      "",
      "## Key Files",
      "",
      "types.ts",
      "",
      "## Development",
      "",
      "npm run dev",
      "",
    ].join("\n");

    const sections = [
      {
        content: "<!-- clarte:user-start -->\n## Domain Knowledge\n\n- Prices in cents\n<!-- clarte:user-end -->",
        anchor: "## Key Files",
      },
    ];

    const result = mergeUserSections(newContent, sections);

    // Should appear between Key Files and Development
    const keyFilesIdx = result.indexOf("## Key Files");
    const userIdx = result.indexOf("<!-- clarte:user-start -->");
    const devIdx = result.indexOf("## Development");

    expect(keyFilesIdx).toBeGreaterThan(-1);
    expect(userIdx).toBeGreaterThan(keyFilesIdx);
    expect(devIdx).toBeGreaterThan(userIdx);
  });

  it("appends section at end when anchor not found", () => {
    const newContent = "## Tech Stack\n\nTypeScript\n";

    const sections = [
      {
        content: "<!-- clarte:user-start -->\nCustom note\n<!-- clarte:user-end -->",
        anchor: "## Nonexistent Section",
      },
    ];

    const result = mergeUserSections(newContent, sections);
    expect(result).toContain("Custom note");
    expect(result.indexOf("Custom note")).toBeGreaterThan(result.indexOf("TypeScript"));
  });

  it("appends section at end when no anchor", () => {
    const newContent = "## Tech Stack\n\nTypeScript\n";

    const sections = [
      {
        content: "<!-- clarte:user-start -->\nTop note\n<!-- clarte:user-end -->",
        anchor: null,
      },
    ];

    const result = mergeUserSections(newContent, sections);
    expect(result).toContain("Top note");
  });

  it("preserves multiple sections in order", () => {
    const newContent = [
      "## Tech Stack",
      "",
      "TypeScript",
      "",
      "## Key Files",
      "",
      "types.ts",
      "",
      "## Development",
      "",
      "npm run dev",
      "",
    ].join("\n");

    const sections = [
      {
        content: "<!-- clarte:user-start -->\nNote after Tech Stack\n<!-- clarte:user-end -->",
        anchor: "## Tech Stack",
      },
      {
        content: "<!-- clarte:user-start -->\nNote after Key Files\n<!-- clarte:user-end -->",
        anchor: "## Key Files",
      },
    ];

    const result = mergeUserSections(newContent, sections);

    const techIdx = result.indexOf("## Tech Stack");
    const note1Idx = result.indexOf("Note after Tech Stack");
    const keyIdx = result.indexOf("## Key Files");
    const note2Idx = result.indexOf("Note after Key Files");
    const devIdx = result.indexOf("## Development");

    expect(note1Idx).toBeGreaterThan(techIdx);
    expect(note1Idx).toBeLessThan(keyIdx);
    expect(note2Idx).toBeGreaterThan(keyIdx);
    expect(note2Idx).toBeLessThan(devIdx);
  });

  it("does not duplicate if section already present", () => {
    const content = "## Tech Stack\n\n<!-- clarte:user-start -->\nNote\n<!-- clarte:user-end -->\n";
    const sections = [
      {
        content: "<!-- clarte:user-start -->\nNote\n<!-- clarte:user-end -->",
        anchor: "## Tech Stack",
      },
    ];

    const result = mergeUserSections(content, sections);
    const occurrences = result.split("<!-- clarte:user-start -->").length - 1;
    expect(occurrences).toBe(1);
  });

  it("handles section after last header (no next header)", () => {
    const newContent = "## Development\n\nnpm run dev\n";

    const sections = [
      {
        content: "<!-- clarte:user-start -->\nExtra notes\n<!-- clarte:user-end -->",
        anchor: "## Development",
      },
    ];

    const result = mergeUserSections(newContent, sections);
    expect(result).toContain("Extra notes");
    expect(result.indexOf("Extra notes")).toBeGreaterThan(result.indexOf("npm run dev"));
  });
});
